import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme, keyHint, renderDiff } from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Container,
    Markdown,
    Spacer,
    Text,
    TruncatedText,
    truncateToWidth,
} from "@earendil-works/pi-tui";
import {
    COLLAPSED_OUTPUT_LINES,
    type DelegateReport,
    jobIdentity,
    jobLine,
    launchDetails,
    outputPreview,
    piDiff,
    reportText,
    reviveHint,
    SPINNER_INTERVAL_MS,
    formatDuration,
    statusText,
    totalElapsedMs,
    usageStats,
    widgetJobs,
} from "./format.ts";
import { priorActivity, runChild } from "./child.ts";
import { createJobStore, type DelegateJob, type InspectJob } from "./store.ts";
import {
    applyClone,
    cloneCwd,
    createIsolation,
    isolationSummary,
    removeClone,
    type IsolationState,
} from "./isolation.ts";
import { registerInspector } from "./inspector.ts";
import { configFor, contextWindowFor, discoverAgents, resolveModel, type AgentFile } from "./agents.ts";

type DelegateDetails = Pick<DelegateJob, "id" | "agent" | "description" | "task" | "model" | "tools"> & {
    background: boolean;
};

type SteerDetails = Pick<
    DelegateJob,
    "id" | "agent" | "description" | "toolCalls" | "contextTokens" | "contextWindow"
> & {
    message: string;
    elapsedMs: number;
};

const DELEGATION_TOOLS = new Set(["delegate", "delegate_apply", "delegate_list", "delegate_steer", "delegate_cancel"]);
const WIDGET_KEY = "delegate";
const RESULT_MESSAGE = "delegate-result";
const REMINDER_MESSAGE = "delegate-reminder";
const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "powershell", "web_search", "web_fetch"]);
const FIRST_REMINDER_AT = 5;
const DELEGATE_SESSION_DIR = join(getAgentDir(), "sessions", "delegates");
const INTERRUPTED_MESSAGE = "delegate-interrupted";

function argText(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function jobId(value: unknown): string {
    return argText(value)
        .trim()
        .replace(/^job\s+/i, "");
}
/** Strict models inject literal "null" for optional params they omit; drop it before reading any. */
function dropNulls<T extends Record<string, unknown>>(raw: T): T {
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null && value !== "null")) as T;
}

function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
    return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function resultFallback(body: string, theme: Theme, isError: boolean): Text {
    const mark = statusText(theme, isError ? "failed" : "done");
    return new Text(`\n${mark} ${theme.fg(isError ? "error" : "toolOutput", body || "(no output)")}`, 0, 0);
}

/** Shared foreground output preview: delegate results, steer revives, and follow-up reports. */
function appendOutput(container: Container, body: string, expanded: boolean, theme: Theme): void {
    const { shown, hidden } = outputPreview(body, expanded ? Infinity : COLLAPSED_OUTPUT_LINES);
    container.addChild(new Markdown(shown.join("\n"), 0, 0, getMarkdownTheme()));
    if (hidden > 0) container.addChild(new Text(moreLines(theme, hidden), 0, 0));
}

/** Shared collapsed-output note so all three preview sites phrase it identically. */
function moreLines(theme: Theme, hidden: number): string {
    return theme.fg("muted", `… ${hidden} more lines, `) + keyHint("app.tools.expand", "to expand");
}

/** One resolution path for launches and swaps; the error names the requested model. */
function mustResolveModel(request: string | undefined, ctx: ExtensionContext, fallback?: string) {
    const { model, thinking } = resolveModel(request ?? fallback, configFor(ctx.cwd).models ?? {}, ctx);
    if (!model) throw new Error(`No model found for "${request ?? fallback}".`);
    return { model, thinking };
}

/** Isolated jobs append the clone location and a change stat so the orchestrator can apply the work. */
function withIsolation(output: string, isolation: IsolationState | undefined): string {
    return isolation ? [output, isolationSummary(isolation)].filter(Boolean).join("\n\n") : output;
}

/** Shared tool layout: an optional identity header, then a width-aware payload preview. */
function toolLayout(toolName: string, identity: string, payload: string, theme: Theme, expanded: boolean): Component {
    const container = new Container();
    if (toolName)
        container.addChild(
            new TruncatedText(`${theme.fg("toolTitle", theme.bold(toolName))}${identity ? ` ${identity}` : ""}`),
        );
    if (!payload.trim()) return container;
    const body = new Text(
        payload
            .split("\n")
            .map((line) => theme.fg("toolOutput", line))
            .join("\n"),
        0,
        0,
    );
    if (toolName) container.addChild(new Spacer(1));
    container.addChild({
        render: (width) => {
            // Wrapping turns one long line into many, so the cap counts rendered rows, not source lines.
            const lines = body.render(width);
            if (expanded || lines.length <= COLLAPSED_OUTPUT_LINES) return lines;
            return [
                ...lines.slice(0, COLLAPSED_OUTPUT_LINES),
                truncateToWidth(moreLines(theme, lines.length - COLLAPSED_OUTPUT_LINES), width),
            ];
        },
        invalidate: () => body.invalidate(),
    });
    return container;
}

/** Shared launch-result card: delegate launches and steer revives render identically. */
function launchResult(
    details: DelegateDetails,
    body: string,
    status: string,
    expanded: boolean,
    theme: Theme,
): Component {
    const container = new Container();
    // The mark is the call's outcome (launch succeeded); job progress stays in the widget and report.
    container.addChild(
        new Text(`\n${statusText(theme, "done")} ${jobIdentity(theme, details)} ${theme.fg("muted", status)}`, 0, 0),
    );
    // The call body already carries the task; only the launch metadata is new here.
    if (expanded)
        container.addChild(
            new Text(theme.fg("muted", launchDetails({ model: details.model, tools: details.tools }).join("\n")), 0, 0),
        );
    // Background results arrive as their own message; headless runs still show the output here.
    if (!details.background && body) appendOutput(container, body, expanded, theme);
    return container;
}

export default function (pi: ExtensionAPI) {
    const store = createJobStore(pi.appendEntry);
    let ticker: ReturnType<typeof setInterval> | undefined;
    // Prompts are read once; drift happens one quick search at a time, so count it and nudge at 5, 10, 20, ...
    let directCalls = 0;
    let nextReminder = FIRST_REMINDER_AT;

    const jobSnapshot = (job: InspectJob) => ({
        id: job.id,
        agent: job.agent,
        description: job.description,
        contextTokens: job.contextTokens,
        contextWindow: job.contextWindow,
        startedAt: job.startedAt,
        status: job.status,
        endedAt: job.endedAt,
    });

    const jobTarget = (rawId: unknown, theme: Theme): string => {
        const id = jobId(rawId);
        const job = store.find(id);
        return job ? jobIdentity(theme, job) : theme.fg("muted", id || "…");
    };

    const refreshWidget = (ctx: ExtensionContext) => {
        if (!ctx.hasUI) return;
        store.notify();
        const jobs = store.live();
        if (jobs.length === 0) {
            ctx.ui.setWidget(WIDGET_KEY, undefined);
            return;
        }
        const theme = ctx.ui.theme;
        const now = Date.now();
        const { shown, hidden, detail } = widgetJobs(jobs);
        const lines: string[] = [];
        const all = store.all();
        const counts = `${jobs.length} running · ${all.length} total · ${formatDuration(totalElapsedMs(all, now))}`;
        lines.push(`${statusText(theme, "running", now)} ${theme.fg("muted", counts)}`);
        for (const job of shown) {
            lines.push(
                `${statusText(theme, "running", now)} ${jobIdentity(theme, job)} ${theme.fg("muted", jobLine(job, now - job.startedAt))}`,
            );
            if (!detail) continue;
            if (job.lastTool)
                lines.push(
                    `   ${theme.fg("toolTitle", theme.bold(job.lastTool))}${job.lastDetail ? ` ${theme.fg("accent", job.lastDetail)}` : ""}`,
                );
            if (job.lastResult) lines.push(`   ${theme.fg("muted", "↳")} ${theme.fg("toolOutput", job.lastResult)}`);
        }
        if (hidden) lines.push(`   ${theme.fg("muted", `… ${hidden} more running`)}`);
        ctx.ui.setWidget(WIDGET_KEY, lines);
    };

    // The ticker animates spinners exactly while live jobs exist.
    const syncTicker = (ctx: ExtensionContext) => {
        if (store.live().length > 0) ticker ??= setInterval(() => refreshWidget(ctx), SPINNER_INTERVAL_MS);
        else if (ticker) {
            clearInterval(ticker);
            ticker = undefined;
        }
    };

    const finishJob = (ctx: ExtensionContext, job: DelegateJob, output?: string, error?: string) => {
        if (!store.finish(job, error ? "failed" : "done", error ? `Error: ${error}` : undefined)) return;
        syncTicker(ctx);
        refreshWidget(ctx);
        const report: DelegateReport = {
            id: job.id,
            agent: job.agent,
            description: job.description,
            model: job.model,
            toolCalls: job.toolCalls,
            contextTokens: job.contextTokens,
            contextWindow: job.contextWindow,
            elapsedMs: Date.now() - job.startedAt,
            output: withIsolation(output ?? "", job.isolation),
            error,
        };
        // Idle: this starts a new turn. Streaming: steer the report in at the next turn boundary;
        // a follow-up waits for a run end that a parent stuck polling may never reach.
        pi.sendMessage(
            { customType: RESULT_MESSAGE, content: reportText(report), display: true, details: report },
            { triggerTurn: true, deliverAs: "steer" },
        );
    };

    /** Runs one delegate child: foreground runs return their output, background ones report on completion. */
    const runDelegate = async (
        ctx: ExtensionContext,
        agent: AgentFile,
        prior: InspectJob | undefined,
        fields: { description: string; model?: string; isolated?: boolean },
        task: string,
        signal: AbortSignal | undefined,
        prompt = task,
    ) => {
        const { model, thinking } = mustResolveModel(fields.model, ctx, agent.model);
        const tools = (agent.tools?.length ? agent.tools : pi.getActiveTools()).filter(
            (tool) => !DELEGATION_TOOLS.has(tool),
        );
        const displayModel = thinking ? `${model}:${thinking}` : model;
        const id = prior?.id ?? randomUUID().slice(0, 8);
        const isolation = fields.isolated ? (prior?.isolation ?? createIsolation(ctx.cwd, id)) : undefined;

        const job: DelegateJob = {
            // A revived job keeps its id: the pinned child session id reopens the old transcript.
            id,
            agent: agent.name,
            description: fields.description.trim(),
            task,
            model: displayModel,
            status: "running",
            activity: prior ? priorActivity(DELEGATE_SESSION_DIR, prior.id) : [],
            tools,
            toolCalls: 0,
            startedAt: Date.now(),
            contextWindow: contextWindowFor(ctx, model),
            isolation,
            controller: new AbortController(),
        };
        const details: DelegateDetails = {
            id: job.id,
            agent: job.agent,
            description: job.description,
            task: job.task,
            model: displayModel,
            tools,
            background: ctx.hasUI,
        };
        const args = [
            "--session-id",
            `delegate-${job.id}`,
            "--session-dir",
            DELEGATE_SESSION_DIR,
            "--model",
            model,
            "--tools",
            tools.join(","),
        ];
        if (thinking) args.push("--thinking", thinking);
        if (agent.prompt) args.push("--append-system-prompt", agent.prompt);
        const entrypoint = process.argv[1];
        if (!entrypoint) throw new Error("Pi CLI entrypoint missing; start Pi from its CLI to delegate.");
        const child = spawn(process.execPath, [entrypoint, "--mode", "rpc", ...args], {
            cwd: isolation ? cloneCwd(isolation, ctx.cwd) : ctx.cwd,
            shell: false,
            stdio: "pipe",
        });
        store.launch(job, details.background);
        const isolatedPrompt = isolation
            ? `You are working in an isolated git clone at ${isolation.clone}; the main working tree is untouched. Commit freely here; the orchestrator applies your changes to the main tree.`
            : "";
        const run = runChild(
            child,
            isolatedPrompt ? `${isolatedPrompt}\n\n${prompt}` : prompt,
            details.background ? job.controller.signal : signal,
            (update) => store.record(job, update),
            Boolean(prior),
        );
        job.steer = run.steer;
        job.swapModel = run.swapModel;
        if (!details.background) {
            try {
                const output = await run.done;
                store.finish(job, "done");
                return {
                    content: [{ type: "text" as const, text: withIsolation(output, job.isolation) }],
                    details,
                };
            } catch (error) {
                // Record the outcome so the launch entry cannot linger as "running".
                const cancelled = error instanceof Error && error.message === "Delegate was aborted";
                store.finish(job, cancelled ? "cancelled" : "failed");
                // Failed jobs are revivable; mirror the failed background report's hint on the thrown error.
                if (!cancelled && error instanceof Error) error.message += `\n${reviveHint(job.id)}`;
                throw error;
            }
        }

        syncTicker(ctx);
        refreshWidget(ctx);
        void run.done
            .then(
                (output) => finishJob(ctx, job, output),
                (error) => finishJob(ctx, job, undefined, error instanceof Error ? error.message : String(error)),
            )
            .catch(() => {});
        return {
            content: [
                {
                    type: "text" as const,
                    text: `${prior ? "Revived" : "Started"} delegate "${job.agent}" in the background (job ${job.id}). Do not call tools solely to wait, even no-op bash commands; when its report is your next dependency, end your turn and it will arrive automatically unless cancelled.`,
                },
            ],
            details,
        };
    };

    /** Swaps a running child's model over the RPC; the child confirms or rejects it, and never restarts. */
    const swapModel = async (job: DelegateJob, request: string, ctx: ExtensionContext) => {
        if (!job.swapModel) throw new Error(`Delegate job "${job.id}" cannot switch models.`);
        const { model } = mustResolveModel(request, ctx);
        const [provider, ...rest] = model.split("/");
        if (!rest.length) throw new Error(`Model "${model}" has no provider prefix.`);
        // Only an explicit :thinking suffix changes the level; an inherited one must not silently reset it.
        const level = /:(off|minimal|low|medium|high|xhigh|max)$/.exec(request)?.[1];
        // The display lands on the set_model ack, so a thinking-level failure cannot leave it stale.
        await job.swapModel(provider, rest.join("/"), level, () => {
            job.model = model;
            job.contextWindow = contextWindowFor(ctx, model);
        });
        if (level) job.model = `${model}:${level}`;
    };

    pi.on("session_shutdown", () => {
        if (ticker) clearInterval(ticker);
        for (const job of store.live()) job.controller.abort();
        store.clear();
    });

    // Rebuilt from the active branch, like pi's todo example; abandoned branches are alternative histories.
    const restoreSession = (ctx: ExtensionContext) => {
        const interrupted = store.restore(ctx.sessionManager.getBranch());
        // Custom entries never reach the model, so announce the interrupted jobs as a steered message.
        if (interrupted.length)
            pi.sendMessage(
                {
                    customType: INTERRUPTED_MESSAGE,
                    content: `<system-reminder>These delegate jobs were interrupted by a restart or crash; their transcripts survive. Continue each with delegate_steer (job id plus your guidance):\n${interrupted.map((job) => `- ${job.id} ${job.agent}: ${job.description}`).join("\n")}</system-reminder>`,
                    display: false,
                },
                { deliverAs: "steer" },
            );
    };

    pi.on("session_start", (_event, ctx) => restoreSession(ctx));
    pi.on("session_tree", (_event, ctx) => restoreSession(ctx));

    pi.on("before_agent_start", () => {
        directCalls = 0;
        nextReminder = FIRST_REMINDER_AT;
    });

    pi.on("tool_result", (event) => {
        // Children run without the delegation tools, so only the orchestrating session is nudged.
        if (!pi.getActiveTools().includes("delegate")) return;
        if (event.toolName === "delegate") {
            directCalls = 0;
            nextReminder = FIRST_REMINDER_AT;
            return;
        }
        // Calls a script or another tool issued are not the model's own steps.
        if (event.parentToolCallId || !EXPLORATION_TOOLS.has(event.toolName) || ++directCalls < nextReminder) return;
        nextReminder *= 2;
        // Steering lands after the current tool batch, so it never cuts parallel calls short.
        pi.sendMessage(
            {
                customType: REMINDER_MESSAGE,
                content: `<system-reminder>You have made ${directCalls} direct exploration calls since your last delegation. If what remains is exploration, research, or a build/test/debug loop, delegate it now, in parallel for independent scopes.</system-reminder>`,
                display: false,
            },
            { deliverAs: "steer" },
        );
    });

    pi.registerMessageRenderer(RESULT_MESSAGE, (message, { expanded }, theme) => {
        const report = message.details as DelegateReport | undefined;
        if (!report?.agent) return undefined;
        const icon = statusText(theme, report.error ? "failed" : "done");
        const container = new Container();
        container.addChild(
            new Text(
                `${icon} ${jobIdentity(theme, report)} ${theme.fg("muted", report.description)} ${theme.fg("muted", usageStats(report, report.elapsedMs))}`,
                0,
                0,
            ),
        );
        if (report.error) container.addChild(new Text(theme.fg("error", report.error), 0, 0));
        else if (report.output) appendOutput(container, report.output, expanded, theme);
        return container;
    });

    registerInspector(pi, store);

    const cwd = process.cwd();
    const agentList = discoverAgents(cwd, configFor(cwd).agentDirs).map((agent) => {
        const qualifiers = [agent.model, agent.isolated ? "isolated" : undefined].filter(Boolean).join(", ");
        return `- ${agent.name}${qualifiers ? ` (${qualifiers})` : ""}: ${agent.description}`;
    });

    pi.registerTool({
        name: "delegate",
        label: "Delegate",
        description: [
            "Start a delegate: a background run of one of the agents below on one focused task. Returns a job id immediately; the report arrives later as a follow-up message.",
            "",
            "Available agents:",
            ...agentList,
            "",
            "A delegate gets the project instructions but not this conversation: it cannot see the user's request, the files you read, or your decisions. Write `task` as a self-contained brief: the goal and why, what you already know (paths, symbols, errors), scope and constraints, whether to edit files or only report, and what to return (format, length, path:line evidence).",
            "",
            "With isolated: true, the delegate runs in an isolated git clone at .pi/worktrees/<job id> (gitignore that path), starting from the main tree exactly as it is now, uncommitted and untracked files included. It never touches the main tree and may commit freely; delegate_apply brings its changes back.",
            "",
            "To follow up on or redirect an existing job, see delegate_steer.",
        ].join("\n"),
        promptSnippet:
            "Delegate a focused task to a background agent with its own context; only its report comes back, as a later follow-up message",
        promptGuidelines: [
            "You are the orchestrator, and delegating is your default: plan, split the work, brief delegates, and integrate their reports. Delegate on your own initiative. Your context is the scarce resource: everything you read stays in it, is re-sent with every later request, and brings compaction closer. A delegate works in a fresh context, often on a cheaper model, and returns only its report.",
            "Delegate exploration, research, implementation beyond a small edit, build/test/debug loops, and reviews. Work directly only for reading one known file or the lines you are about to edit, one targeted search, a small edit (about 30 lines in one file), a quick verification (one test run or one cited line), or a command the user asked you to run. Shell one-liners and scripts that search or read code count as exploration, not quick commands.",
            "Your failure mode is drifting into doing the work yourself, one quick search at a time. Decide what to delegate before your first exploratory call; if one targeted search does not settle it, delegate the rest.",
            "Start every independent delegate before waiting on any, ideally in one message. Trust reports instead of repeating their searches; check only what you act on. If a report falls short, delegate a follow-up that names the gap instead of redoing the work yourself.",
            "While delegates run, stay outside their scopes. When a report is the next dependency, end your turn with a brief waiting status. Completion will wake you.",
            "Read every required delegate report before claiming the task is done. Never sleep, poll, or call any tool solely to wait (including `bash` with `true`, `echo`, or `sleep 0`). Use delegate_list only for a one-time status check.",
        ],
        parameters: Type.Object({
            agent: Type.String({ description: "Agent name from the list in this tool's description." }),
            description: Type.String({
                description: "Short 3-8 word summary of this delegation, shown in the transcript.",
            }),
            task: Type.String({ description: "Self-contained brief; the delegate cannot see this conversation." }),
            model: Type.Optional(
                Type.String({
                    description:
                        "Model tier (cheap, balanced, strong) or an explicit provider/model, with an optional :<thinking> suffix.",
                }),
            ),
            isolated: Type.Optional(
                Type.Boolean({ description: "Run in an isolated git clone; apply results with delegate_apply." }),
            ),
        }),
        async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
            const params = dropNulls(rawParams);
            const { agent: agentName, description, task, model, isolated } = params;
            if (!agentName || !description || !task) throw new Error("agent, description and task are required.");
            const agents = discoverAgents(ctx.cwd, configFor(ctx.cwd).agentDirs);
            const agent = agents.find((candidate) => candidate.name === agentName);
            if (!agent) {
                const names = agents.map((candidate) => candidate.name).join(", ") || "(none)";
                throw new Error(`Unknown agent "${agentName}". Available agents: ${names}.`);
            }
            const effective = isolated ?? agent.isolated;
            return runDelegate(ctx, agent, undefined, { description, model, isolated: effective }, task, signal);
        },

        renderCall(args, theme, context) {
            const agent = argText(args?.agent).trim();
            const description = argText(args?.description).trim();
            const identity = [
                agent ? theme.fg("toolTitle", theme.bold(agent)) : "",
                description ? theme.fg("accent", description) : "",
            ]
                .filter(Boolean)
                .join(" ");
            return toolLayout(
                "delegate",
                identity || theme.fg("muted", "…"),
                argText(args?.task),
                theme,
                context.expanded,
            );
        },

        renderResult(result, { expanded }, theme, context) {
            const details = result.details as DelegateDetails | undefined;
            const body = resultText(result);
            if (context.isError || !details?.agent) return resultFallback(body, theme, context.isError);
            return launchResult(
                details,
                body,
                details.background ? "started in background" : "completed",
                expanded,
                theme,
            );
        },
    });

    pi.registerTool({
        name: "delegate_steer",
        label: "Steer delegate",
        description:
            "Send a message to a delegate job. A running job reads it before its next model request. A finished job, whatever its status, continues its own transcript (its brief, its work, prior steers) with the message as its next instruction and reports again, so send only what is new. Continue a job for follow-up on the same work. For a new task, or a job past half its context window (shown in its report), start a fresh delegate with a condensed brief of what the old job found.",
        promptSnippet: "Send guidance to a delegate by job id, or continue a finished one",
        parameters: Type.Object({
            id: Type.String({
                description: 'Job id from a delegate tool result or a delegate-result message, such as "38631a01".',
            }),
            message: Type.String({
                description: "Guidance for a running job, or the next instruction for a finished one.",
            }),
            model: Type.Optional(
                Type.String({
                    description:
                        "Model tier (cheap, balanced, strong) or an explicit provider/model, with an optional :<thinking> suffix. A running job switches live.",
                }),
            ),
        }),
        async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
            const params = dropNulls(rawParams);
            const id = jobId(params.id);
            const running = store.live().find((candidate) => candidate.id === id);
            if (running) {
                // A live job without steer would fall into the revive path and double-spawn its pinned session.
                if (!running.steer) throw new Error(`No steerable delegate job "${id}".`);
                try {
                    if (params.model) await swapModel(running, params.model, ctx);
                    await running.steer(params.message);
                } catch (error) {
                    // The swap or steer await can outlast the job (a model ack waits up to 30s); raw child errors are cryptic.
                    if (!store.live().some((candidate) => candidate.id === id))
                        throw new Error(
                            `Delegate job "${id}" just finished; call delegate_steer again to continue it.`,
                        );
                    throw error;
                }
                const details: SteerDetails = {
                    id: running.id,
                    agent: running.agent,
                    description: running.description,
                    message: params.message,
                    toolCalls: running.toolCalls,
                    contextTokens: running.contextTokens,
                    contextWindow: running.contextWindow,
                    elapsedMs: Date.now() - running.startedAt,
                };
                return {
                    content: [
                        {
                            type: "text",
                            text: `Steering message delivered to delegate "${running.agent}" (job ${running.id}).`,
                        },
                    ],
                    details,
                };
            }
            const prior = store.find(id);
            if (!id || !prior) throw new Error(`Unknown delegate job "${id}".`);
            // An applied or discarded clone cannot be continued; a revive would run in the main tree.
            if (prior.cloneClosed)
                throw new Error(
                    `The isolated clone of delegate job "${id}" was already applied or discarded; delegate_steer cannot continue it. Start a fresh delegate with a condensed brief instead.`,
                );
            const agents = discoverAgents(ctx.cwd, configFor(ctx.cwd).agentDirs);
            const agent = agents.find((candidate) => candidate.name === prior.agent);
            if (!agent) {
                const names = agents.map((candidate) => candidate.name).join(", ") || "(none)";
                throw new Error(`Unknown agent "${prior.agent}". Available agents: ${names}.`);
            }
            return runDelegate(
                ctx,
                agent,
                prior,
                {
                    description: prior.description,
                    model: params.model ?? prior.model,
                    isolated: Boolean(prior.isolation),
                },
                prior.task,
                signal,
                params.message,
            );
        },

        renderCall(args, theme, context) {
            return toolLayout(
                "delegate_steer",
                jobTarget(args?.id, theme),
                argText(args?.message),
                theme,
                context.expanded,
            );
        },

        renderResult(result, { expanded }, theme, context) {
            const details = result.details as SteerDetails | DelegateDetails | undefined;
            const body = resultText(result);
            if (context.isError || !details?.agent) return resultFallback(body, theme, context.isError);
            if ("message" in details)
                return new Text(
                    `\n${statusText(theme, "done")} ${jobIdentity(theme, details)} ${theme.fg("muted", details.description)} ${theme.fg("muted", usageStats(details, details.elapsedMs))}`,
                    0,
                    0,
                );
            return launchResult(
                details,
                body,
                details.background ? "revived in background" : "revived",
                expanded,
                theme,
            );
        },
    });

    pi.registerTool({
        name: "delegate_cancel",
        label: "Cancel delegate",
        description: "Cancel a running delegate by job id. It sends no report; delegate_steer can continue it later.",
        promptSnippet: "Cancel a running background delegate by job id",
        parameters: Type.Object({
            id: Type.String({ description: "Job id from delegate or delegate_list." }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const id = jobId(params.id);
            const job = store.live().find((candidate) => candidate.id === id);
            if (!job) throw new Error(`No running delegate job "${id}".`);
            store.finish(job, "cancelled");
            job.controller.abort();
            syncTicker(ctx);
            refreshWidget(ctx);
            return {
                content: [
                    { type: "text", text: `Cancellation requested for delegate "${job.agent}" (job ${job.id}).` },
                ],
                details: { id: job.id, agent: job.agent },
            };
        },

        renderCall(args, theme, context) {
            return toolLayout("delegate_cancel", jobTarget(args?.id, theme), "", theme, context.expanded);
        },

        renderResult(result, _options, theme, context) {
            const details = result.details as { id: string; agent: string } | undefined;
            const body = resultText(result);
            if (context.isError || !details?.agent) return resultFallback(body, theme, context.isError);
            return new Text(
                // The mark is the call's outcome (cancellation requested), not the job's cancelled status.
                `\n${statusText(theme, "done")} ${jobIdentity(theme, details)} ${theme.fg("muted", "cancellation requested")}`,
                0,
                0,
            );
        },
    });

    pi.registerTool({
        name: "delegate_apply",
        label: "Apply delegate",
        description:
            "Apply an isolated delegate's changes to the main working tree by job id. The delegate's commits and uncommitted changes are 3-way merged onto a fresh snapshot of the main tree, so nearby but non-overlapping edits apply cleanly; only a true conflict fails. On conflict the clone is kept and the error explains the recovery. The job must be finished, not running.",
        promptSnippet: "Apply an isolated delegate's clone to the main tree, or discard it, by job id",
        parameters: Type.Object({
            id: Type.String({ description: "Job id of a finished isolated delegate." }),
            discard: Type.Optional(
                Type.Boolean({ description: "Remove the delegate's clone without applying its changes." }),
            ),
        }),
        async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
            const params = dropNulls(rawParams);
            const id = jobId(params.id);
            const job = store.find(id);
            if (!id || !job) throw new Error(`Unknown delegate job "${id}".`);
            if (job.status === "running")
                throw new Error(`Delegate job "${id}" is still running; steer it or cancel it first.`);
            if (!job.isolation)
                throw new Error(`Delegate job "${id}" is not isolated; its changes are already in the main tree.`);
            if (params.discard === true) {
                removeClone(job.isolation);
                job.isolation = undefined;
                job.cloneClosed = true;
                store.save(job);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Discarded the isolated clone of delegate "${job.agent}" (job ${job.id}); nothing was applied.`,
                        },
                    ],
                    details: { id: job.id, agent: job.agent, discarded: true },
                };
            }
            const result = applyClone(job.isolation);
            if (result.kind === "conflict") {
                // Base rule: base tracks the newest snapshot, so the next apply works whether or not the delegate rebased yet.
                job.isolation = { ...job.isolation, base: result.snapshot };
                store.save(job);
                throw new Error(
                    `Main tree changed under delegate job "${job.id}"; conflicting files: ${result.files.join(", ") || "(unknown)"}. The clone at ${job.isolation.clone} was kept. Steer job ${job.id} with: "Main tree changed under you. In your clone run \`git rebase main-snapshot\` (or merge), resolve conflicts, commit." Then call delegate_apply again.`,
                );
            }
            const stat = result.kind === "applied" ? `\n${result.stat}` : "";
            removeClone(job.isolation);
            job.isolation = undefined;
            job.cloneClosed = true;
            store.save(job);
            return {
                content: [
                    {
                        type: "text",
                        text:
                            result.kind === "empty"
                                ? `Delegate "${job.agent}" (job ${job.id}) made no changes; its clone was removed.`
                                : `Applied the changes of delegate "${job.agent}" (job ${job.id}) to the main tree:${stat}\n(clone removed)`,
                    },
                ],
                details: { id: job.id, agent: job.agent, diff: result.kind === "applied" ? result.diff : undefined },
            };
        },

        renderCall(args, theme, context) {
            return toolLayout(
                "delegate_apply",
                jobTarget(args?.id, theme),
                argText(args?.discard) === "true" ? "discard" : "",
                theme,
                context.expanded,
            );
        },

        renderResult(result, { expanded }, theme, context) {
            const details = result.details as
                { id: string; agent: string; discarded?: boolean; diff?: string } | undefined;
            const body = resultText(result);
            if (context.isError || !details?.agent) return resultFallback(body, theme, context.isError);
            const status = details.discarded ? "clone discarded" : "changes applied";
            const header = `\n${statusText(theme, "done")} ${jobIdentity(theme, details)} ${theme.fg("muted", status)}`;
            const diff = details.diff?.trim() ? renderDiff(piDiff(details.diff)) : "";
            if (!diff) return new Text(header, 0, 0);
            const lines = diff.split("\n");
            // Collapsed shows the head like the other delegate previews; expanded shows the full colored diff.
            const shown =
                expanded || lines.length <= COLLAPSED_OUTPUT_LINES
                    ? lines
                    : [
                          ...lines.slice(0, COLLAPSED_OUTPUT_LINES),
                          moreLines(theme, lines.length - COLLAPSED_OUTPUT_LINES),
                      ];
            const container = new Container();
            container.addChild(new Text(header, 0, 0));
            container.addChild(new Spacer(1));
            container.addChild(new Text(shown.join("\n"), 0, 0));
            return container;
        },
    });

    pi.registerTool({
        name: "delegate_list",
        label: "List delegates",
        description: "List delegate jobs with their ids, status, context usage, and elapsed time.",
        promptSnippet: "List delegates and their job ids",
        parameters: Type.Object({}),
        async execute() {
            const now = Date.now();
            const jobs = store.all();
            if (!jobs.length) return { content: [{ type: "text", text: "No delegates yet." }], details: undefined };
            const running = jobs.filter((job) => job.status === "running").length;
            const lastActivity = (job: InspectJob) => {
                const { lastTool, lastDetail } = job as DelegateJob;
                return job.status === "running" && lastTool
                    ? ` · ${lastTool}${lastDetail ? ` ${lastDetail}` : ""}`
                    : "";
            };
            const lines = jobs.map(
                (job) =>
                    `- ${job.id} ${job.agent} · ${job.status} · ${jobLine(job, (job.endedAt ?? now) - job.startedAt)}${lastActivity(job)}`,
            );
            return {
                content: [
                    { type: "text", text: `${jobs.length} delegates (${running} running):\n${lines.join("\n")}` },
                ],
                details: { jobs: jobs.map(jobSnapshot) },
            };
        },
        renderResult(result, _options, theme, context) {
            const jobs = (result.details as { jobs?: ReturnType<typeof jobSnapshot>[] } | undefined)?.jobs;
            if (!jobs?.length || context.isError) return resultFallback(resultText(result), theme, context.isError);
            const now = Date.now();
            return new Text(
                `\n${statusText(theme, "done")} ${theme.fg("muted", `${jobs.length} delegates`)}\n${jobs
                    .map(
                        (job) =>
                            `${statusText(theme, job.status, now)} ${jobIdentity(theme, job)} ${theme.fg("muted", jobLine(job, (job.endedAt ?? now) - job.startedAt))}`,
                    )
                    .join("\n")}`,
                0,
                0,
            );
        },
    });
}

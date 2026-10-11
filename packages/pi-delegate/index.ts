import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Container,
    Markdown,
    Spacer,
    Text,
    TruncatedText,
    truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
    COLLAPSED_OUTPUT_LINES,
    type DelegateReport,
    jobIdentity,
    jobLine,
    launchDetails,
    outputPreview,
    reportText,
    resumeHint,
    SPINNER_INTERVAL_MS,
    formatDuration,
    statusText,
    totalElapsedMs,
    usageStats,
    widgetJobs,
} from "./format.ts";
import { runChild } from "./child.ts";
import { createJobStore, resumeDecision, type DelegateJob } from "./store.ts";
import { registerInspector } from "./inspector.ts";
import { configFor, contextWindowFor, discoverAgents, resolveModel } from "./agents.ts";

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

const DELEGATION_TOOLS = new Set(["delegate", "delegate_list", "delegate_steer", "delegate_cancel"]);
const WIDGET_KEY = "delegate";
const RESULT_MESSAGE = "delegate-result";
const REMINDER_MESSAGE = "delegate-reminder";
const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "powershell", "web_search", "web_fetch"]);
const FIRST_REMINDER_AT = 5;
const DELEGATE_SESSION_DIR = join(getAgentDir(), "sessions", "delegates");
const RESUME_PROMPT = "Continue the task above from where you left off.";
const INTERRUPTED_MESSAGE = "delegate-interrupted";

function argText(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function jobId(value: unknown): string {
    return argText(value)
        .trim()
        .replace(/^job\s+/i, "");
}

function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
    return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function resultFallback(body: string, theme: Theme, isError: boolean): Text {
    return new Text(`\n${theme.fg(isError ? "error" : "toolOutput", body || "(no output)")}`, 0, 0);
}

/** Shared collapsed-output note so all three preview sites phrase it identically. */
function moreLines(theme: Theme, hidden: number): string {
    return theme.fg("muted", `… ${hidden} more lines, `) + keyHint("app.tools.expand", "to expand");
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

export default function (pi: ExtensionAPI) {
    const store = createJobStore(pi.appendEntry);
    let ticker: ReturnType<typeof setInterval> | undefined;
    // Prompts are read once; drift happens one quick search at a time, so count it and nudge at 5, 10, 20, ...
    let directCalls = 0;
    let nextReminder = FIRST_REMINDER_AT;

    const jobSnapshot = (job: DelegateJob) => ({
        id: job.id,
        agent: job.agent,
        description: job.description,
        contextTokens: job.contextTokens,
        contextWindow: job.contextWindow,
        startedAt: job.startedAt,
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
            output,
            error,
        };
        // Idle: this starts a new turn. Streaming: steer the report in at the next turn boundary;
        // a follow-up waits for a run end that a parent stuck polling may never reach.
        pi.sendMessage(
            { customType: RESULT_MESSAGE, content: reportText(report), display: true, details: report },
            { triggerTurn: true, deliverAs: "steer" },
        );
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
                    content: `<system-reminder>These delegate jobs were interrupted by a restart or crash; their transcripts survive. Resume each with the delegate tool's resume parameter (job id only):\n${interrupted.map((job) => `- ${job.id} ${job.agent}: ${job.description}`).join("\n")}</system-reminder>`,
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
                content: `<system-reminder>You have made ${directCalls} direct exploration calls since your last delegation. If what remains is exploration, research, or a build/test/debug loop, delegate it now, in parallel for independent scopes, instead of continuing yourself.</system-reminder>`,
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
        else if (report.output) {
            const { shown, hidden } = outputPreview(report.output, expanded ? Infinity : COLLAPSED_OUTPUT_LINES);
            container.addChild(new Markdown(shown.join("\n"), 0, 0, getMarkdownTheme()));
            if (hidden > 0) container.addChild(new Text(moreLines(theme, hidden), 0, 0));
        }
        return container;
    });

    registerInspector(pi, store);

    const cwd = process.cwd();
    const agentList = discoverAgents(cwd, configFor(cwd).agentDirs).map(
        (agent) => `- ${agent.name}${agent.model ? ` (${agent.model})` : ""}: ${agent.description}`,
    );

    pi.registerTool({
        name: "delegate",
        label: "Delegate",
        description: [
            "Start a delegate: a background run of one of the agents below on one focused task. Returns a job id immediately; the report arrives later as a follow-up message.",
            "",
            "Available agents (default model in parentheses):",
            ...agentList,
            "",
            "A delegate gets the project instructions but not this conversation: it cannot see the user's request, the files you read, or your decisions. Write `task` as a self-contained brief: the goal and why, what you already know (paths, symbols, errors), scope and constraints, whether to edit files or only report, and what to return (format, length, path:line evidence).",
            "",
            "An interrupted, failed, or cancelled job can be continued by passing its job id as `resume`. The agent, task, and description come from the original job, and the model may be overridden. Done jobs need no resume: their reports are already in this session.",
        ].join("\n"),
        promptSnippet:
            "Delegate a focused task to a background agent with its own context; only its report comes back, as a later follow-up message",
        promptGuidelines: [
            "You are the orchestrator, and delegating is your default: plan, split the work, brief delegates, and integrate their reports. Delegation is authorized; do not wait for the user to ask. Your context is the scarce resource: everything you read stays in it, is re-sent with every later request, and brings compaction closer. A delegate works in a fresh context, often on a cheaper model, and returns only its report.",
            "Delegate exploration, research, implementation beyond a small edit, build/test/debug loops, and reviews. Work directly only for reading one known file or the lines you are about to edit, one targeted search, a small edit (about 30 lines in one file), a quick verification (one test run or one cited line), or a command the user asked you to run. Shell one-liners and scripts that search or read code count as exploration, not quick commands.",
            "Your failure mode is drifting into doing the work yourself, one quick search at a time. Decide what to delegate before your first exploratory call; if one targeted search does not settle it, delegate the rest.",
            "Start every independent delegate before waiting on any, ideally in one message. Trust reports instead of repeating their searches; check only what you act on. If a report falls short, delegate a follow-up that names the gap instead of redoing the work yourself.",
            "While delegates run, stay outside their scopes. When a report is the next dependency, end your turn with a brief waiting status. Completion will wake you.",
            "Read every required delegate report before claiming the task is done. Never sleep, poll, or call any tool solely to wait (including `bash` with `true`, `echo`, or `sleep 0`). Use delegate_list only for a one-time status check.",
        ],
        parameters: Type.Object({
            agent: Type.Optional(Type.String({ description: "Agent name from the list in this tool's description." })),
            description: Type.Optional(
                Type.String({ description: "Short 3-8 word summary of this delegation, shown in the transcript." }),
            ),
            task: Type.Optional(
                Type.String({ description: "Self-contained brief; the delegate cannot see this conversation." }),
            ),
            model: Type.Optional(
                Type.String({ description: "Model tier (cheap, balanced, strong) or an explicit provider/model." }),
            ),
            resume: Type.Optional(
                Type.String({
                    description:
                        "Job id of an interrupted, failed, or cancelled delegate to continue; it reuses the original agent, description and task (model may be overridden).",
                }),
            ),
        }),
        async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
            // Strict models inject literal "null" for optional params they omit; drop it before reading any.
            const params = Object.fromEntries(
                Object.entries(rawParams).filter(([, value]) => value !== null && value !== "null"),
            ) as typeof rawParams;
            const config = configFor(ctx.cwd);
            const agents = discoverAgents(ctx.cwd, config.agentDirs);
            const resuming = params.resume
                ? resumeDecision(jobId(params.resume), store.all(), new Set(store.live().map((job) => job.id)))
                : undefined;
            if (resuming?.error) throw new Error(resuming.error);
            const prior = resuming?.job;
            if (!prior && (!params.agent || !params.description || !params.task))
                throw new Error(
                    "agent, description and task are required unless resuming an interrupted, failed, or cancelled job.",
                );
            const agent = agents.find((candidate) => candidate.name === (prior?.agent ?? params.agent));
            if (!agent) {
                const names = agents.map((candidate) => candidate.name).join(", ") || "(none)";
                throw new Error(`Unknown agent "${prior?.agent ?? params.agent}". Available agents: ${names}.`);
            }
            const { model, thinking: tierThinking } = resolveModel(
                params.model ?? agent.model,
                config.models ?? {},
                ctx.model,
            );
            if (!model) throw new Error(`No model found for "${agent.name}".`);
            const tools = (agent.tools?.length ? agent.tools : pi.getActiveTools()).filter(
                (tool) => !DELEGATION_TOOLS.has(tool),
            );
            const thinking = agent.thinking ?? tierThinking ?? ctx.thinkingLevel;
            const displayModel = thinking ? `${model}:${thinking}` : model;
            const job: DelegateJob = {
                // A resumed job keeps its id: the pinned child session id reopens the old transcript.
                id: prior?.id ?? randomUUID().slice(0, 8),
                agent: agent.name,
                description: (prior?.description ?? params.description ?? "").trim(),
                task: prior?.task ?? params.task ?? "",
                model: displayModel,
                status: "running",
                activity: [],
                tools,
                toolCalls: 0,
                startedAt: Date.now(),
                contextWindow: contextWindowFor(ctx, model),
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
                cwd: ctx.cwd,
                shell: false,
                stdio: "pipe",
            });
            store.launch(job, details.background);
            const run = runChild(
                child,
                prior ? RESUME_PROMPT : job.task,
                details.background ? job.controller.signal : signal,
                (update) => store.record(job, update),
                Boolean(prior),
            );
            job.steer = run.steer;

            if (!details.background) {
                try {
                    const output = await run.done;
                    store.finish(job, "done");
                    return { content: [{ type: "text", text: output }], details };
                } catch (error) {
                    // Record the outcome so the launch entry cannot linger as "running".
                    const cancelled = error instanceof Error && error.message === "Delegate was aborted";
                    store.finish(job, cancelled ? "cancelled" : "failed");
                    // Failed jobs are resumable; mirror the failed background report's hint on the thrown error.
                    if (!cancelled && error instanceof Error) error.message += `\n${resumeHint(job.id)}`;
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
                        type: "text",
                        text: `Started delegate "${job.agent}" in the background (job ${job.id}). Steer it with delegate_steer or stop it with delegate_cancel. Do not call tools solely to wait, even no-op bash commands; when its report is your next dependency, end your turn and it will arrive automatically unless cancelled.`,
                    },
                ],
                details,
            };
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
            const status = details.background ? "started in background" : "completed";
            // The done icon means actual completion; a background launch reports its status without it.
            const header = details.background
                ? `${jobIdentity(theme, details)} ${theme.fg("muted", status)}`
                : `${statusText(theme, "done")} ${jobIdentity(theme, details)} ${theme.fg("muted", status)}`;
            const container = new Container();
            container.addChild(new Text(`\n${header}`, 0, 0));
            // The call body already carries the task; only the launch metadata is new here.
            if (expanded)
                container.addChild(
                    new Text(
                        theme.fg("muted", launchDetails({ model: details.model, tools: details.tools }).join("\n")),
                        0,
                        0,
                    ),
                );
            // Background results arrive as their own message; headless runs still show the output here.
            if (!details.background && body) {
                const { shown, hidden } = outputPreview(body, expanded ? Infinity : COLLAPSED_OUTPUT_LINES);
                container.addChild(new Markdown(shown.join("\n"), 0, 0, getMarkdownTheme()));
                if (hidden > 0) container.addChild(new Text(moreLines(theme, hidden), 0, 0));
            }
            return container;
        },
    });

    pi.registerTool({
        name: "delegate_steer",
        label: "Steer delegate",
        description:
            "Send guidance to a running background delegate. The child receives it after its current tool calls and before its next model request; it cannot revive a finished job. Use delegate_list for the ids of running jobs.",
        promptSnippet: "Send guidance to a running background delegate by job id",
        parameters: Type.Object({
            id: Type.String({
                description: 'Job id from a delegate tool result or a delegate-result message, such as "38631a01".',
            }),
            message: Type.String({ description: "The guidance to deliver to the running child." }),
        }),
        async execute(_toolCallId, params) {
            const id = jobId(params.id);
            const job = store.live().find((candidate) => candidate.id === id);
            if (!job?.steer) throw new Error(`No running delegate job "${id}".`);
            await job.steer(params.message);
            const details: SteerDetails = {
                id: job.id,
                agent: job.agent,
                description: job.description,
                message: params.message,
                toolCalls: job.toolCalls,
                contextTokens: job.contextTokens,
                contextWindow: job.contextWindow,
                elapsedMs: Date.now() - job.startedAt,
            };
            return {
                content: [
                    { type: "text", text: `Steering message delivered to delegate "${job.agent}" (job ${job.id}).` },
                ],
                details,
            };
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

        renderResult(result, _options, theme, context) {
            const details = result.details as SteerDetails | undefined;
            const body = resultText(result);
            if (context.isError || !details?.agent) return resultFallback(body, theme, context.isError);
            return new Text(
                `\n${statusText(theme, "done")} ${jobIdentity(theme, details)} ${theme.fg("muted", details.description)} ${theme.fg("muted", usageStats(details, details.elapsedMs))}`,
                0,
                0,
            );
        },
    });

    pi.registerTool({
        name: "delegate_cancel",
        label: "Cancel delegate",
        description:
            "Cancel a running background delegate by job id. Requests abort now and forcibly kills the child after five seconds if needed. Cancelled jobs send no follow-up report, but can be resumed later with the delegate tool's `resume` parameter.",
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
                `\n${statusText(theme, "cancelled")} ${jobIdentity(theme, details)} ${theme.fg("muted", "cancellation requested")}`,
                0,
                0,
            );
        },
    });

    pi.registerTool({
        name: "delegate_list",
        label: "List delegates",
        description:
            "List the background delegates still running, with their job ids and progress, for steering or checking. Finished delegates are not listed; their results arrive as follow-up messages.",
        promptSnippet: "List running background delegates and their job ids",
        parameters: Type.Object({}),
        async execute() {
            const now = Date.now();
            const jobs = store.live();
            if (!jobs.length)
                return { content: [{ type: "text", text: "No delegates are running." }], details: undefined };
            const lastActivity = (job: DelegateJob) =>
                job.lastTool ? ` · ${job.lastTool}${job.lastDetail ? ` ${job.lastDetail}` : ""}` : "";
            const lines = jobs.map(
                (job) => `- ${job.id} ${job.agent} · ${jobLine(job, now - job.startedAt)}${lastActivity(job)}`,
            );
            return {
                content: [{ type: "text", text: `${jobs.length} running:\n${lines.join("\n")}` }],
                details: { jobs: jobs.map(jobSnapshot) },
            };
        },
        renderResult(result, _options, theme, context) {
            const jobs = (result.details as { jobs?: ReturnType<typeof jobSnapshot>[] } | undefined)?.jobs;
            if (!jobs?.length || context.isError) return resultFallback(resultText(result), theme, context.isError);
            const now = Date.now();
            return new Text(
                `\n${jobs
                    .map((job) => `${jobIdentity(theme, job)} ${theme.fg("muted", jobLine(job, now - job.startedAt))}`)
                    .join("\n")}`,
                0,
                0,
            );
        },
    });
}

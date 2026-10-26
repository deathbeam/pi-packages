import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, renderDiff } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
    appendOutput,
    capLines,
    COLLAPSED_OUTPUT_LINES,
    type DelegateDetails,
    type DelegateReport,
    elapsedMs,
    isolationWords,
    jobIdentity,
    jobLine,
    jobSummary,
    launchResult,
    moreLines,
    piDiff,
    reportText,
    resultFallback,
    resultHeader,
    reviveHint,
    SPINNER_INTERVAL_MS,
    statusText,
    tally,
    toolLayout,
    widgetJobs,
} from "./format.ts";
import { priorActivity, runChild } from "./child.ts";
import { createJobStore, type DelegateJob, lastToolCall, type InspectJob } from "./store.ts";
import {
    applyClone,
    cloneCwd,
    createIsolation,
    isolationSummary,
    removeClone,
    type IsolationState,
} from "./isolation.ts";
import { registerInspector } from "./inspector.ts";
import { agentByName, agentsFor, configFor, contextWindowFor, resolveModel, type AgentFile } from "./agents.ts";

type SteerDetails = Pick<
    DelegateJob,
    "id" | "agent" | "description" | "toolCalls" | "contextTokens" | "contextWindow"
> & {
    message: string;
    elapsedMs: number;
};

const DELEGATION_TOOLS = new Set([
    "delegate",
    "delegate_apply",
    "delegate_discard",
    "delegate_list",
    "delegate_steer",
    "delegate_cancel",
]);
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

export default function (pi: ExtensionAPI) {
    const store = createJobStore(pi.appendEntry);
    let ticker: ReturnType<typeof setInterval> | undefined;
    // Prompts are read once; drift happens one quick search at a time, so count it and nudge at 5, 10, 20, ...
    let directCalls = 0;
    let nextReminder = FIRST_REMINDER_AT;

    const jobTarget = (rawId: unknown, theme: Theme): string => {
        const id = jobId(rawId);
        const job = store.find(id);
        return job ? jobIdentity(theme, job) : theme.fg("muted", id || "…");
    };

    /** The clone is the unit: every job id that ran in it is only a handle, so state changes reach all of them. */
    const jobsInClone = (clone: string) => store.all().filter((job) => job.isolation?.clone === clone);

    /** A job that still has a clone; any job id that ran in a clone is a handle on it. */
    const clonedJob = (id: string) => {
        const job = store.findOrThrow(id);
        const isolation = job.isolation;
        if (!isolation)
            throw new Error(
                job.cloneClosed
                    ? `The clone of delegate job "${id}" was already applied or discarded.`
                    : `Delegate job "${id}" did not run in an isolated clone.`,
            );
        return { job, isolation };
    };

    /** Closing a clone is a clone-wide operation: every job id that ran in it stops pointing at it. */
    const closeClone = (isolation: IsolationState) => {
        removeClone(isolation);
        for (const shared of jobsInClone(isolation.clone)) {
            shared.isolation = undefined;
            shared.cloneClosed = true;
            store.save(shared);
        }
    };

    /** One job at a time per clone: a shared clone is a shared working directory. */
    const requireIdleClone = (isolation: IsolationState) => {
        const busy = store.live().find((job) => job.isolation?.clone === isolation.clone);
        if (busy)
            throw new Error(`Delegate job "${busy.id}" is running in this clone; wait for it or cancel it first.`);
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
        const counts = tally(jobs.length, all, now);
        lines.push(`${statusText(theme, "running", now)} ${theme.fg("muted", counts)}`);
        for (const job of shown) {
            lines.push(
                `${statusText(theme, "running", now)} ${jobIdentity(theme, job)} ${theme.fg("muted", jobLine(job, elapsedMs(job, now)))}`,
            );
            if (!detail) continue;
            const { tool, result } = lastToolCall(job);
            if (tool)
                lines.push(
                    `   ${theme.fg("toolTitle", theme.bold(tool.text))}${tool.detail ? ` ${theme.fg("accent", tool.detail)}` : ""}`,
                );
            if (result?.text)
                lines.push(
                    `   ${theme.fg("muted", "↳")} ${theme.fg(result.isError ? "error" : "toolOutput", result.text)}`,
                );
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
            elapsedMs: elapsedMs(job),
            output: withIsolation(output ?? "", job.isolation),
            error,
            status: job.status,
            isolation: job.isolation,
            cloneClosed: job.cloneClosed,
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
        fields: { description: string; model?: string; isolated?: boolean; clone?: IsolationState },
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
        const isolation =
            prior?.isolation ?? fields.clone ?? (fields.isolated ? createIsolation(ctx.cwd, id) : undefined);
        if (isolation) requireIdleClone(isolation);

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
            status: job.status,
            isolation: job.isolation,
            cloneClosed: job.cloneClosed,
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
        const cwd = isolation ? cloneCwd(isolation, ctx.cwd) : ctx.cwd;
        if (isolation)
            args.push(
                "--append-system-prompt",
                `You are working in an isolated git clone at ${isolation.clone}. Your working directory is ${cwd}; run every command from it with relative paths. Any path under ${ctx.cwd} means the same file under ${cwd}. Your edits and commits stay in this clone until the orchestrator applies them.${tools.includes("bash") ? " `git diff main-snapshot` shows every change made in this clone." : ""}`,
            );
        const child = spawn(process.execPath, [entrypoint, "--mode", "rpc", ...args], {
            cwd,
            shell: false,
            stdio: "pipe",
        });
        store.launch(job);
        const run = runChild(
            child,
            prompt,
            // Foreground runs also stop on the tool's own abort (Esc); delegate_cancel and shutdown use the controller.
            details.background || !signal ? job.controller.signal : AbortSignal.any([signal, job.controller.signal]),
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
                    content: `<system-reminder>These delegate jobs were interrupted by a restart or crash; their transcripts survive. Continue each with delegate_steer (job id plus your guidance):\n${interrupted
                        .map((job) => {
                            const isolation = isolationWords(job);
                            return `- ${job.id} ${job.agent}: ${job.description}${isolation ? ` (${isolation})` : ""}`;
                        })
                        .join("\n")}</system-reminder>`,
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
        const container = new Container();
        container.addChild(
            new Text(resultHeader(theme, report, jobSummary(report), report.error ? "failed" : "done"), 0, 0),
        );
        if (report.error) container.addChild(new Text(theme.fg("error", report.error), 0, 0));
        else if (report.output) {
            container.addChild(new Spacer(1));
            appendOutput(container, report.output, expanded, theme);
        }
        return container;
    });

    registerInspector(pi, store);

    const cwd = process.cwd();
    const agentList = agentsFor(cwd).map((agent) => {
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
            "With isolated: true, the delegate runs in an isolated git clone at .pi/worktrees/<job id>, starting from the main tree exactly as it is now, uncommitted and untracked files included. It never touches the main tree and may commit freely; delegate_apply brings its changes back, delegate_discard drops them.",
            "",
            "To run another delegate in an isolated job's clone, pass that job id as `clone`. delegate_apply or delegate_discard with any job id from that clone acts on the whole clone, and only one job can run in a clone at a time.",
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
                Type.Boolean({ description: "Run in a new isolated git clone; apply results with delegate_apply." }),
            ),
            clone: Type.Optional(
                Type.String({
                    description: "Job id of an isolated delegate; run in its clone instead of the main tree.",
                }),
            ),
        }),
        async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
            const params = dropNulls(rawParams);
            const { agent: agentName, description, task, model, isolated } = params;
            if (!agentName || !description || !task) throw new Error("agent, description and task are required.");
            const cloneId = jobId(params.clone);
            if (cloneId && isolated === false) throw new Error("clone always runs isolated; omit isolated: false.");
            const clone = cloneId ? clonedJob(cloneId).isolation : undefined;
            const agent = agentByName(ctx.cwd, agentName);
            const effective = clone ? true : (isolated ?? agent.isolated);
            return runDelegate(ctx, agent, undefined, { description, model, isolated: effective, clone }, task, signal);
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
            const running = store.liveJob(id);
            if (running) {
                // A live job without steer would fall into the revive path and double-spawn its pinned session.
                if (!running.steer) throw new Error(`No steerable delegate job "${id}".`);
                try {
                    if (params.model) await swapModel(running, params.model, ctx);
                    await running.steer(params.message);
                } catch (error) {
                    // The swap or steer await can outlast the job (a model ack waits up to 30s); raw child errors are cryptic.
                    if (!store.liveJob(id))
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
                    elapsedMs: elapsedMs(running),
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
            const prior = store.findOrThrow(id);
            // An applied or discarded clone cannot be continued; a revive would run in the main tree.
            if (prior.cloneClosed)
                throw new Error(
                    `The isolated clone of delegate job "${id}" was already applied or discarded; delegate_steer cannot continue it. Start a fresh delegate with a condensed brief instead.`,
                );
            const agent = agentByName(ctx.cwd, prior.agent);
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
            if ("message" in details) return new Text(`\n${resultHeader(theme, details, jobSummary(details))}`, 0, 0);
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
        promptSnippet: "Cancel a running delegate by job id",
        parameters: Type.Object({
            id: Type.String({ description: "Job id from delegate or delegate_list." }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const id = jobId(params.id);
            const job = store.liveJob(id);
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
            // The mark is the call's outcome (cancellation requested), not the job's cancelled status.
            return new Text(`\n${resultHeader(theme, details, "cancellation requested")}`, 0, 0);
        },
    });

    pi.registerTool({
        name: "delegate_apply",
        label: "Apply delegate",
        description:
            "Apply an isolated delegate's changes to the main working tree by job id. The delegate's commits and uncommitted changes are 3-way merged onto a fresh snapshot of the main tree, so nearby but non-overlapping edits apply cleanly; only a true conflict fails. On conflict the clone is kept and the error explains the recovery. No delegate may be running in its clone.",
        promptSnippet: "Apply an isolated delegate's clone to the main tree by job id",
        parameters: Type.Object({
            id: Type.String({ description: "Job id of an isolated delegate; any job id that ran in the clone works." }),
        }),
        async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
            const params = dropNulls(rawParams);
            const id = jobId(params.id);
            const { job, isolation } = clonedJob(id);
            requireIdleClone(isolation);
            const result = applyClone(isolation);
            if (result.kind === "conflict") {
                // Base rule: base tracks the newest snapshot, so the next apply works whether or not the delegate rebased yet.
                for (const shared of jobsInClone(isolation.clone)) {
                    shared.isolation = { ...isolation, base: result.snapshot };
                    store.save(shared);
                }
                throw new Error(
                    `Main tree changed under delegate job "${job.id}"; conflicting files: ${result.files.join(", ") || "(unknown)"}. The clone at ${isolation.clone} was kept. Steer job ${job.id} with: "The main tree changed under you. Run \`git rebase main-snapshot\`, resolve each conflict, then \`git add\` the files and run \`git rebase --continue\` until the rebase finishes." Then call delegate_apply again.`,
                );
            }
            const stat = result.kind === "applied" ? `\n${result.stat}` : "";
            closeClone(isolation);
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
            return toolLayout("delegate_apply", jobTarget(args?.id, theme), "", theme, context.expanded);
        },

        renderResult(result, { expanded }, theme, context) {
            const details = result.details as { id: string; agent: string; diff?: string } | undefined;
            const body = resultText(result);
            if (context.isError || !details?.agent) return resultFallback(body, theme, context.isError);
            const header = `\n${resultHeader(theme, details, "changes applied")}`;
            const diff = details.diff?.trim() ? renderDiff(piDiff(details.diff)) : "";
            if (!diff) return new Text(header, 0, 0);
            // Collapsed shows the head like the other delegate previews; expanded shows the full colored diff.
            const { shown, hidden } = capLines(diff.split("\n"), expanded ? Infinity : COLLAPSED_OUTPUT_LINES);
            if (hidden) shown.push(moreLines(theme, hidden));
            const container = new Container();
            container.addChild(new Text(header, 0, 0));
            container.addChild(new Spacer(1));
            container.addChild(new Text(shown.join("\n"), 0, 0));
            return container;
        },
    });

    pi.registerTool({
        name: "delegate_discard",
        label: "Discard delegate clone",
        description: "Remove an isolated delegate's clone without applying its changes.",
        promptSnippet: "Discard an isolated delegate's clone by job id",
        parameters: Type.Object({
            id: Type.String({ description: "Job id of an isolated delegate; any job id that ran in the clone works." }),
        }),
        async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
            const params = dropNulls(rawParams);
            const id = jobId(params.id);
            const { job, isolation } = clonedJob(id);
            requireIdleClone(isolation);
            closeClone(isolation);
            return {
                content: [
                    {
                        type: "text",
                        text: `Discarded the isolated clone of delegate "${job.agent}" (job ${job.id}); nothing was applied.`,
                    },
                ],
                details: { id: job.id, agent: job.agent, discarded: true },
            };
        },

        renderCall(args, theme, context) {
            return toolLayout("delegate_discard", jobTarget(args?.id, theme), "", theme, context.expanded);
        },

        renderResult(result, _options, theme, context) {
            const details = result.details as { id: string; agent: string; discarded?: boolean } | undefined;
            const body = resultText(result);
            if (context.isError || !details?.agent) return resultFallback(body, theme, context.isError);
            return new Text(`\n${resultHeader(theme, details, "clone discarded")}`, 0, 0);
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
                const { tool } = lastToolCall(job);
                return job.status === "running" && tool ? ` · ${tool.text}${tool.detail ? ` ${tool.detail}` : ""}` : "";
            };
            const lines = jobs.map((job) => {
                const tag = isolationWords(job);
                return `- ${job.id} ${job.agent} · ${job.status}${tag ? ` · ${tag}` : ""} · ${jobLine(job, elapsedMs(job, now))}${lastActivity(job)}`;
            });
            return {
                content: [
                    { type: "text", text: `${jobs.length} delegates (${running} running):\n${lines.join("\n")}` },
                ],
                details: { jobs: jobs.map(store.snapshot) },
            };
        },
        renderResult(result, _options, theme, context) {
            const jobs = (result.details as { jobs?: InspectJob[] } | undefined)?.jobs;
            if (!jobs?.length || context.isError) return resultFallback(resultText(result), theme, context.isError);
            const now = Date.now();
            return new Text(
                `\n${statusText(theme, "done")} ${theme.fg("muted", `${jobs.length} delegates`)}\n${jobs
                    .map(
                        (job) =>
                            `${statusText(theme, job.status, now)} ${jobIdentity(theme, job)} ${theme.fg("muted", jobLine(job, elapsedMs(job, now)))}`,
                    )
                    .join("\n")}`,
                0,
                0,
            );
        },
    });
}

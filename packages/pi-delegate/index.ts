import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    CONFIG_DIR_NAME,
    getAgentDir,
    getMarkdownTheme,
    keyHint,
    parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Container,
    HStack,
    Markdown,
    Spacer,
    Text,
    TruncatedText,
    matchesKey,
    truncateToWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
    COLLAPSED_OUTPUT_LINES,
    type DelegateReport,
    formatTools,
    jobIdentity,
    jobLine,
    type JobStatus,
    launchDetails,
    outputPreview,
    reportText,
    SPINNER_INTERVAL_MS,
    STATUS_COLORS,
    statusText,
    usageStats,
    widgetJobs,
} from "./format.ts";
import { type ChildActivity, runChild } from "./child.ts";

type AgentFile = {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    thinking?: string;
    prompt: string;
};

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

type InspectJob = {
    id: string;
    agent: string;
    description: string;
    task: string;
    model: string;
    tools: string[];
    toolCalls: number;
    contextTokens?: number;
    contextWindow?: number;
    startedAt: number;
    endedAt?: number;
    status: JobStatus;
    activity: ChildActivity[];
};

type DelegateJob = InspectJob & {
    lastTool?: string;
    lastDetail?: string;
    lastResult?: string;
    controller: AbortController;
    steer?: (message: string) => Promise<void>;
};

type DelegateConfig = {
    agentDirs?: unknown;
    models?: Record<string, unknown>;
};

const DEFAULT_AGENT_DIR = "~/.agents/agents";
const BUNDLED_AGENT_DIR = fileURLToPath(new URL("./agents", import.meta.url));
const DELEGATION_TOOLS = new Set(["delegate", "delegate_list", "delegate_steer", "delegate_cancel"]);
const MODEL_TIERS = new Set(["cheap", "balanced", "strong"]);
const WIDGET_KEY = "delegate";
const RESULT_MESSAGE = "delegate-result";
const TASK_PREVIEW_LINES = 5;

function expandPath(value: string, cwd: string): string {
    return resolve(cwd, value.replace(/^~(?=\/|$)/, homedir()));
}

function stringList(value: unknown): string[] {
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
}

function readConfig(path: string): DelegateConfig {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object") return {};
        const delegate = (parsed as { delegate?: unknown }).delegate;
        return delegate && typeof delegate === "object" ? (delegate as DelegateConfig) : {};
    } catch {
        return {};
    }
}

function configFor(cwd: string): DelegateConfig {
    const global = readConfig(join(getAgentDir(), "settings.json"));
    const project = readConfig(join(cwd, CONFIG_DIR_NAME, "settings.json"));
    return {
        agentDirs: [...stringList(global.agentDirs), ...stringList(project.agentDirs)],
        models: { ...(global.models ?? {}), ...(project.models ?? {}) },
    };
}

function loadAgents(dir: string): AgentFile[] {
    if (!existsSync(dir)) return [];
    const agents: AgentFile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
        try {
            const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
                readFileSync(join(dir, entry.name), "utf8"),
            );
            if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
            agents.push({
                name: frontmatter.name,
                description: frontmatter.description,
                tools: stringList(frontmatter.tools),
                model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
                thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
                prompt: body.trim(),
            });
        } catch {
            // One malformed agent file should not disable delegation.
        }
    }
    return agents;
}

function discoverAgents(cwd: string, configuredDirs: unknown): AgentFile[] {
    const dirs = [BUNDLED_AGENT_DIR, DEFAULT_AGENT_DIR, ...stringList(configuredDirs)].map((dir) =>
        expandPath(dir, cwd),
    );
    const agents = new Map<string, AgentFile>();
    for (const dir of [...new Set(dirs)]) {
        for (const agent of loadAgents(dir)) agents.set(agent.name, agent);
    }
    return [...agents.values()];
}

function resolveModel(
    value: string | undefined,
    models: Record<string, unknown>,
    current: ExtensionContext["model"],
): string | undefined {
    if (value && !MODEL_TIERS.has(value)) return value;
    const configured = value ? models[value] : undefined;
    if (typeof configured === "string" && configured) return configured;
    return current ? `${current.provider}/${current.id}` : undefined;
}

function contextWindowFor(ctx: ExtensionContext, model: string | undefined): number | undefined {
    const separator = model?.indexOf("/") ?? -1;
    if (!model || separator < 0) return undefined;
    return ctx.modelRegistry.find(model.slice(0, separator), model.slice(separator + 1))?.contextWindow;
}

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
                truncateToWidth(
                    theme.fg("muted", `… ${lines.length - COLLAPSED_OUTPUT_LINES} more lines, `) +
                        keyHint("app.tools.expand", "to expand"),
                    width,
                ),
            ];
        },
        invalidate: () => body.invalidate(),
    });
    return container;
}

export default function (pi: ExtensionAPI) {
    const running = new Map<string, DelegateJob>();
    const recent: InspectJob[] = [];
    let viewing: (() => void) | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;

    const addActivity = (job: DelegateJob, activity: ChildActivity) => {
        const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
        job.activity.push(
            activity.kind === "assistant" || activity.kind === "user"
                ? activity
                : {
                      ...activity,
                      text: normalize(activity.text),
                      detail: activity.detail && normalize(activity.detail),
                  },
        );
        viewing?.();
    };

    const remember = (job: DelegateJob, status: JobStatus, detail?: string) => {
        job.status = status;
        if (detail) addActivity(job, { kind: "status", text: detail });
        const { controller, steer, lastTool, lastDetail, lastResult, ...snapshot } = job;
        recent.unshift({ ...snapshot, endedAt: Date.now() });
    };

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
        const job = running.get(id) ?? recent.find((item) => item.id === id);
        return job ? jobIdentity(theme, job) : theme.fg("muted", id || "…");
    };

    const refreshWidget = (ctx: ExtensionContext) => {
        if (!ctx.hasUI) return;
        viewing?.();
        if (running.size === 0) {
            ctx.ui.setWidget(WIDGET_KEY, undefined);
            return;
        }
        const theme = ctx.ui.theme;
        const now = Date.now();
        const { shown, hidden, detail } = widgetJobs([...running.values()]);
        const lines: string[] = [];
        const counts = `${running.size} running · ${running.size + recent.length} total`;
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

    const stopTicker = () => {
        if (ticker) clearInterval(ticker);
        ticker = undefined;
    };

    const finishJob = (ctx: ExtensionContext, job: DelegateJob, output?: string, error?: string) => {
        // Cancellation was already acknowledged; shutdown has no UI to report into.
        if (job.controller.signal.aborted) return;
        running.delete(job.id);
        remember(job, error ? "failed" : "done", error ? `Error: ${error}` : undefined);
        if (running.size === 0) stopTicker();
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
        stopTicker();
        for (const job of running.values()) job.controller.abort();
        running.clear();
        recent.length = 0;
        viewing = undefined;
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
            if (hidden > 0)
                container.addChild(
                    new Text(
                        theme.fg("muted", `… ${hidden} more lines, `) + keyHint("app.tools.expand", "to expand"),
                        0,
                        0,
                    ),
                );
        }
        return container;
    });

    pi.registerCommand("delegate", {
        description: "Inspect live and recent delegate activity",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") return;
            if (!running.size && !recent.length) {
                ctx.ui.notify("No delegates in this session yet.", "info");
                return;
            }
            const screen = {
                overlay: true,
                overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0 },
            } as const;
            try {
                await ctx.ui.custom((tui, theme, keys, done) => {
                    let selectedId = running.keys().next().value ?? recent[0]!.id;
                    let focus: "list" | "history" = "list";
                    let top: number | undefined;
                    let historyWidth = 1;
                    let markdown = new WeakMap<ChildActivity, Markdown>();
                    const jobs = () => [...running.values(), ...recent];
                    const bodyHeight = () => Math.max(0, tui.terminal.rows - 3);
                    // The list pane already draws a border, and the muted model line sets the task apart.
                    const taskLines = (job: InspectJob, width: number) => {
                        const lines = wrapTextWithAnsi(job.task.trim(), Math.max(1, width)).map((line) =>
                            theme.fg("text", line),
                        );
                        if (lines.length <= TASK_PREVIEW_LINES) return lines;
                        return [
                            ...lines.slice(0, TASK_PREVIEW_LINES),
                            theme.fg("muted", `… ${lines.length - TASK_PREVIEW_LINES} more lines`),
                        ];
                    };
                    const toolsLines = (job: InspectJob, width: number) =>
                        wrapTextWithAnsi(formatTools(job.tools), Math.max(1, width)).map((line) =>
                            theme.fg("dim", line),
                        );
                    const historyHeight = (job: InspectJob, width: number) =>
                        Math.max(0, bodyHeight() - 6 - taskLines(job, width).length - toolsLines(job, width).length);
                    // ScrollView needs fullscreen layout; window the history in regular TUI too.
                    const renderJobs = (width: number, items: InspectJob[], selectedIndex: number): string[] => {
                        const row = (text: string) =>
                            truncateToWidth(text, Math.max(0, width - 1), "…", true) + theme.fg("borderMuted", "│");
                        const visible = Math.max(1, Math.floor((bodyHeight() - 1) / 3));
                        const start = Math.max(
                            0,
                            Math.min(selectedIndex - Math.floor(visible / 2), items.length - visible),
                        );
                        const lines = items
                            .slice(start, start + visible)
                            .flatMap((item, index) => [
                                row(
                                    `${theme.fg(start + index === selectedIndex && focus === "list" ? "accent" : "text", start + index === selectedIndex ? "›" : " ")} ${statusText(theme, item.status)} ${jobIdentity(theme, item)}`,
                                ),
                                row(theme.fg("muted", `    ${item.description}`)),
                                row(
                                    theme.fg(
                                        "dim",
                                        `    ${usageStats(item, (item.endedAt ?? Date.now()) - item.startedAt)}`,
                                    ),
                                ),
                            ]);
                        return [
                            ...lines,
                            ...Array(Math.max(0, bodyHeight() - 1 - lines.length)).fill(row("")),
                            row(theme.fg("dim", ` ${selectedIndex + 1}/${items.length}`)),
                        ].slice(0, bodyHeight());
                    };
                    const renderEntry = (entry: ChildActivity, width: number): string[] => {
                        if (entry.kind === "assistant" || entry.kind === "user") {
                            let md = markdown.get(entry);
                            if (!md) {
                                md = new Markdown(entry.text, 0, 0, getMarkdownTheme());
                                markdown.set(entry, md);
                            }
                            return [theme.fg("accent", entry.kind), ...md.render(width), ""];
                        }
                        if (entry.kind === "tool")
                            return [
                                truncateToWidth(
                                    theme.fg("toolTitle", entry.text) +
                                        (entry.detail ? ` ${theme.fg("accent", entry.detail)}` : ""),
                                    width,
                                ),
                            ];
                        if (entry.kind === "result") return [truncateToWidth(theme.fg("text", entry.text), width)];
                        // Only failure detail still says anything; the header icon carries the status.
                        if (!entry.text) return [];
                        return [truncateToWidth(theme.fg(STATUS_COLORS.failed, entry.text), width)];
                    };
                    const renderHistory = (width: number, job: InspectJob): string[] => {
                        historyWidth = width;
                        const task = taskLines(job, width);
                        const tools = toolsLines(job, width);
                        const height = historyHeight(job, width);
                        const history = job.activity.flatMap((entry) => renderEntry(entry, width));
                        const maxTop = Math.max(0, history.length - height);
                        const start = Math.min(top ?? maxTop, maxTop);
                        const visible = history.slice(start, start + height);
                        const shown = visible.length
                            ? visible
                            : height
                              ? [theme.fg("muted", "Waiting for activity…")]
                              : [];
                        return [
                            truncateToWidth(`${statusText(theme, job.status)} ${jobIdentity(theme, job)}`, width),
                            truncateToWidth(theme.fg("dim", job.model), width),
                            ...tools,
                            theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
                            truncateToWidth(theme.fg("text", theme.bold(job.description)), width),
                            ...task,
                            theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
                            ...shown,
                            ...Array(Math.max(0, height - shown.length)).fill(""),
                            truncateToWidth(
                                theme.fg(
                                    "dim",
                                    `${visible.length ? `${start + 1}–${start + visible.length}` : "0"}/${history.length}`,
                                ),
                                width,
                            ),
                        ].slice(0, bodyHeight());
                    };
                    viewing = () => tui.requestRender();
                    return {
                        render(width: number) {
                            const items = jobs();
                            const selectedIndex = Math.max(
                                0,
                                items.findIndex((item) => item.id === selectedId),
                            );
                            const selected = items[selectedIndex];
                            const title = truncateToWidth(
                                `${theme.fg(focus === "list" ? "accent" : "muted", focus === "list" ? "[Jobs]" : "Jobs")}  ` +
                                    `${theme.fg(focus === "history" ? "accent" : "muted", focus === "history" ? "[Activity]" : "Activity")}` +
                                    theme.fg("dim", ` · ${running.size} running · ${items.length} total`),
                                width,
                            );
                            const footer = truncateToWidth(
                                theme.fg(
                                    "dim",
                                    `${keyHint("tui.select.up", "previous")} · ${keyHint("tui.select.down", "next")} · Tab switch pane · ${keyHint("tui.select.cancel", "close")}`,
                                ),
                                width,
                            );
                            if (!selected)
                                return [
                                    title,
                                    theme.fg("muted", "No delegates in this session."),
                                    ...Array(Math.max(0, tui.terminal.rows - 3)).fill(""),
                                    footer,
                                ].slice(0, tui.terminal.rows);
                            const sidebarWidth = Math.min(
                                40,
                                Math.max(16, Math.floor(width * 0.35)),
                                Math.max(1, width - 2),
                            );
                            const body = new HStack(
                                [
                                    {
                                        component: {
                                            render: (w) => renderJobs(w, items, selectedIndex),
                                            invalidate() {},
                                        },
                                        basis: sidebarWidth,
                                        shrink: 0,
                                    },
                                    {
                                        component: { render: (w) => renderHistory(w, selected), invalidate() {} },
                                        basis: 0,
                                        grow: 1,
                                    },
                                ],
                                { gap: 1 },
                            ).render(width);
                            return [
                                title,
                                theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
                                ...body,
                                footer,
                            ].slice(0, tui.terminal.rows);
                        },
                        invalidate() {
                            markdown = new WeakMap();
                        },
                        handleInput(data: string) {
                            if (keys.matches(data, "tui.select.cancel")) done(undefined);
                            else if (matchesKey(data, "tab")) focus = focus === "list" ? "history" : "list";
                            else if (matchesKey(data, "left")) focus = "list";
                            else if (
                                matchesKey(data, "right") ||
                                (focus === "list" && keys.matches(data, "tui.select.confirm"))
                            )
                                focus = "history";
                            else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
                                const up = keys.matches(data, "tui.select.up");
                                const items = jobs();
                                if (focus === "list") {
                                    const index = Math.max(
                                        0,
                                        items.findIndex((item) => item.id === selectedId),
                                    );
                                    selectedId =
                                        items[Math.max(0, Math.min(items.length - 1, index + (up ? -1 : 1)))]?.id ??
                                        selectedId;
                                    top = undefined;
                                } else {
                                    const selected = items.find((item) => item.id === selectedId) ?? items[0];
                                    const length =
                                        selected?.activity.reduce(
                                            (sum, entry) => sum + renderEntry(entry, historyWidth).length,
                                            0,
                                        ) ?? 0;
                                    const maxTop = Math.max(
                                        0,
                                        length - (selected ? historyHeight(selected, historyWidth) : 0),
                                    );
                                    const position = Math.max(0, Math.min(maxTop, top ?? maxTop) + (up ? -1 : 1));
                                    top = position >= maxTop ? undefined : position;
                                }
                            }
                            tui.requestRender();
                        },
                    };
                }, screen);
            } finally {
                viewing = undefined;
            }
        },
    });

    const cwd = process.cwd();
    const agentList = discoverAgents(cwd, configFor(cwd).agentDirs).map(
        (agent) => `- ${agent.name}${agent.model ? ` (${agent.model})` : ""}: ${agent.description}`,
    );

    pi.registerTool({
        name: "delegate",
        label: "Delegate",
        description: [
            "Start a background Pi agent on one focused task. Returns a job id immediately; the agent's report arrives later as a follow-up message.",
            "",
            "Available agents (default model in parentheses):",
            ...agentList,
            "",
            "The agent gets the project instructions but not this conversation: it cannot see the user's request, the files you read, or your decisions. Write `task` as a self-contained brief: the goal and why, what you already know (paths, symbols, errors), scope and constraints, whether to edit files or only report, and what to return (format, length, path:line evidence).",
        ].join("\n"),
        promptSnippet:
            "Delegate a focused task to a background agent with its own context; only its report comes back, as a later follow-up message",
        promptGuidelines: [
            "Delegation is authorized: use delegate proactively, without waiting for the user to ask, whenever work matches an agent's description. Your context is the scarce resource: everything you read stays in it, is re-sent with every later request, and brings compaction closer. A delegate works in a fresh context, often on a cheaper model, and returns only its report.",
            "Delegate when you need the conclusion rather than the raw material: open-ended searches (more than ~3 queries), understanding code across several files you will not edit, web research, long command output such as test runs and builds, independent subtasks, and reviews of finished work. Work directly for a known file path, one targeted search, a quick command, or code you will edit yourself. Once direct searching passes ~3 queries, delegate the rest.",
            "Start every independent delegate before waiting on any, ideally in one message. Keep decisions and synthesis yourself. Trust reports instead of repeating their searches; read only what you act on.",
            "While delegates run, stay outside their scopes; delegate any new context-heavy investigation before tracing it yourself. When a report is the next dependency, end your turn with a brief waiting status. Completion will wake you.",
            "Read every required delegate report before claiming the task is done. Never sleep, poll, or call any tool solely to wait (including `bash` with `true`, `echo`, or `sleep 0`). Use delegate_list only for a one-time status check.",
        ],
        parameters: Type.Object({
            agent: Type.String({ description: "Agent name from the list in this tool's description." }),
            description: Type.String({
                description: "Short 3-8 word summary of this delegation, shown in the transcript.",
            }),
            task: Type.String({ description: "Self-contained brief; the agent cannot see this conversation." }),
            model: Type.Optional(
                Type.String({ description: "Model tier (cheap, balanced, strong) or an explicit provider/model." }),
            ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const config = configFor(ctx.cwd);
            const agents = discoverAgents(ctx.cwd, config.agentDirs);
            const agent = agents.find((candidate) => candidate.name === params.agent);
            if (!agent) {
                const names = agents.map((candidate) => candidate.name).join(", ") || "(none)";
                throw new Error(`Unknown agent "${params.agent}". Available agents: ${names}.`);
            }
            const model = resolveModel(params.model ?? agent.model, config.models ?? {}, ctx.model);
            if (!model) throw new Error(`No model found for "${params.agent}".`);
            const tools = (agent.tools?.length ? agent.tools : pi.getActiveTools()).filter(
                (tool) => !DELEGATION_TOOLS.has(tool),
            );
            const job: DelegateJob = {
                id: randomUUID().slice(0, 8),
                agent: agent.name,
                description: params.description.trim(),
                task: params.task,
                model,
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
                model,
                tools,
                // Only a UI can deliver a result that arrives after the tool returned; headless runs must block.
                background: ctx.hasUI,
            };
            const args = ["--model", model, "--tools", tools.join(",")];
            const thinking = agent.thinking ?? ctx.thinkingLevel;
            if (thinking) args.push("--thinking", thinking);
            if (agent.prompt) args.push("--append-system-prompt", agent.prompt);
            const entrypoint = process.argv[1];
            if (!entrypoint) throw new Error("Pi CLI entrypoint missing; start Pi from its CLI to delegate.");
            const child = spawn(process.execPath, [entrypoint, "--mode", "rpc", "--no-session", ...args], {
                cwd: ctx.cwd,
                shell: false,
                stdio: "pipe",
            });
            const run = runChild(child, params.task, details.background ? job.controller.signal : signal, (update) => {
                if (job.status !== "running") return;
                const { activity, ...progress } = update;
                for (const [key, value] of Object.entries(progress)) {
                    if (value !== undefined) (job as Record<string, unknown>)[key] = value;
                }
                if (activity && details.background) addActivity(job, activity);
            });
            job.steer = run.steer;

            if (!details.background) {
                const output = await run.done;
                return { content: [{ type: "text", text: output }], details };
            }

            running.set(job.id, job);
            if (!ticker) ticker = setInterval(() => refreshWidget(ctx), SPINNER_INTERVAL_MS);
            refreshWidget(ctx);
            // The only failure left here is reporting into a session that is being torn down,
            // and an unhandled rejection would crash pi.
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
                        text: `Started agent "${job.agent}" in the background (job ${job.id}). Steer it with delegate_steer or stop it with delegate_cancel. Do not call tools solely to wait, even no-op bash commands; when its report is your next dependency, end your turn and it will arrive automatically unless cancelled.`,
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
            const container = new Container();
            container.addChild(
                new Text(
                    `\n${statusText(theme, "done")} ${jobIdentity(theme, details)} ${theme.fg("dim", status)}`,
                    0,
                    0,
                ),
            );
            // The call body already carries the task; only the launch metadata is new here.
            if (expanded)
                container.addChild(
                    new Text(
                        theme.fg("dim", launchDetails({ model: details.model, tools: details.tools }).join("\n")),
                        0,
                        0,
                    ),
                );
            // Background results arrive as their own message; headless runs still show the output here.
            if (!details.background && body) {
                const { shown, hidden } = outputPreview(body, expanded ? Infinity : COLLAPSED_OUTPUT_LINES);
                container.addChild(new Markdown(shown.join("\n"), 0, 0, getMarkdownTheme()));
                if (hidden > 0)
                    container.addChild(
                        new Text(
                            theme.fg("muted", `… ${hidden} more lines, `) + keyHint("app.tools.expand", "to expand"),
                            0,
                            0,
                        ),
                    );
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
            const job = running.get(id);
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
            "Cancel a running background delegate by job id. Requests abort now and forcibly kills the child after five seconds if needed. Cancelled jobs send no follow-up report.",
        promptSnippet: "Cancel a running background delegate by job id",
        parameters: Type.Object({
            id: Type.String({ description: "Job id from delegate or delegate_list." }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const id = jobId(params.id);
            const job = running.get(id);
            if (!job) throw new Error(`No running delegate job "${id}".`);
            running.delete(id);
            remember(job, "cancelled");
            job.controller.abort();
            if (running.size === 0) stopTicker();
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
            const jobs = [...running.values()];
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

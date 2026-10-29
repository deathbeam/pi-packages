import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Container,
    Markdown,
    Spacer,
    Text,
    TruncatedText,
    truncateToWidth,
} from "@earendil-works/pi-tui";
import type { IsolationState } from "./isolation.ts";
import type { DelegateJob, JobStatus } from "./store.ts";

type UsageInfo = {
    contextTokens?: number;
    contextWindow?: number;
};

export type DelegateReport = {
    id: string;
    agent: string;
    description: string;
    model?: string;
    toolCalls: number;
    contextTokens?: number;
    contextWindow?: number;
    elapsedMs: number;
    output?: string;
    error?: string;
    status: JobStatus;
    isolation?: IsolationState;
    cloneClosed?: boolean;
};

/** The isolation state to show for a job: pending means its clone still holds unapplied work. */
export type IsolationMark = "isolated" | "pending";

type IsolationStateFields = {
    isolation?: unknown;
    cloneClosed?: boolean;
    status?: string;
};

export type DelegateDetails = Pick<
    DelegateJob,
    "id" | "agent" | "description" | "task" | "model" | "tools" | "status" | "isolation" | "cloneClosed"
> & { background: boolean };

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 100;
const STATUS_ICONS = {
    done: "✓",
    failed: "✗",
    cancelled: "✗",
    interrupted: "⏸",
} as const satisfies Record<Exclude<JobStatus, "running">, string>;
export const STATUS_COLORS = {
    running: "warning",
    done: "success",
    failed: "error",
    cancelled: "muted",
    interrupted: "warning",
} as const satisfies Record<JobStatus, string>;
/** Each job takes up to 3 rows (job, tool call, tool result); older ones collapse into a footer. */
const WIDGET_MAX_JOBS = 5;
export const COLLAPSED_OUTPUT_LINES = 10;
const MAX_OUTPUT_BYTES = 50 * 1024;
const EXPANDED_PAD = "  ";

/** Terminal statuses have static icons; running jobs use statusIcon's clock-driven frame. */
function statusIcon(status: JobStatus, now = Date.now()): string {
    return status === "running"
        ? SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!
        : STATUS_ICONS[status];
}

export function statusText(theme: Theme, status: JobStatus, now = Date.now()): string {
    return theme.fg(STATUS_COLORS[status], statusIcon(status, now));
}

/** Derives the mark from a job: an isolation with no clone left, or a still-running one, is not pending. */
export function isolationMarkOf(job: IsolationStateFields): IsolationMark | undefined {
    if (!job.isolation) return undefined;
    return job.cloneClosed || job.status === "running" ? "isolated" : "pending";
}

/** `⎇`, warning-colored while the clone's work is still unapplied. */
export function jobIdentity(theme: Theme, job: { id: string; agent: string } & IsolationStateFields): string {
    // Details snapshot the job's state, so a transcript line keeps the mark it had when captured.
    const mark = isolationMarkOf(job);
    const branch = mark ? ` ${theme.fg(mark === "pending" ? "warning" : "muted", "⎇")}` : "";
    return `${theme.fg("muted", job.id)} ${theme.fg("toolTitle", theme.bold(job.agent))}${branch}`;
}

export function isolationWords(job: IsolationStateFields): string {
    const mark = isolationMarkOf(job);
    return mark === "pending" ? "isolated, pending delegate_apply" : mark === "isolated" ? "isolated" : "";
}

export function formatTools(tools: string[]): string {
    return tools.join(", ") || "none";
}

function formatTokens(count: number): string {
    if (count < 1000) return String(count);
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

export function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function usageStats(usage: UsageInfo, elapsedMs: number): string {
    const tokens = usage.contextTokens
        ? usage.contextWindow
            ? `${formatTokens(usage.contextTokens)}/${formatTokens(usage.contextWindow)}`
            : formatTokens(usage.contextTokens)
        : "";
    return [tokens, formatDuration(elapsedMs)].filter(Boolean).join(" · ");
}

export function elapsedMs(job: { startedAt: number; endedAt?: number }, now = Date.now()): number {
    return (job.endedAt ?? now) - job.startedAt;
}

/** Summed wall-clock across jobs; running jobs tick from `now`. Parallel jobs each count their full span. */
export function totalElapsedMs(jobs: { startedAt: number; endedAt?: number }[], now = Date.now()): number {
    return jobs.reduce((sum, job) => sum + elapsedMs(job, now), 0);
}

export function tally(running: number, all: { startedAt: number; endedAt?: number }[], now = Date.now()): string {
    return `${running} running · ${all.length} total · ${formatDuration(totalElapsedMs(all, now))}`;
}

export function toolCallDetail(toolName: string, args: unknown): string {
    const input = (args ?? {}) as Record<string, unknown>;
    const value = (key: string) => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
    const path = value("path") || ".";
    switch (toolName) {
        case "bash":
        case "powershell":
            return value("command").split("\n")[0];
        case "read":
        case "write":
        case "edit":
            return value("path");
        case "grep":
            return `/${value("pattern")}/ in ${path}`;
        case "find":
            return `${value("pattern")} in ${path}`;
        case "ls":
            return path;
        default:
            return "";
    }
}

/** Expanded launch metadata; the call renderer shows the task. */
export function launchDetails(info: { model?: string; tools: string[] }): string[] {
    return [`${EXPANDED_PAD}Model: ${info.model ?? "default"}`, `${EXPANDED_PAD}Tools: ${formatTools(info.tools)}`];
}

/** Caps a preview at `maxLines`; callers report the hidden count their own way. */
export function capLines<T>(lines: T[], maxLines: number): { shown: T[]; hidden: number } {
    if (lines.length <= maxLines) return { shown: lines, hidden: 0 };
    return { shown: lines.slice(0, maxLines), hidden: lines.length - maxLines };
}

/** Close dangling Markdown fences so collapsed previews render correctly. */
export function outputPreview(text: string, maxLines = COLLAPSED_OUTPUT_LINES): { shown: string[]; hidden: number } {
    const { shown, hidden } = capLines(text.trim().split("\n"), maxLines);
    if (hidden && shown.filter((line) => line.trimStart().startsWith("```")).length % 2 === 1) shown.push("```");
    return { shown, hidden };
}

/** Cap child output without splitting UTF-8 characters. */
export function limitOutput(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
    const buffer = Buffer.from(text, "utf8");
    if (buffer.length <= maxBytes) return text;
    let end = maxBytes;
    // Back off any continuation byte so the cut lands on a character boundary.
    while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    return `${buffer.subarray(0, end).toString("utf8")}\n\n[Output truncated: ${buffer.length - end} bytes omitted.]`;
}

export function resultPreview(result: unknown, maxChars = 120): string | undefined {
    const content = (result as { content?: unknown })?.content;
    if (!Array.isArray(content)) return undefined;
    const text = content
        .map((part) => (part as { type?: string; text?: string }) ?? {})
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
    const line = text
        .split("\n")
        .find((candidate) => candidate.trim())
        ?.trim();
    if (!line) return undefined;
    return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

/** Shared so failed reports and thrown errors phrase the revive hint identically. */
export function reviveHint(id: string): string {
    return `To continue this job, call delegate_steer with id ${id} and a message.`;
}

/**
 * Converts a git unified diff into pi's own diff format (`+12 content` / `-12 content` / ` 12 content`,
 * prefix, padded line number, space, content), which is what pi's renderDiff colors; a raw unified
 * diff renders as flat context. Line numbers come from the @@ headers (- uses the old side, + and
 * context the new side); the file path heads each file and `...` separates its hunks.
 */
export function piDiff(unified: string): string {
    const out: string[] = [];
    let path = "";
    let pathShown = false;
    let hunkSeen = false;
    let oldNum = 0;
    let newNum = 0;
    let width = 1;
    const header = () => {
        if (!pathShown) {
            out.push(path);
            pathShown = true;
        }
    };
    for (const line of unified.split("\n")) {
        const file = /^diff --git a\/\S+ b\/(.+)$/.exec(line);
        if (file) {
            path = file[1]!;
            pathShown = false;
            hunkSeen = false;
            continue;
        }
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk) {
            const [, oldStart, oldCount, newStart, newCount] = hunk;
            // The width comes free from the hunk header's last line number on each side.
            width = String(
                Math.max(
                    Number(oldStart) + (Number(oldCount) || 1) - 1,
                    Number(newStart) + (Number(newCount) || 1) - 1,
                ),
            ).length;
            header();
            if (hunkSeen) out.push(` ${"".padStart(width, " ")} ...`);
            hunkSeen = true;
            oldNum = Number(oldStart);
            newNum = Number(newStart);
            continue;
        }
        // File-meta noise and the no-newline marker carry no content to render.
        if (!hunkSeen || line.startsWith("\\")) {
            if (/^Binary files .* differ$/.test(line)) header();
            continue;
        }
        const content = line.slice(1);
        const num = (prefix: string) => String(prefix === "-" ? oldNum++ : newNum++).padStart(width, " ");
        if (line.startsWith("+")) out.push(`+${num("+")} ${content}`);
        else if (line.startsWith("-")) out.push(`-${num("-")} ${content}`);
        else {
            out.push(` ${num(" ")} ${content}`);
            oldNum++;
        }
    }
    return out.join("\n");
}

export function reportText(report: DelegateReport): string {
    // Context usage lets the parent judge whether to continue this job or start a fresh one.
    const head = `Delegate "${report.agent}" (job ${report.id}, ${usageStats(report, report.elapsedMs)})`;
    if (report.error) return `${head} failed: ${report.error}\n${reviveHint(report.id)}`;
    const output = (report.output ?? "").trim();
    // The apply hint is for the model only: the transcript renders `output`, so users never see it.
    const hint =
        report.isolation && !report.cloneClosed
            ? `\n\nCall delegate_apply with job ${report.id} to land its changes, or delegate_discard to drop them. Call one, not both: a successful apply removes the clone.`
            : "";
    return `${head} finished.${output ? `\n\n${output}` : ""}${hint}`;
}

export function jobLine(info: { description?: string } & UsageInfo, elapsedMs: number): string {
    return [info.description?.trim(), usageStats(info, elapsedMs)].filter(Boolean).join(" · ");
}

/** Shows the newest jobs; the rest are counted in a "more running" footer. */
export function widgetJobs<T>(jobs: T[]): { shown: T[]; hidden: number } {
    const shown = jobs.slice(-WIDGET_MAX_JOBS);
    return { shown, hidden: jobs.length - shown.length };
}

export function resultFallback(body: string, theme: Theme, isError: boolean): Text {
    const mark = statusText(theme, isError ? "failed" : "done");
    return new Text(`\n${mark} ${theme.fg(isError ? "error" : "toolOutput", body || "(no output)")}`, 0, 0);
}

export function moreLines(theme: Theme, hidden: number): string {
    return theme.fg("muted", `… ${hidden} more lines, `) + keyHint("app.tools.expand", "to expand");
}

export function appendOutput(container: Container, body: string, expanded: boolean, theme: Theme): void {
    const { shown, hidden } = outputPreview(body, expanded ? Infinity : COLLAPSED_OUTPUT_LINES);
    container.addChild(new Markdown(shown.join("\n"), 0, 0, getMarkdownTheme()));
    if (hidden > 0) container.addChild(new Text(moreLines(theme, hidden), 0, 0));
}

export function toolLayout(
    toolName: string,
    identity: string,
    payload: string,
    theme: Theme,
    expanded: boolean,
): Component {
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
            const { shown, hidden } = capLines(body.render(width), expanded ? Infinity : COLLAPSED_OUTPUT_LINES);
            return hidden ? [...shown, truncateToWidth(moreLines(theme, hidden), width)] : shown;
        },
        invalidate: () => body.invalidate(),
    });
    return container;
}

export function resultHeader(
    theme: Theme,
    job: { id: string; agent: string },
    tail: string,
    outcome: JobStatus = "done",
): string {
    return `${statusText(theme, outcome)} ${jobIdentity(theme, job)} ${theme.fg("muted", tail)}`;
}

export function jobSummary(job: {
    description: string;
    contextTokens?: number;
    contextWindow?: number;
    elapsedMs: number;
}): string {
    return `${job.description} ${usageStats(job, job.elapsedMs)}`;
}

export function launchResult(
    details: DelegateDetails,
    body: string,
    status: string,
    expanded: boolean,
    theme: Theme,
): Component {
    const container = new Container();
    // The mark is the call's outcome (launch succeeded); job progress stays in the widget and report.
    container.addChild(new Text(`\n${resultHeader(theme, details, status)}`, 0, 0));
    // The call body already carries the task; only the launch metadata is new here.
    if (expanded)
        container.addChild(
            new Text(theme.fg("muted", launchDetails({ model: details.model, tools: details.tools }).join("\n")), 0, 0),
        );
    // Background results arrive as their own message; headless runs still show the output here.
    if (!details.background && body) appendOutput(container, body, expanded, theme);
    return container;
}

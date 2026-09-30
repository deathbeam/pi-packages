/** Formatting helpers stay runtime Pi-import-free for the native check; Pi's analogous formatters are private. */
import type { Theme } from "@earendil-works/pi-coding-agent";

export type JobStatus = "running" | "done" | "failed" | "cancelled";
export type UsageInfo = {
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
};

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 100;
export const STATUS_ICONS = {
    done: "✓",
    failed: "✗",
    cancelled: "✗",
} as const satisfies Record<Exclude<JobStatus, "running">, string>;
export const STATUS_COLORS = {
    running: "warning",
    done: "success",
    failed: "error",
    cancelled: "muted",
} as const satisfies Record<JobStatus, string>;
/** Pi slices extension widgets at ten lines and appends its own truncation note. */
export const WIDGET_MAX_LINES = 10;
/** Only a few jobs still fit with their tool-call and tool-result lines: 1 tally + 3*3 lines. */
const WIDGET_MAX_DETAIL_JOBS = 3;
/** In bulk, one row per job: 1 tally + 8 rows + 1 "more running" footer. */
const WIDGET_MAX_JOBS = 8;
export const COLLAPSED_OUTPUT_LINES = 10;
export const MAX_OUTPUT_BYTES = 50 * 1024;
const EXPANDED_PAD = "  ";

/** Terminal statuses have static icons; running jobs use statusIcon's clock-driven frame. */
export function statusIcon(status: JobStatus, now = Date.now()): string {
    return status === "running"
        ? SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!
        : STATUS_ICONS[status];
}

export function statusText(theme: Theme, status: JobStatus, now = Date.now()): string {
    return theme.fg(STATUS_COLORS[status], statusIcon(status, now));
}

export function jobIdentity(theme: Theme, job: { id: string; agent: string }): string {
    return `${theme.fg("muted", job.id)} ${theme.fg("toolTitle", theme.bold(job.agent))}`;
}

export function formatTools(tools: string[]): string {
    return tools.join(", ") || "none";
}

export function formatTokens(count: number): string {
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
            return value("file_path") || value("path");
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

/** Close dangling Markdown fences so collapsed previews render correctly. */
export function outputPreview(text: string, maxLines = COLLAPSED_OUTPUT_LINES): { shown: string[]; hidden: number } {
    const lines = text.trim().split("\n");
    if (lines.length <= maxLines) return { shown: lines, hidden: 0 };
    const shown = lines.slice(0, maxLines);
    if (shown.filter((line) => line.trimStart().startsWith("```")).length % 2 === 1) shown.push("```");
    return { shown, hidden: lines.length - maxLines };
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

export function reportText(report: DelegateReport): string {
    if (report.error) return `Delegated agent "${report.agent}" (job ${report.id}) failed: ${report.error}`;
    const output = (report.output ?? "").trim();
    return `Delegated agent "${report.agent}" (job ${report.id}) finished.${output ? `\n\n${output}` : ""}`;
}

export function jobLine(info: { description?: string } & UsageInfo, elapsedMs: number): string {
    return [info.description?.trim(), usageStats(info, elapsedMs)].filter(Boolean).join(" · ");
}

/** Omit detail rows in bulk so Pi's ten-line widget cap cannot split jobs. */
export function widgetJobs<T>(jobs: T[]): { shown: T[]; hidden: number; detail: boolean } {
    const detail = jobs.length <= WIDGET_MAX_DETAIL_JOBS;
    const shown = detail ? jobs : jobs.slice(-WIDGET_MAX_JOBS);
    return { shown, hidden: jobs.length - shown.length, detail };
}

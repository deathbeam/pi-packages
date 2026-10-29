/** /usage — fullscreen token usage and cost dashboard, grouped by provider, model, or project. */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
    bucketCosts,
    buildRows,
    collectUsage,
    dailyCosts,
    summarize,
    type GroupMode,
    type GroupRow,
    type Stats,
    type UsageRecord,
} from "./usage.ts";

type Column = { label: string; width: number; cell: (stats: Stats, requests: number, totalCost: number) => string };
type BodyRow = { name: string; stats: Stats; requests: number; dim: boolean };

const PERIODS = [
    { label: "Today", days: 1 },
    { label: "7d", days: 7 },
    { label: "30d", days: 30 },
    { label: "All", days: Infinity },
] as const;

const GROUPS = ["provider", "model", "project"] as const satisfies readonly GroupMode[];
const GROUP_LABELS: Record<GroupMode, string> = { provider: "Provider", model: "Model", project: "Project" };
const NAME_HEADERS: Record<GroupMode, string> = {
    provider: "Provider / Model",
    model: "Model",
    project: "Project",
};

const COLUMNS: Column[] = [
    { label: "Cost", width: 10, cell: (s) => formatCost(s.cost) },
    {
        label: "Share",
        width: 13,
        cell: (s, _r, totalCost) => {
            const share = totalCost > 0 ? s.cost / totalCost : 0;
            const filled = Math.round(8 * share);
            return "█".repeat(filled) + "·".repeat(8 - filled) + " " + `${Math.round(100 * share)}%`.padStart(4);
        },
    },
    { label: "Reqs", width: 6, cell: (_s, requests) => formatTokens(requests) },
    { label: "In", width: 7, cell: (s) => formatTokens(s.input) },
    { label: "Out", width: 7, cell: (s) => formatTokens(s.output) },
    // Cost already prices read/write differently; one combined token column is enough.
    { label: "Cache", width: 7, cell: (s) => formatTokens(s.cacheRead + s.cacheWrite) },
    { label: "Hit%", width: 5, cell: (s) => hitPct(s) },
];

const SPARK_BARS = "▁▂▃▄▅▆▇█";
const MIN_NAME_WIDTH = 12;

function formatCost(cost: number): string {
    if (cost === 0) return "-";
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    if (cost < 100) return `$${cost.toFixed(2)}`;
    return `$${Math.round(cost).toLocaleString("en-US")}`;
}

function formatTokens(count: number): string {
    if (count === 0) return "-";
    if (count < 1000) return String(count);
    if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
    if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    return `${(count / 1_000_000_000).toFixed(1)}B`;
}

/** Start of the `days`-day window ending today; 0 for All. */
function periodStart(days: number): number {
    if (days === Infinity) return 0;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    return start.getTime();
}

function hitPct(stats: Stats): string {
    const total = stats.input + stats.cacheRead + stats.cacheWrite;
    return total > 0 ? `${Math.round((100 * stats.cacheRead) / total)}%` : "-";
}

/** Widths fit the worst case ($999,999 / 999.9B); the name column shrinks first, then Share, then Hit%. */
function layout(width: number): { nameWidth: number; columns: Column[] } {
    const used = (cols: Column[]) => cols.reduce((sum, c) => sum + c.width + 1, 0);
    let columns = COLUMNS;
    if (width - used(columns) < MIN_NAME_WIDTH) columns = columns.filter((c) => c.label !== "Share");
    if (width - used(columns) < MIN_NAME_WIDTH) columns = columns.filter((c) => c.label !== "Hit%");
    return { nameWidth: Math.max(4, width - used(columns)), columns };
}

const padWidth = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

function displayName(mode: GroupMode, name: string): string {
    if (mode !== "project") return name;
    if (!name) return "(no cwd)";
    const home = homedir();
    return name === home || name.startsWith(home + "/") ? "~" + name.slice(home.length) : name;
}

/** Truncate a name to its column so ANSI codes and padding stay width-correct. */
function fitLabel(name: string, nameWidth: number): string {
    return visibleWidth(name) > nameWidth ? truncateToWidth(name, nameWidth, "…") : name;
}

function tableLine(
    nameWidth: number,
    columns: Column[],
    name: string,
    stats: Stats,
    requests: number,
    totalCost: number,
): string {
    const label = fitLabel(name, nameWidth);
    return [padWidth(label, nameWidth), ...columns.map((c) => padWidth(c.cell(stats, requests, totalCost), c.width))]
        .join(" ")
        .trimEnd();
}

/** Daily-cost sparkline `MM-DD ▁▂▃ MM-DD`: the whole period, downsampled to fit `width`. */
function sparkline(
    records: UsageRecord[],
    days: number,
    width: number,
): { first: string; bars: string; last: string } | undefined {
    if (days === 1) return undefined;
    let dayCount = days;
    if (days === Infinity) {
        let first = Infinity;
        for (const record of records) if (record.ts < first) first = record.ts;
        if (first === Infinity) return undefined;
        const firstDay = new Date(first);
        firstDay.setHours(0, 0, 0, 0);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        dayCount = Math.max(1, Math.round((today.getTime() - firstDay.getTime()) / 86_400_000) + 1);
    }
    const daily = dailyCosts(records, dayCount);
    const first = daily[0]!.label;
    const last = daily[daily.length - 1]!.label;
    // Two MM-DD labels and two spaces around the bars leave width - 12 columns of bars.
    const bars = bucketCosts(daily, Math.ceil(dayCount / Math.max(1, width - 12)));
    let max = 0;
    for (const bar of bars) if (bar.cost > max) max = bar.cost;
    if (max <= 0) return undefined;
    return {
        first,
        bars: bars.map((d) => (d.cost <= 0 ? " " : SPARK_BARS[Math.max(1, Math.round((7 * d.cost) / max))])).join(""),
        last,
    };
}

function flatten(rows: GroupRow[], mode: GroupMode): BodyRow[] {
    const body: BodyRow[] = [];
    for (const row of rows) {
        body.push({ name: displayName(mode, row.name), stats: row.stats, requests: row.requests, dim: false });
        for (const child of row.children ?? [])
            body.push({ name: `  ${child.name}`, stats: child.stats, requests: child.requests, dim: true });
    }
    return body;
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("usage", {
        description: "Show token usage and cost per provider, model, or project",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") return;
            const state: { records?: UsageRecord[]; done: number; total: number } = {
                done: 0,
                total: 0,
            };
            let render = () => {};
            // Scanning on open is fast enough for a dashboard; no cache file.
            const loaded = collectUsage(join(getAgentDir(), "sessions"), (done, total) => {
                state.done = done;
                state.total = total;
                render();
            }).then((records) => {
                state.records = records;
            });
            const screen = {
                overlay: true,
                overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0 },
            } as const;
            await ctx.ui.custom((tui, theme, keys, done) => {
                let period = 0;
                let group = 0;
                let cursor = 0;
                let top = 0;
                let rowCount = 0;
                let viewHeight = 1; // set on first render; 1 keeps page keys sane before it
                render = () => tui.requestRender();
                void loaded.then(render);
                const title = (width: number): string => {
                    const tab = (label: string, active: boolean) =>
                        active ? theme.fg("accent", `[${label}]`) : theme.fg("muted", ` ${label} `);
                    const periodTabs = PERIODS.map(({ label }, i) => tab(label, i === period)).join(" ");
                    const groupTabs = GROUPS.map((g, i) => tab(GROUP_LABELS[g], i === group)).join(" ");
                    const periodHint = theme.fg("dim", " (tab/←→)");
                    const groupHint = theme.fg("dim", " (v)");
                    let left = `${theme.fg("accent", theme.bold("Usage"))}  ${periodTabs}${periodHint}`;
                    let right = `${groupTabs}${groupHint}`;
                    // Drop the key hints before the tabs, so the right-hand tabs survive truncation.
                    if (visibleWidth(left) + 1 + visibleWidth(right) > width) {
                        left = left.replace(periodHint, "");
                        right = right.replace(groupHint, "");
                    }
                    const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
                    return truncateToWidth(left + " ".repeat(pad) + right, width);
                };
                const footer = (width: number): string =>
                    truncateToWidth(theme.fg("dim", "↑↓ scroll · tab period · v group · q close"), width);
                return {
                    render(width: number) {
                        const rows = tui.terminal.rows;
                        const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
                        const lines: string[] = [title(width), rule];
                        if (!state.records) {
                            const barWidth = Math.max(10, Math.min(40, width - 30));
                            const filled = state.total ? Math.round((state.done / state.total) * barWidth) : 0;
                            lines.push(
                                truncateToWidth(
                                    `${theme.fg("muted", "Scanning ")}${theme.fg("accent", "█".repeat(filled))}${theme.fg("borderMuted", "·".repeat(barWidth - filled))} ${state.done}/${state.total} files`,
                                    width,
                                ),
                            );
                            lines.push(rule, footer(width));
                            return lines.slice(0, rows);
                        }
                        const since = periodStart(PERIODS[period].days);
                        const mode = GROUPS[group]!;
                        const summary = summarize(state.records, since);
                        lines.push(
                            `Cost ${formatCost(summary.stats.cost)} · Reqs ${formatTokens(summary.requests)} · Sessions ${formatTokens(summary.sessions)}`,
                            `In ${formatTokens(summary.stats.input)} · Out ${formatTokens(summary.stats.output)} · Cache ${formatTokens(summary.stats.cacheRead + summary.stats.cacheWrite)} · Hit ${hitPct(summary.stats)}`,
                        );
                        const spark = sparkline(state.records, PERIODS[period].days, width);
                        if (spark)
                            lines.push(
                                truncateToWidth(
                                    `${theme.fg("dim", `${spark.first} `)}${theme.fg("accent", spark.bars)}${theme.fg("dim", ` ${spark.last}`)}`,
                                    width,
                                ),
                            );
                        const { nameWidth, columns } = layout(width);
                        lines.push(
                            theme.fg(
                                "muted",
                                [
                                    padWidth(fitLabel(NAME_HEADERS[mode], nameWidth), nameWidth),
                                    ...columns.map((c) => padWidth(c.label, c.width)),
                                ]
                                    .join(" ")
                                    .trimEnd(),
                            ),
                        );
                        // Fixed top: title, rule, summary, sparkline, column header. Fixed bottom: totals, rule, footer.
                        const body = flatten(buildRows(state.records, since, mode), mode);
                        rowCount = body.length;
                        viewHeight = Math.max(0, rows - lines.length - 3);
                        cursor = Math.min(cursor, Math.max(0, rowCount - 1));
                        top = Math.max(0, Math.min(top, rowCount - viewHeight));
                        if (cursor < top) top = cursor;
                        if (viewHeight > 0 && cursor >= top + viewHeight) top = cursor - viewHeight + 1;
                        const visible = body.slice(top, top + viewHeight);
                        if (rowCount === 0) lines.push(theme.fg("dim", "  No usage in this period"));
                        for (const [i, row] of visible.entries()) {
                            let line = tableLine(
                                nameWidth,
                                columns,
                                row.name,
                                row.stats,
                                row.requests,
                                summary.stats.cost,
                            );
                            if (top + i === cursor) line = theme.bg("selectedBg", line);
                            else if (row.dim) line = theme.fg("dim", line);
                            lines.push(visibleWidth(line) > width ? truncateToWidth(line, width) : line);
                        }
                        lines.push(
                            theme.bold(
                                tableLine(
                                    nameWidth,
                                    columns,
                                    "Total",
                                    summary.stats,
                                    summary.requests,
                                    summary.stats.cost,
                                ),
                            ),
                            rule,
                            footer(width),
                        );
                        return lines.slice(0, rows);
                    },
                    invalidate() {},
                    handleInput(data: string) {
                        if (keys.matches(data, "tui.select.cancel") || data === "q") {
                            done(undefined);
                            return;
                        }
                        if (matchesKey(data, "tab") || matchesKey(data, "right"))
                            period = (period + 1) % PERIODS.length;
                        else if (matchesKey(data, "shift+tab") || matchesKey(data, "left"))
                            period = (period + PERIODS.length - 1) % PERIODS.length;
                        else if (data === "v") group = (group + 1) % GROUPS.length;
                        else if (keys.matches(data, "tui.select.up") || data === "k") cursor -= 1;
                        else if (keys.matches(data, "tui.select.down") || data === "j") cursor += 1;
                        else if (matchesKey(data, "pageUp")) cursor -= Math.max(1, viewHeight);
                        else if (matchesKey(data, "pageDown")) cursor += Math.max(1, viewHeight);
                        else if (matchesKey(data, "home") || data === "g") cursor = 0;
                        else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) cursor = rowCount - 1;
                        else return;
                        cursor = Math.max(0, Math.min(rowCount - 1, cursor));
                        tui.requestRender();
                    },
                };
            }, screen);
        },
    });
}

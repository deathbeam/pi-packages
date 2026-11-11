/** /usage — fullscreen token usage and cost dashboard. */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
    bucketCosts,
    buildDailySeries,
    buildRows,
    cacheView,
    clearTimeFilters,
    collectUsage,
    dayKey,
    isTimeFilter,
    isTimeMode,
    matchesFilter,
    percentChange,
    previousSummary,
    seriesKey,
    stepFilter,
    summarize,
    usageWindow,
    type DailyCost,
    type GroupMode,
    type GroupRow,
    type Stats,
    type UsageFilter,
    type UsageRecord,
} from "./usage.ts";

type Column = {
    label: string;
    width: number;
    cell: (stats: Stats, requests: number, totalCost: number, row?: GroupRow) => string;
};
type BodyRow = GroupRow & { parent?: string };
type Frame = { filters: UsageFilter[]; group: number; cursor: number; top: number };

const PERIODS = [
    { label: "Today", days: 1 },
    { label: "7d", days: 7 },
    { label: "30d", days: 30 },
    { label: "All", days: Infinity },
] as const;

const GROUPS = ["provider", "model", "project", "day", "week", "month"] as const satisfies readonly GroupMode[];
const GROUP_LABELS: Record<GroupMode, string> = {
    provider: "Provider",
    model: "Model",
    project: "Project",
    day: "Day",
    week: "Week",
    month: "Month",
};

const COLUMNS: Column[] = [
    {
        label: "Cost",
        width: 10,
        cell: (s, _r, _t, row) => formatCost(s.cost, row?.perDay !== undefined),
    },
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

function formatCost(cost: number, showZero = false): string {
    if (cost === 0) return showZero ? "$0.00" : "-";
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

function hitPct(stats: Stats): string {
    const total = stats.input + stats.cacheRead + stats.cacheWrite;
    return total > 0 ? `${Math.round((100 * stats.cacheRead) / total)}%` : "-";
}

function layout(width: number, allColumns: Column[]): { nameWidth: number; columns: Column[] } {
    const used = (cols: Column[]) => cols.reduce((sum, c) => sum + c.width + 1, 0);
    let columns = allColumns;
    for (const label of ["Share", "Hit%", "Cache", "Out", "In", "Reqs", "Δ", "/day"]) {
        if (width - used(columns) >= MIN_NAME_WIDTH) break;
        columns = columns.filter((c) => c.label !== label);
    }
    return { nameWidth: Math.max(4, width - used(columns)), columns };
}

const padWidth = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

function displayName(mode: GroupMode, name: string): string {
    if (mode === "day") return `${name} ${new Date(`${name}T00:00`).toLocaleDateString("en-US", { weekday: "short" })}`;
    if (mode === "week") return `${name} wk`;
    if (mode === "month")
        return `${name} ${new Date(`${name}-01T00:00`).toLocaleDateString("en-US", { month: "short" })}`;
    if (mode !== "project") return name;
    if (!name) return "(no cwd)";
    const home = homedir();
    return name === home || name.startsWith(home + "/") ? "~" + name.slice(home.length) : name;
}

/** Truncate a name to its column so ANSI codes and padding stay width-correct. */
function fitLabel(name: string, nameWidth: number): string {
    return visibleWidth(name) > nameWidth ? truncateToWidth(name, nameWidth, "…") : name;
}

function tableLine(nameWidth: number, columns: Column[], row: GroupRow, totalCost: number): string {
    const label = fitLabel(row.name, nameWidth);
    return [
        padWidth(label, nameWidth),
        ...columns.map((c) => padWidth(fitLabel(c.cell(row.stats, row.requests, totalCost, row), c.width), c.width)),
    ]
        .join(" ")
        .trimEnd();
}

function sparkline(daily: DailyCost[], width: number): { first: string; bars: string; last: string } | undefined {
    if (daily.length <= 1) return undefined;
    const first = daily[0]!.label;
    const last = daily[daily.length - 1]!.label;
    const bars = bucketCosts(daily, Math.ceil(daily.length / Math.max(1, width - 12)));
    let max = 0;
    for (const bar of bars) if (bar.cost > max) max = bar.cost;
    return {
        first,
        bars: bars.map((d) => (d.cost <= 0 ? " " : SPARK_BARS[Math.max(1, Math.round((7 * d.cost) / max))])).join(""),
        last,
    };
}

function flatten(rows: GroupRow[], mode: GroupMode): BodyRow[] {
    const body: BodyRow[] = [];
    for (const row of rows) {
        body.push({ ...row, name: displayName(mode, row.name) });
        for (const child of row.children ?? []) body.push({ ...child, name: `  ${child.name}`, parent: row.key });
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
                let body: BodyRow[] = [];
                const stack: Frame[] = [];
                const filters = () => stack.flatMap((frame) => frame.filters);
                const timeIsInnermost = () => isTimeFilter(filters().at(-1));
                const derive = (source: UsageRecord[]) => {
                    const active = filters();
                    const records = source.filter((record) =>
                        active.every((f) => isTimeMode(f.mode) || matchesFilter(record, f)),
                    );
                    const window = usageWindow(records, PERIODS[period].days, active);
                    const mode = GROUPS[group]!;
                    const summary = summarize(records, window.since, window.until);
                    const compare =
                        window.days > 0 &&
                        (active.some((f) => isTimeMode(f.mode)) || PERIODS[period].days !== Infinity);
                    const previous = compare ? previousSummary(records, window.since, window.days) : undefined;
                    const body = flatten(buildRows(records, window.since, mode, window.until), mode);
                    const series = buildDailySeries(records, window.since, window.until, mode, body);
                    return { records, window, mode, summary, previous, body, series };
                };
                const getView = cacheView(() => derive(state.records!));
                const changePeriod = (offset: number) => {
                    period = (period + offset + PERIODS.length) % PERIODS.length;
                    clearTimeFilters(stack);
                    cursor = top = 0;
                };
                render = () => tui.requestRender();
                void loaded.then(render);
                const colorDelta = (delta: number | undefined): string => {
                    if (delta === undefined) return "-";
                    if (delta === 0) return "0%";
                    const text = Number.isFinite(delta)
                        ? `${delta > 0 ? "▲" : "▼"}${Math.round(Math.abs(delta))}%`
                        : "▲new";
                    return theme.fg(delta > 0 ? "error" : "success", text);
                };
                const timeColumns: Column[] = [
                    {
                        label: "/day",
                        width: 10,
                        cell: (_s, _r, _t, row) => (row?.perDay === undefined ? "-" : formatCost(row.perDay, true)),
                    },
                    { label: "Δ", width: 9, cell: (_s, _r, _t, row) => colorDelta(row?.delta) },
                ];
                const title = (width: number): string => {
                    const tab = (label: string, active: boolean) =>
                        active ? theme.fg("accent", `[${label}]`) : theme.fg("muted", ` ${label} `);
                    const left = stack.length
                        ? theme.fg("accent", theme.bold("Usage")) +
                          " › " +
                          [PERIODS[period].label, ...filters().map((f) => displayName(f.mode, f.key))].join(" › ")
                        : `${theme.fg("accent", theme.bold("Usage"))}  ${PERIODS.map(({ label }, i) => tab(label, i === period)).join(" ")}`;
                    const right = GROUPS.map((g, i) => tab(GROUP_LABELS[g], i === group)).join(" ");
                    const leftWidth = Math.max(0, width - visibleWidth(right) - 1);
                    return truncateToWidth(
                        truncateToWidth(left, leftWidth, "…") +
                            " ".repeat(
                                Math.max(1, width - Math.min(visibleWidth(left), leftWidth) - visibleWidth(right)),
                            ) +
                            right,
                        width,
                    );
                };
                const footer = (width: number): string =>
                    truncateToWidth(
                        theme.fg(
                            "dim",
                            `enter open · esc back · v group · tab period · ←→ ${timeIsInnermost() ? "bucket" : "period"} · q close · ↑↓ scroll`,
                        ),
                        width,
                    );
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
                        const view = getView(period, GROUPS[group]!, filters());
                        const { window, mode, summary, previous, series } = view;
                        const label =
                            window.days === 1 && dayKey(window.since) === dayKey(Date.now())
                                ? "yesterday"
                                : `prev ${window.days}d`;
                        const trend = previous
                            ? ` ${colorDelta(percentChange(summary.stats.cost, previous.stats.cost))} vs ${label}`
                            : "";
                        lines.push(
                            truncateToWidth(
                                `Cost ${formatCost(summary.stats.cost)}${trend} · ${formatCost(window.days ? summary.stats.cost / window.days : 0)}/day · Reqs ${formatTokens(summary.requests)} · Sessions ${formatTokens(summary.sessions)}`,
                                width,
                            ),
                            truncateToWidth(
                                `In ${formatTokens(summary.stats.input)} · Out ${formatTokens(summary.stats.output)} · Cache ${formatTokens(summary.stats.cacheRead + summary.stats.cacheWrite)} · Hit ${hitPct(summary.stats)}`,
                                width,
                            ),
                        );
                        body = view.body;
                        rowCount = body.length;
                        cursor = Math.min(cursor, Math.max(0, rowCount - 1));
                        const selected = body[cursor];
                        const daily = selected
                            ? (series.rows.get(seriesKey(selected.key, selected.parent)) ?? series.total)
                            : series.total;
                        const spark = sparkline(daily, width);
                        if (spark)
                            lines.push(
                                truncateToWidth(
                                    `${theme.fg("dim", `${spark.first} `)}${theme.fg("accent", spark.bars)}${theme.fg("dim", ` ${spark.last}`)}`,
                                    width,
                                ),
                            );
                        const { nameWidth, columns } = layout(
                            width,
                            isTimeMode(mode) ? [COLUMNS[0]!, ...timeColumns, ...COLUMNS.slice(1)] : COLUMNS,
                        );
                        const header = mode === "provider" ? "Provider / Model" : GROUP_LABELS[mode];
                        lines.push(
                            theme.fg(
                                "muted",
                                [
                                    padWidth(fitLabel(header, nameWidth), nameWidth),
                                    ...columns.map((c) => padWidth(c.label, c.width)),
                                ]
                                    .join(" ")
                                    .trimEnd(),
                            ),
                        );
                        // Fixed top: title, rule, summary, sparkline, column header. Fixed bottom: totals, rule, footer.
                        viewHeight = Math.max(0, rows - lines.length - 3);
                        top = Math.max(0, Math.min(top, rowCount - viewHeight));
                        if (cursor < top) top = cursor;
                        if (viewHeight > 0 && cursor >= top + viewHeight) top = cursor - viewHeight + 1;
                        const visible = body.slice(top, top + viewHeight);
                        if (rowCount === 0) lines.push(theme.fg("dim", "  No usage in this period"));
                        for (const [i, row] of visible.entries()) {
                            let line = tableLine(nameWidth, columns, row, summary.stats.cost);
                            if (top + i === cursor) line = theme.bg("selectedBg", line);
                            else if (row.parent !== undefined) line = theme.fg("dim", line);
                            lines.push(line);
                        }
                        const total = { key: "", name: "Total", stats: summary.stats, requests: summary.requests };
                        lines.push(
                            theme.bold(tableLine(nameWidth, columns, total, summary.stats.cost)),
                            rule,
                            footer(width),
                        );
                        return lines
                            .slice(0, rows)
                            .map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
                    },
                    invalidate() {},
                    handleInput(data: string) {
                        if (data === "q") {
                            done(undefined);
                            return;
                        } else if (keys.matches(data, "tui.select.cancel")) {
                            const frame = stack.pop();
                            if (!frame) {
                                done(undefined);
                                return;
                            }
                            ({ group, cursor, top } = frame);
                            tui.requestRender();
                            return;
                        } else if (keys.matches(data, "tui.select.confirm") && body[cursor]) {
                            const row = body[cursor]!;
                            const rowMode = row.parent === undefined ? GROUPS[group]! : "model";
                            const selected: UsageFilter[] =
                                row.parent === undefined ? [] : [{ mode: "provider", key: row.parent }];
                            selected.push({ mode: rowMode, key: row.key });
                            stack.push({ filters: selected, group, cursor, top });
                            group = isTimeMode(rowMode) ? 0 : GROUPS.indexOf("day");
                            cursor = top = 0;
                        } else if ((matchesKey(data, "right") || matchesKey(data, "left")) && timeIsInnermost()) {
                            const active = filters();
                            const next = stepFilter(active, matchesKey(data, "right") ? 1 : -1);
                            if (next !== undefined) active.at(-1)!.key = next;
                        } else if (matchesKey(data, "tab") || matchesKey(data, "right")) {
                            changePeriod(1);
                        } else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
                            changePeriod(-1);
                        } else if (data === "v") {
                            group = (group + 1) % GROUPS.length;
                            cursor = top = 0;
                        } else if (keys.matches(data, "tui.select.up") || data === "k") cursor -= 1;
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

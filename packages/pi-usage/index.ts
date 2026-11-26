/** /usage — fullscreen token usage and cost dashboard. */

import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import {
    clip,
    deltaText,
    displayName,
    fitLabel,
    formatCost,
    formatTokens,
    hitPct,
    padWidth,
    shareBar,
} from "./src/format.ts";
import { summaryLines, summaryModel, type SummaryModel } from "./src/summary.ts";
import {
    buildRows,
    cacheView,
    collectUsage,
    dailyTotals,
    dayKey,
    dayWindow,
    matchesFilter,
    summarize,
    usageWindow,
    type DailyCost,
    type GroupMode,
    type GroupRow,
    type Stats,
    type Summary,
    type UsageFilter,
    type UsageRecord,
} from "./src/usage.ts";

type Column = {
    label: string;
    width: number;
    cell: (stats: Stats, requests: number, totalCost: number, row: GroupRow | undefined, theme: Theme) => string;
};
type BodyRow = GroupRow & { parent?: string };
type Frame = { filters: UsageFilter[]; group: number; cursor: number; top: number };
type SparkBar = { label: string; char: string };
type ViewMode = "summary" | GroupMode;
type TableView = { mode: GroupMode; summary: Summary; body: BodyRow[] };
type SummaryView = { mode: "summary"; model: SummaryModel };

const GROUPS = ["day", "provider", "model", "project"] as const satisfies readonly GroupMode[];
/** Tab order; Summary is a view, not a grouping, so it has no rows to open. */
const VIEWS: readonly ViewMode[] = ["summary", ...GROUPS];
const GROUP_LABELS: Record<GroupMode, string> = {
    day: "Day",
    provider: "Provider",
    model: "Model",
    project: "Project",
};
const VIEW_LABELS: Record<ViewMode, string> = { summary: "Summary", ...GROUP_LABELS };

const COLUMNS: Column[] = [
    {
        label: "Cost",
        width: 10,
        cell: (s) => formatCost(s.cost),
    },
    {
        label: "Share",
        width: 13,
        cell: (s, _r, totalCost, _row, theme) => shareBar(s.cost, totalCost, theme),
    },
    { label: "Reqs", width: 6, cell: (_s, requests) => formatTokens(requests) },
    { label: "In", width: 7, cell: (s) => formatTokens(s.input) },
    { label: "Out", width: 7, cell: (s) => formatTokens(s.output) },
    // Cost already prices read/write differently; one combined token column is enough.
    { label: "Cache", width: 7, cell: (s) => formatTokens(s.cacheRead + s.cacheWrite) },
    { label: "Hit%", width: 5, cell: (s, _r, _t, _row, theme) => hitPct(s, theme) },
];

const SPARK_BARS = "▁▂▃▄▅▆▇█";
const MIN_NAME_WIDTH = 12;
/** Columns the title keeps beside the tab bar; the rest goes to the tabs around the active one. */
const TITLE_WIDTH = 8;

function layout(width: number, allColumns: Column[]): { nameWidth: number; columns: Column[] } {
    function used(cols: Column[]): number {
        return cols.reduce((sum, c) => sum + c.width + 1, 0);
    }
    let columns = allColumns;
    for (const label of ["Share", "Hit%", "Cache", "Out", "In", "Reqs", "Δ"]) {
        if (width - used(columns) >= MIN_NAME_WIDTH) break;
        columns = columns.filter((c) => c.label !== label);
    }
    return { nameWidth: Math.max(4, width - used(columns)), columns };
}

function tableLine(nameWidth: number, columns: Column[], row: GroupRow, totalCost: number, theme: Theme): string {
    const label = fitLabel(row.name, nameWidth);
    return [
        padWidth(label, nameWidth),
        ...columns.map((c) =>
            padWidth(fitLabel(c.cell(row.stats, row.requests, totalCost, row, theme), c.width), c.width),
        ),
    ]
        .join(" ")
        .trimEnd();
}

function sparkline(daily: DailyCost[], width: number): { first: string; last: string; bars: SparkBar[] } | undefined {
    const recent = daily.slice(-Math.max(1, width - 12));
    if (recent.length === 0) return undefined;
    let max = 0;
    for (const day of recent) if (day.cost > max) max = day.cost;
    return {
        first: recent[0]!.label,
        last: recent[recent.length - 1]!.label,
        bars: recent.map(({ label, cost }) => ({
            label,
            char: cost <= 0 ? " " : SPARK_BARS[Math.max(1, Math.round((7 * cost) / max))]!,
        })),
    };
}

function flatten(rows: GroupRow[], mode: GroupMode, theme: Theme): BodyRow[] {
    const body: BodyRow[] = [];
    for (const row of rows) {
        body.push({ ...row, name: displayName(mode, row.name, theme) });
        for (const child of row.children ?? []) body.push({ ...child, name: `  ${child.name}`, parent: row.key });
    }
    return body;
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("usage", {
        description: "Show token usage and cost: summary, day, provider, model and project views",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") return;
            const state: { records?: UsageRecord[]; done: number; total: number } = {
                done: 0,
                total: 0,
            };
            let render = () => {};
            const agentDir = getAgentDir();
            // getSessionDir() is this project's encoded-cwd dir under the default layout; count every project.
            // shortcut: a custom dir named like --x-- reads as the default layout, use usesDefaultSessionDir() once it is exposed
            const projectDir = ctx.sessionManager.getSessionDir();
            const sessionDir = basename(projectDir).startsWith("-") ? dirname(projectDir) : projectDir;
            const abort = new AbortController();
            const loaded = collectUsage(
                sessionDir,
                (done, total) => {
                    state.done = done;
                    state.total = total;
                    render();
                },
                join(agentDir, "usage-cache.json"),
                abort.signal,
            ).then((records) => {
                state.records = records;
            });
            const screen = {
                overlay: true,
                overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0 },
            } as const;
            await ctx.ui.custom((tui, theme, keys, done) => {
                let group = 0;
                let cursor = 0;
                let top = 0;
                let rowCount = 0;
                let viewHeight = 1; // set on first render; 1 keeps page keys sane before it
                let body: BodyRow[] = [];
                const stack: Frame[] = [];
                function filters() {
                    return stack.flatMap((frame) => frame.filters);
                }
                function dayFilter() {
                    return filters().findLast((f) => f.mode === "day");
                }
                function derive(source: UsageRecord[]): TableView | SummaryView {
                    const active = filters();
                    const records = source.filter((record) =>
                        active.every((f) => f.mode === "day" || matchesFilter(record, f)),
                    );
                    const day = active.findLast((f) => f.mode === "day")?.key;
                    const window = usageWindow(records, day);
                    const mode = VIEWS[group]!;
                    if (mode === "summary") {
                        const scoped = records.filter(
                            (record) => record.ts >= window.since && record.ts < window.until,
                        );
                        return { mode, model: summaryModel(scoped, day === undefined, Date.now(), window) };
                    }
                    const summary = summarize(records, window.since, window.until);
                    const body = flatten(buildRows(records, window.since, mode, window.until), mode, theme);
                    return { mode, summary, body };
                }
                const getView = cacheView(() => derive(state.records!));
                let allDays: DailyCost[] | undefined;
                function allDaily() {
                    return (allDays ??= dailyTotals(state.records!));
                }
                render = () => {
                    if (!abort.signal.aborted) tui.requestRender();
                };
                void loaded.then(render);
                function close() {
                    abort.abort();
                    done(undefined);
                }
                const deltaColumn: Column = {
                    label: "Δ",
                    width: 9,
                    cell: (_s, _r, _t, row, _theme) => deltaText(row?.delta, theme),
                };
                /** Tabs around the active one that fit `budget`; the active tab is never dropped. */
                function windowTabs(tabs: { text: string; active: boolean }[], budget: number): string[] {
                    const active = Math.max(
                        0,
                        tabs.findIndex((entry) => entry.active),
                    );
                    let lo = active;
                    let hi = active;
                    let used = visibleWidth(tabs[active]!.text);
                    while (true) {
                        const next = tabs[hi + 1];
                        const prev = tabs[lo - 1];
                        if (next !== undefined && used + 1 + visibleWidth(next.text) <= budget) {
                            hi += 1;
                            used += 1 + visibleWidth(next.text);
                        } else if (prev !== undefined && used + 1 + visibleWidth(prev.text) <= budget) {
                            lo -= 1;
                            used += 1 + visibleWidth(prev.text);
                        } else break;
                    }
                    return tabs.slice(lo, hi + 1).map((entry) => entry.text);
                }
                function title(width: number): string {
                    function tab(label: string, active: boolean): string {
                        return active ? theme.fg("accent", `[${label}]`) : theme.fg("muted", ` ${label} `);
                    }
                    const left =
                        theme.fg("accent", theme.bold("Usage")) +
                        filters()
                            .map((f) => ` › ${displayName(f.mode, f.key)}`)
                            .join("");
                    const tabs = VIEWS.map((g, i) => ({
                        text: g === "day" && dayFilter() ? "" : tab(VIEW_LABELS[g], i === group),
                        active: i === group,
                    })).filter((entry) => entry.text !== "");
                    const budget = Math.max(1, width - Math.min(visibleWidth(left), TITLE_WIDTH) - 1);
                    const shown = windowTabs(tabs, budget).join(" ");
                    const hint = theme.fg("dim", " (tab/←→)");
                    const right =
                        shown +
                        (visibleWidth(left) + visibleWidth(shown) + visibleWidth(hint) + 1 <= width ? hint : "");
                    const leftWidth = Math.max(0, width - visibleWidth(right) - 1);
                    return truncateToWidth(
                        truncateToWidth(left, leftWidth, "…") +
                            " ".repeat(
                                Math.max(1, width - Math.min(visibleWidth(left), leftWidth) - visibleWidth(right)),
                            ) +
                            right,
                        width,
                    );
                }
                function footer(width: number, mode?: ViewMode): string {
                    const parts = [
                        ...(mode !== undefined && mode !== "summary" ? ["enter open"] : []),
                        "esc back",
                        "tab/←→ view",
                        ...(dayFilter() ? ["[ ] day"] : []),
                        "q close",
                        "↑↓ scroll",
                    ];
                    return truncateToWidth(theme.fg("dim", parts.join(" · ")), width);
                }
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
                        const view = getView(VIEWS[group]!, filters());
                        if (view.mode === "summary") {
                            const content = summaryLines(view.model, width, theme);
                            body = [];
                            rowCount = content.length;
                            viewHeight = Math.max(1, rows - lines.length - 2);
                            // The summary has no cursor: its position is the scroll offset.
                            cursor = Math.max(0, Math.min(cursor, Math.max(0, rowCount - viewHeight)));
                            top = cursor;
                            lines.push(...content.slice(top, top + viewHeight), rule, footer(width, view.mode));
                            return clip(lines, width, rows);
                        }
                        const { mode, summary } = view;
                        lines.push(
                            truncateToWidth(
                                `Cost ${formatCost(summary.stats.cost)} · Reqs ${formatTokens(summary.requests)} · Sessions ${formatTokens(summary.sessions)} · Hit ${hitPct(summary.stats, theme)}`,
                                width,
                            ),
                        );
                        body = view.body;
                        rowCount = body.length;
                        cursor = Math.min(cursor, Math.max(0, rowCount - 1));
                        const selected = body[cursor];
                        const contextDay = dayFilter()?.key ?? (mode === "day" ? selected?.key : undefined);
                        const spark = sparkline(allDaily(), width);
                        if (spark)
                            lines.push(
                                truncateToWidth(
                                    theme.fg("dim", `${spark.first.slice(5)} `) +
                                        spark.bars
                                            .map((bar) =>
                                                theme.fg(
                                                    contextDay === undefined || bar.label === contextDay
                                                        ? "accent"
                                                        : "borderMuted",
                                                    bar.char,
                                                ),
                                            )
                                            .join("") +
                                        theme.fg("dim", ` ${spark.last.slice(5)}`),
                                    width,
                                ),
                            );
                        const { nameWidth, columns } = layout(
                            width,
                            mode === "day" ? [COLUMNS[0]!, deltaColumn, ...COLUMNS.slice(1)] : COLUMNS,
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
                        if (rowCount === 0) lines.push(theme.fg("dim", "  No usage"));
                        for (const [i, row] of visible.entries()) {
                            let line = tableLine(nameWidth, columns, row, summary.stats.cost, theme);
                            if (top + i === cursor) line = theme.bg("selectedBg", line);
                            else if (row.parent !== undefined) line = theme.fg("dim", line);
                            lines.push(line);
                        }
                        const total = { key: "", name: "Total", stats: summary.stats, requests: summary.requests };
                        lines.push(
                            theme.bold(tableLine(nameWidth, columns, total, summary.stats.cost, theme)),
                            rule,
                            footer(width, mode),
                        );
                        return clip(lines, width, rows);
                    },
                    invalidate() {},
                    handleInput(data: string) {
                        if (data === "q") {
                            close();
                            return;
                        } else if (keys.matches(data, "tui.select.cancel")) {
                            const frame = stack.pop();
                            if (!frame) {
                                close();
                                return;
                            }
                            ({ group, cursor, top } = frame);
                            tui.requestRender();
                            return;
                        } else if (keys.matches(data, "tui.select.confirm") && body[cursor]) {
                            const row = body[cursor]!;
                            const mode = VIEWS[group]!;
                            const rowMode = row.parent === undefined && mode !== "summary" ? mode : "model";
                            const selected: UsageFilter[] =
                                row.parent === undefined ? [] : [{ mode: "provider", key: row.parent }];
                            selected.push({ mode: rowMode, key: row.key });
                            stack.push({ filters: selected, group, cursor, top });
                            // Land on the first grouping that is not already filtered.
                            const used = new Set(filters().map((f) => f.mode));
                            group = VIEWS.findIndex((g) => g !== "summary" && !used.has(g));
                            if (group < 0) group = VIEWS.indexOf(dayFilter() ? "provider" : "day");
                            cursor = top = 0;
                        } else if ((data === "[" || data === "]") && filters().at(-1)?.mode === "day") {
                            const filter = filters().at(-1)!;
                            const next = dayKey(dayWindow(filter.key, data === "]" ? 1 : -1).since);
                            if (next <= dayKey(Date.now())) filter.key = next;
                        } else if (
                            matchesKey(data, "tab") ||
                            matchesKey(data, "right") ||
                            matchesKey(data, "shift+tab") ||
                            matchesKey(data, "left")
                        ) {
                            const offset = matchesKey(data, "tab") || matchesKey(data, "right") ? 1 : -1;
                            do group = (group + offset + VIEWS.length) % VIEWS.length;
                            while (VIEWS[group] === "day" && dayFilter());
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
                    // Fullscreen turns on mouse tracking, so the wheel arrives here instead of as arrow keys.
                    handleMouse(event: TuiMouseEvent) {
                        if (event.type !== "wheel" || !event.wheelDelta) return;
                        cursor = Math.max(0, Math.min(rowCount - 1, cursor + event.wheelDelta));
                        tui.requestRender();
                        return { handled: true };
                    },
                };
            }, screen);
        },
    });
}

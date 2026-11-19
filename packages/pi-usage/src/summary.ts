/** The Summary view: data model (totals, trends, streaks, calendar, top lists) and its layout. */

import { basename } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { deltaText, displayName, formatCost, formatTokens, hitPct, padWidth, topLine } from "./format.ts";
import {
    buildRows,
    comparison,
    dailyTotals,
    dayKey,
    percentChange,
    summarize,
    type DailyCost,
    type GroupMode,
    type GroupRow,
    type Stats,
    type TimeWindow,
    type UsageRecord,
} from "./usage.ts";

export type Streaks = { current: number; longest: number };

/** `level` is 0 for a day without usage and 1..4 for its cost on a log scale. */
export type HeatCell = { cost: number; level: number };

/** `rows[weekday][week]`, Monday first; a cell is undefined outside the recorded range. */
export type Heatmap = { header: string; rows: (HeatCell | undefined)[][] };

export type Trends = {
    today: number;
    /** Totals and per-day spend so far this week and this month, against the previous ones. */
    week: number;
    weekTotal: number;
    weekDelta: number;
    month: number;
    monthTotal: number;
    monthDelta: number;
    lastMonthTotal: number;
    /** This month's per-day average spread over every day of the month. */
    projection: number;
};

export type TopLists = {
    models: GroupRow[];
    providers: GroupRow[];
    projects: GroupRow[];
    sessions: GroupRow[];
};

/** Delegate child sessions and their share of the total cost, as a fraction. */
export type Delegates = { cost: number; share: number };

type Cell = { label: string; value: string };
type GridColumn = { label: number; width: number };
type TrendRow = { label: string; total: string; perDay?: string; delta?: string; suffix?: string; accent?: boolean };
type List = { title: string; mode?: GroupMode; rows: GroupRow[] };
type Section = { title: string; maxColumns: number; cells: (width: number) => Cell[] };

export type SummaryModel = {
    stats: Stats;
    requests: number;
    sessions: number;
    activeDays: number;
    perDay: number;
    perSession: number;
    streak: Streaks;
    busiest?: DailyCost;
    /** One entry per local day of the active window. */
    daily: DailyCost[];
    /** Absent when a single day is in context: there is nothing to compare it with. */
    trends?: Trends;
    top: TopLists;
    delegates: Delegates;
};

const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];
/** Empty first, then four steps: glyph and hue both rise, so a level reads without color. */
const HEAT_LEVELS = [
    { glyph: "·", color: "borderMuted" },
    { glyph: "▪", color: "muted" },
    { glyph: "■", color: "text" },
    { glyph: "■", color: "warning" },
    { glyph: "■", color: "error" },
] as const;
const INDENT = "  ";
const COLUMN_GAP = 3;
/** pi-delegate children persist their own sessions under this id prefix. */
const DELEGATE_PREFIX = "delegate-";
/** Narrowest a section may get before it is stacked instead of placed beside another. */
const MIN_SECTION_WIDTH = 44;
/** Longest a name column grows; a longer list would push the bar too far from the name. */
const MAX_NAME_WIDTH = 30;
/** Space the bar and the cost take in a top list row. */
const LIST_OVERHEAD = 24;
/** Two lists share a row while each keeps its names readable. */
const LISTS_PER_ROW = 2;

function emptyStats(): Stats {
    return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function trends(records: UsageRecord[], now: number): Trends {
    const compare = comparison(records, now);
    const date = new Date(now);
    const monthDays = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return {
        today: compare.today,
        week: compare.week,
        weekTotal: compare.weekTotal,
        weekDelta: percentChange(compare.week, compare.lastWeek),
        month: compare.month,
        monthTotal: compare.monthTotal,
        monthDelta: percentChange(compare.month, compare.lastMonth),
        lastMonthTotal: compare.lastMonthTotal,
        projection: compare.month * monthDays,
    };
}

function heading(theme: Theme, text: string): string {
    return theme.fg("accent", theme.bold(text));
}

/** Bold value; `accent` marks the headline number of its block. */
function cellValue(text: string, accent: boolean, theme: Theme): string {
    const value = theme.bold(text);
    return accent ? theme.fg("accent", value) : value;
}

/** `labelWidth` pads the labels of a column so its values line up. */
function cellText(cell: Cell, theme: Theme, labelWidth = visibleWidth(cell.label)): string {
    return theme.fg("muted", padWidth(cell.label, labelWidth)) + "  " + cell.value;
}

/** Widest label and widest padded value per column, plus the gap; labels pad so values line up. */
function gridColumns(cells: Cell[], count: number, theme: Theme): GridColumn[] {
    const labels = Array.from({ length: count }, () => 0);
    for (const [index, cell] of cells.entries()) {
        const column = index % count;
        labels[column] = Math.max(labels[column]!, visibleWidth(cell.label));
    }
    const widths = Array.from({ length: count }, () => 0);
    for (const [index, cell] of cells.entries()) {
        const column = index % count;
        widths[column] = Math.max(widths[column]!, visibleWidth(cellText(cell, theme, labels[column]!)) + COLUMN_GAP);
    }
    return labels.map((label, column) => ({ label, width: widths[column]! }));
}

/** Label/value pairs in as many aligned columns as `maxColumns` and the width allow. */
function grid(cells: Cell[], width: number, maxColumns: number, theme: Theme): string[] {
    for (let count = Math.min(cells.length, maxColumns); count > 0; count--) {
        const columns = gridColumns(cells, count, theme);
        const used = columns.reduce((sum, column) => sum + column.width, 0) - COLUMN_GAP;
        if (count > 1 && used > width) continue;
        const rows: string[] = [];
        for (let start = 0; start < cells.length; start += count) {
            rows.push(
                cells
                    .slice(start, start + count)
                    .map((cell, column) =>
                        padWidth(cellText(cell, theme, columns[column]!.label), columns[column]!.width),
                    )
                    .join("")
                    .trimEnd(),
            );
        }
        return rows;
    }
    return [];
}

function indent(rows: string[]): string[] {
    return rows.map((row) => INDENT + row);
}

/** Month labels over the week columns; a label too close to the next one is dropped instead of colliding. */
function monthHeader(months: (string | undefined)[], weeks: number): string {
    const chars = Array.from({ length: 4 + weeks * 2 }, () => " ");
    const labels: { start: number; text: string }[] = [];
    for (const [week, month] of months.entries()) if (month) labels.push({ start: 4 + week * 2, text: month });
    for (const [index, label] of labels.entries()) {
        const next = labels[index + 1];
        const end = label.start + label.text.length;
        // One space between labels reads as no gap in a terminal, so each label needs a column of its own.
        if (next !== undefined && next.start - end < 2) continue;
        // The last label may run past the grid: a one-day calendar has only one 2-wide column for `Sep`.
        for (const [i, char] of Array.from(label.text).entries()) chars[label.start + i] = char;
    }
    return chars.join("").trimEnd();
}

/** `05-21 Wed` for a `YYYY-MM-DD` key, matching the sparkline and session list dates. */
function dayName(key: string): string {
    const weekday = new Date(`${key}T00:00`).toLocaleDateString("en-US", { weekday: "short" });
    return `${key.slice(5)} ${weekday}`;
}

function activity(daily: DailyCost[], width: number, theme: Theme): string[] {
    const weeks = Math.max(1, Math.min(53, Math.floor((width - 4) / 2)));
    const heat = heatmap(daily, weeks);
    const rows = [theme.fg("dim", heat.header)];
    for (const [weekday, row] of heat.rows.entries()) {
        // A one-day window leaves six empty rows; skip them instead of printing bare weekday labels.
        if (row.every((cell) => cell === undefined)) continue;
        const label = WEEKDAYS[weekday]!;
        let line = label ? theme.fg("dim", label.padEnd(4)) : " ".repeat(4);
        for (const cell of row) {
            if (cell === undefined) line += "  ";
            else {
                const level = HEAT_LEVELS[cell.level]!;
                line += theme.fg(level.color, `${level.glyph} `);
            }
        }
        rows.push(line.trimEnd());
    }
    const legend = HEAT_LEVELS.map((level) => theme.fg(level.color, level.glyph)).join(" ");
    rows.push(theme.fg("dim", "less ") + legend + theme.fg("dim", " more"));
    return rows;
}

/** Delegate children cost against the whole set; the id prefix is the only marker of a delegate session. */
function delegateSplit(records: UsageRecord[]): Delegates {
    let cost = 0;
    let total = 0;
    for (const record of records) {
        total += record.cost;
        if (record.sessionId.startsWith(DELEGATE_PREFIX)) cost += record.cost;
    }
    return { cost, share: total > 0 ? cost / total : 0 };
}

/** Cost, volume and token cells; one group per column so the three start side by side. */
function kpiGroups(model: SummaryModel, theme: Theme): Cell[][] {
    const { stats } = model;
    return [
        [
            { label: "Total", value: cellValue(formatCost(stats.cost), true, theme) },
            { label: "Per day", value: cellValue(formatCost(model.perDay), false, theme) },
            { label: "Per session", value: cellValue(formatCost(model.perSession), false, theme) },
            {
                label: "Delegates",
                value:
                    cellValue(formatCost(model.delegates.cost), false, theme) +
                    "  " +
                    theme.fg("muted", `${Math.round(100 * model.delegates.share)}%`),
            },
        ],
        [
            { label: "Reqs", value: cellValue(formatTokens(model.requests), false, theme) },
            { label: "Sessions", value: cellValue(formatTokens(model.sessions), false, theme) },
            { label: "Active days", value: cellValue(formatTokens(model.activeDays), false, theme) },
        ],
        [
            { label: "In", value: cellValue(formatTokens(stats.input), false, theme) },
            { label: "Out", value: cellValue(formatTokens(stats.output), false, theme) },
            // shortcut: no per-model price table, so cache savings show as the read/write split, not dollars.
            { label: "Cache R", value: cellValue(formatTokens(stats.cacheRead), false, theme) },
            { label: "Cache W", value: cellValue(formatTokens(stats.cacheWrite), false, theme) },
            { label: "Hit", value: cellValue(hitPct(stats, theme), false, theme) },
        ],
    ];
}

/** Column-major: each group is a column with its labels padded, so every value in a column lines up. */
function kpiBlock(groups: Cell[][], width: number, theme: Theme): string[] {
    const labelWidths = groups.map((group) => Math.max(...group.map((cell) => visibleWidth(cell.label))));
    const widths = groups.map(
        (group, column) =>
            Math.max(...group.map((cell) => visibleWidth(cellText(cell, theme, labelWidths[column]!)))) + COLUMN_GAP,
    );
    if (widths.reduce((sum, column) => sum + column, 0) - COLUMN_GAP > width)
        return groups.flatMap((group) => grid(group, width, group.length, theme));
    const height = Math.max(...groups.map((group) => group.length));
    return Array.from({ length: height }, (_, row) =>
        groups
            .map((group, column) =>
                padWidth(
                    group[row] === undefined ? "" : cellText(group[row]!, theme, labelWidths[column]!),
                    widths[column]!,
                ),
            )
            .join("")
            .trimEnd(),
    );
}

/** Total, then per day, then the change against the previous period. */
function trendRows(model: SummaryModel, theme: Theme): TrendRow[] {
    const trends = model.trends!;
    return [
        { label: "Today", total: formatCost(trends.today), accent: true },
        {
            label: "This week",
            total: formatCost(trends.weekTotal),
            perDay: `${formatCost(trends.week)}/day`,
            delta: deltaText(trends.weekDelta, theme),
            suffix: "vs last week",
        },
        {
            label: "This month",
            total: formatCost(trends.monthTotal),
            perDay: `${formatCost(trends.month)}/day`,
            delta: deltaText(trends.monthDelta, theme),
            suffix: "vs last month",
        },
        {
            label: "Projected",
            total: formatCost(trends.projection),
            suffix: `vs ${formatCost(trends.lastMonthTotal)} last month`,
        },
    ];
}

/** The per-day columns go before the total is dropped, and the wording goes last: the total always stays. */
function trendCells(model: SummaryModel, width: number, theme: Theme): Cell[] {
    const rows = trendRows(model, theme);
    const labelWidth = Math.max(...rows.map((row) => visibleWidth(row.label)));
    const totalWidth = Math.max(...rows.map((row) => visibleWidth(row.total)));
    const perDayWidth = Math.max(...rows.map((row) => visibleWidth(row.perDay ?? "")));
    const deltaWidth = Math.max(...rows.map((row) => visibleWidth(row.delta ?? "")));
    // One decision for the whole block: a column shown on some rows only would break the alignment.
    const detailed = labelWidth + 2 + totalWidth + 2 + perDayWidth + 2 + deltaWidth <= width;
    return rows.map((row) => {
        const total = padWidth(cellValue(row.total, row.accent === true, theme), totalWidth);
        const perDay = detailed && row.perDay !== undefined ? "  " + padWidth(theme.bold(row.perDay), perDayWidth) : "";
        const delta = detailed && row.delta !== undefined ? "  " + row.delta : "";
        const value = total + perDay + delta;
        const suffix = row.suffix === undefined ? "" : ` ${row.suffix}`;
        // grid() skips its width test for a single column, so an oversized row would be cut mid-word.
        const fits = labelWidth + 2 + visibleWidth(value) + visibleWidth(suffix) <= width;
        return { label: row.label, value: value + (fits ? theme.fg("muted", suffix) : "") };
    });
}

function days(count: number): string {
    return `${count} ${count === 1 ? "day" : "days"}`;
}

function listName(list: List, row: GroupRow): string {
    return list.mode === undefined ? row.name : displayName(list.mode, row.name);
}

function listBlock(list: List, totalCost: number, width: number, theme: Theme): string[] {
    const bodyWidth = Math.max(1, width - INDENT.length);
    const nameWidth = Math.max(6, Math.min(MAX_NAME_WIDTH, bodyWidth - LIST_OVERHEAD));
    return [
        heading(theme, list.title),
        ...indent(list.rows.map((row) => topLine({ ...row, name: listName(list, row) }, totalCost, nameWidth, theme))),
    ];
}

/** A list's width when its longest name keeps its space next to the bar and the cost. */
function listWidth(list: List, width: number): number {
    const longest = Math.max(0, ...list.rows.map((row) => visibleWidth(listName(list, row))));
    return Math.min(width, INDENT.length + Math.min(MAX_NAME_WIDTH, longest) + LIST_OVERHEAD);
}

/** Widths for `count` blocks sharing a row, the last one taking the rounding remainder. */
function rowWidths(width: number, count: number): number[] {
    const share = Math.floor((width - COLUMN_GAP * (count - 1)) / count);
    return Array.from({ length: count }, (_, column) =>
        column === count - 1 ? width - (share + COLUMN_GAP) * (count - 1) : share,
    );
}

/** One row of already rendered blocks, each padded to its column width. */
function sideBySide(blocks: string[][], widths: number[]): string[] {
    const height = Math.max(...blocks.map((block) => block.length));
    const lines: string[] = [];
    for (let line = 0; line < height; line++)
        lines.push(
            blocks
                .map((block, column) => padWidth(block[line] ?? "", widths[column]!))
                .join(" ".repeat(COLUMN_GAP))
                .trimEnd(),
        );
    return lines;
}

/** One row of lists at the given column widths, so the pairs line up down the rows. */
function listRow(lists: List[], widths: number[], totalCost: number, theme: Theme): string[] {
    return sideBySide(
        lists.map((list, column) => listBlock(list, totalCost, widths[column]!, theme)),
        widths,
    );
}

/** A section's heading and its cell grid, rendered into `width`. */
function sectionBlock(section: Section, width: number, theme: Theme): string[] {
    const bodyWidth = Math.max(1, width - INDENT.length);
    return [
        heading(theme, section.title),
        ...indent(grid(section.cells(bodyWidth), bodyWidth, section.maxColumns, theme)),
    ];
}

/** Trends and streaks share a row while each keeps its content width instead of an even share. */
function sections(items: Section[], width: number, theme: Theme): string[] {
    const count = Math.max(
        1,
        Math.min(items.length, Math.floor((width + COLUMN_GAP) / (MIN_SECTION_WIDTH + COLUMN_GAP))),
    );
    const lines: string[] = [];
    for (let start = 0; start < items.length; start += count) {
        if (lines.length > 0) lines.push("");
        const row = items.slice(start, start + count);
        // Render at the full width first: a section that needs less keeps its wording and sits next to its
        // neighbour instead of being squeezed into half the terminal.
        const natural = row.map((section) => sectionBlock(section, width, theme));
        const widths = natural.map((block) => Math.max(...block.map((line) => visibleWidth(line))));
        if (widths.reduce((sum, column) => sum + column, 0) + COLUMN_GAP * (row.length - 1) <= width) {
            lines.push(...sideBySide(natural, widths));
            continue;
        }
        const share = rowWidths(width, row.length);
        lines.push(
            ...sideBySide(
                row.map((section, column) => sectionBlock(section, share[column]!, theme)),
                share,
            ),
        );
    }
    return lines;
}

function streakCells(model: SummaryModel, theme: Theme): Cell[] {
    return [
        { label: "Current", value: cellValue(days(model.streak.current), false, theme) },
        { label: "Longest", value: cellValue(days(model.streak.longest), false, theme) },
        {
            label: "Busiest",
            value: cellValue(
                model.busiest ? `${dayName(model.busiest.label)} ${formatCost(model.busiest.cost)}` : "-",
                false,
                theme,
            ),
        },
    ];
}

/** Consecutive active days; `daily` must be contiguous days ending today, so the trailing run is current. */
export function streaks(daily: DailyCost[]): Streaks {
    let longest = 0;
    let run = 0;
    for (const day of daily) {
        run = day.cost > 0 ? run + 1 : 0;
        longest = Math.max(longest, run);
    }
    return { current: run, longest };
}

export function busiestDay(daily: DailyCost[]): DailyCost | undefined {
    let best: DailyCost | undefined;
    for (const day of daily) {
        if (day.cost > 0 && (best === undefined || day.cost > best.cost)) best = day;
    }
    return best;
}

/** `level` rises with cost on a log scale, so a few expensive days do not flatten every other day. */
function heatLevel(cost: number, max: number): number {
    if (cost <= 0 || max <= 0) return 0;
    return Math.min(4, Math.max(1, Math.ceil((4 * Math.log1p(cost)) / Math.log1p(max))));
}

/** Local date of a daily label; totals use `YYYY-MM-DD`, tests and callers may pass a bare `MM-DD`. */
function labelDate(label: string, now: number): Date {
    const full = label.length === 10 ? label : `${new Date(now).getFullYear()}-${label}`;
    return new Date(`${full}T00:00`);
}

/** `weeks` is the space available; the grid shrinks to the recorded history and ends on its last day. */
export function heatmap(daily: DailyCost[], weeks: number, now = Date.now()): Heatmap {
    const last = daily.length - 1;
    const end = last >= 0 ? labelDate(daily[last]!.label, now) : new Date(now);
    const today = (end.getDay() + 6) % 7; // Monday = 0
    const columns = Math.max(1, Math.min(weeks, Math.ceil((daily.length + today) / 7)));
    const first = last - today - 7 * (columns - 1);
    const max = daily.reduce((top, day) => Math.max(top, day.cost), 0);
    const rows: (HeatCell | undefined)[][] = [[], [], [], [], [], [], []];
    for (let weekday = 0; weekday < 7; weekday++) {
        for (let week = 0; week < columns; week++) {
            const index = first + week * 7 + weekday;
            if (index < 0 || index > last) {
                rows[weekday]!.push(undefined);
                continue;
            }
            const { cost } = daily[index]!;
            rows[weekday]!.push({ cost, level: heatLevel(cost, max) });
        }
    }
    const months: (string | undefined)[] = [];
    let month = -1;
    for (let week = 0; week < columns; week++) {
        // The week starts on its Monday, but a one-day column shows only its day, so label the first day it shows.
        const date = labelDate(daily[Math.max(0, first + week * 7)]!.label, now);
        months.push(date.getMonth() === month ? undefined : date.toLocaleDateString("en-US", { month: "short" }));
        month = date.getMonth();
    }
    return { header: monthHeader(months, columns), rows };
}

/** Top groups by cost, in the same shape the table views use. */
export function topGroups(
    records: UsageRecord[],
    since: number,
    until: number,
    mode: GroupMode,
    count = 5,
): GroupRow[] {
    return buildRows(records, since, mode, until).slice(0, count);
}

/** Sessions have no grouping of their own; the name pairs the start date with a short id and the project. */
export function topSessions(records: UsageRecord[], since: number, until: number, count = 5): GroupRow[] {
    const sessions = new Map<string, { cwd: string; start: number; stats: Stats; requests: number }>();
    for (const record of records) {
        if (record.ts < since || record.ts >= until) continue;
        let session = sessions.get(record.sessionId);
        if (!session)
            sessions.set(
                record.sessionId,
                (session = { cwd: record.cwd, start: record.ts, stats: emptyStats(), requests: 0 }),
            );
        session.start = Math.min(session.start, record.ts);
        session.stats.cost += record.cost;
        session.stats.input += record.input;
        session.stats.output += record.output;
        session.stats.cacheRead += record.cacheRead;
        session.stats.cacheWrite += record.cacheWrite;
        session.requests += record.requests;
    }
    return [...sessions]
        .map(([id, session]) => ({
            key: id,
            // The id identifies the session, so it comes before the project and survives a truncated name.
            name: `${dayKey(session.start).slice(5)} ${id.slice(0, 6)} ${basename(session.cwd) || "(no cwd)"}`,
            stats: session.stats,
            requests: session.requests,
        }))
        .sort((a, b) => b.stats.cost - a.stats.cost || b.requests - a.requests)
        .slice(0, count);
}

/**
 * The whole Summary view as data. `records` is the active set: drill-down filters already applied and
 * `window` is the day or history it covers, so a single day in context yields a one-day calendar.
 */
export function summaryModel(
    records: UsageRecord[],
    withTrends = true,
    now = Date.now(),
    window?: TimeWindow,
): SummaryModel {
    const summary = summarize(records);
    const daily = dailyTotals(records, window, now);
    const activeDays = daily.filter((day) => day.cost > 0).length;
    return {
        stats: summary.stats,
        requests: summary.requests,
        sessions: summary.sessions,
        activeDays,
        perDay: activeDays > 0 ? summary.stats.cost / activeDays : 0,
        perSession: summary.sessions > 0 ? summary.stats.cost / summary.sessions : 0,
        streak: streaks(daily),
        busiest: busiestDay(daily),
        daily,
        trends: withTrends ? trends(records, now) : undefined,
        top: {
            models: topGroups(records, 0, Infinity, "model"),
            providers: topGroups(records, 0, Infinity, "provider"),
            projects: topGroups(records, 0, Infinity, "project"),
            sessions: topSessions(records, 0, Infinity),
        },
        delegates: delegateSplit(records),
    };
}

export function summaryLines(model: SummaryModel, width: number, theme: Theme): string[] {
    const bodyWidth = Math.max(1, width - INDENT.length);
    const lines = [heading(theme, "Overview"), ...indent(kpiBlock(kpiGroups(model, theme), bodyWidth, theme))];
    const items: Section[] = [];
    if (model.trends) items.push({ title: "Trends", maxColumns: 1, cells: (w) => trendCells(model, w, theme) });
    items.push({ title: "Streaks", maxColumns: 1, cells: () => streakCells(model, theme) });
    lines.push("", ...sections(items, width, theme));
    if (model.daily.length > 0) {
        lines.push("", heading(theme, "Activity"), ...indent(activity(model.daily, bodyWidth, theme)));
    }
    const lists = (
        [
            { title: "Models", mode: "model", rows: model.top.models },
            { title: "Providers", mode: "provider", rows: model.top.providers },
            { title: "Projects", mode: "project", rows: model.top.projects },
            { title: "Sessions", rows: model.top.sessions },
        ] satisfies List[]
    ).filter((list) => list.rows.length > 0);
    // A list column is as wide as the widest list that lands in it, so the pairs line up down the rows and
    // stop at their content instead of hugging the right edge of a wide terminal.
    const listColumns = Array.from({ length: LISTS_PER_ROW }, (_, column) =>
        Math.max(
            0,
            ...lists.filter((_, index) => index % LISTS_PER_ROW === column).map((list) => listWidth(list, width)),
        ),
    );
    const paired = lists.length > 1 && listColumns.reduce((sum, column) => sum + column, 0) + COLUMN_GAP <= width;
    for (let start = 0; start < lists.length; start += paired ? LISTS_PER_ROW : 1) {
        const row = lists.slice(start, start + (paired ? LISTS_PER_ROW : 1));
        const widths = row.map((_, column) => (paired ? listColumns[column]! : width));
        lines.push("", ...listRow(row, widths, model.stats.cost, theme));
    }
    return lines;
}

/** Usage aggregation over Pi's persisted session JSONL files. */

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";

export type UsageRecord = {
    provider: string;
    model: string;
    ts: number;
    cost: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** cwd from the session header line; empty when the file has no header. */
    cwd: string;
    /** Session id from the session header line; empty when the file has no header. */
    sessionId: string;
};

export type Stats = {
    cost: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};

export function emptyStats(): Stats {
    return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function sessionFiles(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return; // unreadable directory: nothing to count
    }
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await sessionFiles(path, out);
        else if (entry.name.endsWith(".jsonl")) out.push(path);
    }
}

/**
 * One record per assistant message that carries usage, from every session file under `dir`.
 *
 * Files are streamed line by line: the corpus is gigabytes, and reading whole files stalls the event
 * loop and spikes RSS. The recursive scan includes `sessions/delegates`, where pi-delegate children
 * write their own transcripts, so subagent usage is counted with full provider/model attribution and
 * its own cwd. Parent sessions never embed the delegate child's usage (the delegate tool result
 * carries only text), so there is nothing to double-count. toolResult usage from other tools is
 * ignored for the same reason: those children also persist their own session files inside the scan.
 * shortcut: usage reported by tools whose child sessions live outside this dir is not counted.
 */
export async function collectUsage(
    dir: string,
    onProgress?: (done: number, total: number) => void,
): Promise<UsageRecord[]> {
    const files: string[] = [];
    await sessionFiles(dir, files);
    const records: UsageRecord[] = [];
    for (const [done, file] of files.entries()) {
        onProgress?.(done, files.length);
        let cwd = "";
        let sessionId = "";
        try {
            const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
            for await (const line of lines) {
                // Cheap prefilter: escaped JSON inside tool results never matches this literal.
                if (!line.includes('"role":"assistant"')) {
                    // The session header (type:"session", cwd, id) is normally the first line.
                    if (sessionId === "" && line.includes('"type":"session"')) {
                        try {
                            const header = JSON.parse(line);
                            if (header?.type === "session") {
                                cwd = String(header.cwd ?? "");
                                sessionId = String(header.id ?? "");
                            }
                        } catch {
                            // malformed header line: keep scanning for a later one
                        }
                    }
                    continue;
                }
                let entry: any;
                try {
                    entry = JSON.parse(line);
                } catch {
                    continue;
                }
                const msg = entry?.message;
                const usage = msg?.usage;
                if (!usage || !msg.provider || !msg.model) continue;
                const cost = typeof usage.cost === "number" ? usage.cost : num(usage.cost?.total);
                records.push({
                    provider: String(msg.provider),
                    model: String(msg.model),
                    ts: num(msg.timestamp),
                    cost,
                    input: num(usage.input),
                    output: num(usage.output),
                    cacheRead: num(usage.cacheRead),
                    cacheWrite: num(usage.cacheWrite),
                    cwd,
                    sessionId,
                });
            }
        } catch {
            continue; // unreadable or truncated file: skip it, keep what other files gave
        }
    }
    return records;
}

function addStats(stats: Stats, record: UsageRecord): void {
    stats.cost += record.cost;
    stats.input += record.input;
    stats.output += record.output;
    stats.cacheRead += record.cacheRead;
    stats.cacheWrite += record.cacheWrite;
}

type TimeMode = "day" | "week" | "month";
export type GroupMode = "provider" | "model" | "project" | TimeMode;
export type UsageFilter = { mode: GroupMode; key: string };

export const isTimeMode = (mode: GroupMode): mode is TimeMode => mode === "day" || mode === "week" || mode === "month";

export function isTimeFilter(filter: UsageFilter | undefined): filter is UsageFilter & { mode: TimeMode } {
    return filter !== undefined && isTimeMode(filter.mode);
}

export function clearTimeFilters(stack: { filters: UsageFilter[] }[]): void {
    for (let i = stack.length - 1; i >= 0; i--) {
        stack[i]!.filters = stack[i]!.filters.filter((filter) => !isTimeMode(filter.mode));
        if (!stack[i]!.filters.length) stack.splice(i, 1);
    }
}

export function cacheView<T>(derive: () => T) {
    let cached: { key: string; value: T } | undefined;
    return (period: number, mode: GroupMode, filters: UsageFilter[], now = Date.now()): T => {
        const key = JSON.stringify([period, mode, filters, dayKey(now)]);
        if (!cached || cached.key !== key) cached = { key, value: derive() };
        return cached.value;
    };
}

export function dayKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function bucketStart(ts: number, mode: TimeMode): number {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    if (mode === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (mode === "month") d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

export function bucketKey(ts: number, mode: TimeMode): string {
    const key = dayKey(bucketStart(ts, mode));
    return mode === "month" ? key.slice(0, 7) : key;
}

export function bucketWindow(key: string, mode: TimeMode, offset = 0): { since: number; until: number } {
    const date = new Date(`${mode === "month" ? key + "-01" : key}T00:00`);
    const shift = (n: number) => {
        if (mode === "month") date.setMonth(date.getMonth() + n);
        else date.setDate(date.getDate() + n * (mode === "week" ? 7 : 1));
        // A skipped midnight can leave 01:00 on the next calendar day.
        date.setHours(0, 0, 0, 0);
    };
    shift(offset);
    const since = date.getTime();
    shift(1);
    return { since, until: date.getTime() };
}

export function stepFilter(filters: UsageFilter[], offset: number, now = Date.now()): string | undefined {
    const last = filters.at(-1);
    if (!isTimeFilter(last)) return undefined;
    let { since, until } = bucketWindow(last.key, last.mode, offset);
    const key = bucketKey(since, last.mode);
    if (key > bucketKey(now, last.mode)) return undefined;
    for (const outer of filters.slice(0, -1)) {
        if (!isTimeMode(outer.mode)) continue;
        const window = bucketWindow(outer.key, outer.mode);
        since = Math.max(since, window.since);
        until = Math.min(until, window.until);
    }
    return since < until ? key : undefined;
}

// UTC ordinals count local calendar days without DST changing their length.
export function windowDays(since: number, until: number): number {
    if (since >= until) return 0;
    const ordinal = (ts: number) => {
        const d = new Date(ts);
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
    };
    return ordinal(until - 1) - ordinal(since) + 1;
}

export function percentChange(current: number, previous: number): number {
    return previous === 0 ? (current === 0 ? 0 : Infinity) : ((current - previous) / previous) * 100;
}

function recordKey(record: UsageRecord, mode: GroupMode): string {
    return isTimeMode(mode) ? bucketKey(record.ts, mode) : mode === "project" ? record.cwd : record[mode];
}

export function matchesFilter(record: UsageRecord, filter: UsageFilter): boolean {
    return recordKey(record, filter.mode) === filter.key;
}

export function usageWindow(records: UsageRecord[], days: number, filters: UsageFilter[], now = Date.now()) {
    const { since: today, until: end } = bucketWindow(dayKey(now), "day");
    const timeFilters = filters.filter((f) => isTimeMode(f.mode));
    let since = today;
    let until = end;
    if (timeFilters.length) {
        since = 0;
        for (const filter of timeFilters) {
            const window = bucketWindow(filter.key, filter.mode as TimeMode);
            since = Math.max(since, window.since);
            until = Math.min(until, window.until);
        }
    } else if (days === Infinity) {
        let first = Infinity;
        for (const record of records) if (record.ts < end) first = Math.min(first, record.ts);
        since = first === Infinity ? end : bucketWindow(dayKey(first), "day").since;
    } else {
        since = bucketWindow(dayKey(now), "day", 1 - days).since;
    }
    return { since, until, days: windowDays(since, until) };
}

export function previousSummary(records: UsageRecord[], since: number, days: number): Summary {
    return summarize(records, bucketWindow(dayKey(since), "day", -days).since, since);
}

export type GroupRow = {
    key: string;
    name: string;
    stats: Stats;
    requests: number;
    perDay?: number;
    delta?: number;
    /** Nested model rows; only produced by provider grouping. */
    children?: GroupRow[];
};

const tokens = (s: Stats): number => s.input + s.output + s.cacheRead + s.cacheWrite;

/** Cost descending, then total tokens (so free models still rank by usage). */
const byCost = (a: GroupRow, b: GroupRow): number => b.stats.cost - a.stats.cost || tokens(b.stats) - tokens(a.stats);

type Tally = { stats: Stats; requests: number; models?: Map<string, Tally>; providers?: Set<string> };

const newTally = (): Tally => ({ stats: emptyStats(), requests: 0 });

export function buildRows(
    records: UsageRecord[],
    sinceMs = 0,
    mode: GroupMode = "provider",
    untilMs = Infinity,
): GroupRow[] {
    if (isTimeMode(mode) && (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)))
        throw new RangeError("Time grouping requires a finite window");
    const groups = new Map<string, Tally>();
    for (const record of records) {
        if (record.ts < sinceMs || record.ts >= untilMs) continue;
        const key = recordKey(record, mode);
        let group = groups.get(key);
        if (!group) {
            group = newTally();
            if (mode === "provider") group.models = new Map();
            if (mode === "model") group.providers = new Set();
            groups.set(key, group);
        }
        addStats(group.stats, record);
        group.requests++;
        if (mode === "model") group.providers!.add(record.provider);
        if (mode === "provider") {
            let model = group.models!.get(record.model);
            if (!model) group.models!.set(record.model, (model = newTally()));
            addStats(model.stats, record);
            model.requests++;
        }
    }
    if (isTimeMode(mode)) {
        if (sinceMs < untilMs) {
            let key = bucketKey(sinceMs, mode);
            const last = bucketKey(untilMs - 1, mode);
            while (key <= last) {
                if (!groups.has(key)) groups.set(key, newTally());
                key = bucketKey(bucketWindow(key, mode).until, mode);
            }
        }
        const rows = [...groups]
            .map(([key, group]): GroupRow => {
                const window = bucketWindow(key, mode);
                const days = windowDays(Math.max(sinceMs, window.since), Math.min(untilMs, window.until));
                return {
                    key,
                    name: key,
                    stats: group.stats,
                    requests: group.requests,
                    perDay: days ? group.stats.cost / days : 0,
                };
            })
            .sort((a, b) => b.key.localeCompare(a.key));
        for (let i = 0; i + 1 < rows.length; i++)
            rows[i]!.delta = percentChange(rows[i]!.perDay!, rows[i + 1]!.perDay!);
        return rows;
    }
    const toRow = ([name, group]: [string, Tally]): GroupRow => ({
        key: name,
        name: mode === "model" && group.providers!.size > 1 ? `${name} (${group.providers!.size})` : name,
        stats: group.stats,
        requests: group.requests,
        children: group.models && [...group.models].map(toRow).sort(byCost),
    });
    return [...groups].map(toRow).sort(byCost);
}

export type Summary = {
    stats: Stats;
    requests: number;
    /** Distinct session ids (files) seen in the window. */
    sessions: number;
    /** cacheRead / (input + cacheRead + cacheWrite); 0 without any tokens. */
    hit: number;
};

/** Totals for the summary block: one pass over [sinceMs, untilMs). */
export function summarize(records: UsageRecord[], sinceMs = 0, untilMs = Infinity): Summary {
    const stats = emptyStats();
    let requests = 0;
    const sessions = new Set<string>();
    for (const record of records) {
        if (record.ts < sinceMs || record.ts >= untilMs) continue;
        addStats(stats, record);
        requests++;
        sessions.add(record.sessionId);
    }
    const cacheTotal = stats.input + stats.cacheRead + stats.cacheWrite;
    return {
        stats,
        requests,
        sessions: sessions.size,
        hit: cacheTotal > 0 ? stats.cacheRead / cacheTotal : 0,
    };
}

export type DailyCost = { label: string; cost: number };

export const seriesKey = (key: string, parent?: string): string => JSON.stringify([key, parent ?? null]);

export function buildDailySeries(
    records: UsageRecord[],
    since: number,
    until: number,
    mode: GroupMode,
    rows: { key: string; parent?: string }[],
): { total: DailyCost[]; rows: Map<string, DailyCost[]> } {
    const days = windowDays(since, until);
    const total: DailyCost[] = [];
    const positions = new Map<string, number>();
    let cursor = since;
    for (let i = 0; i < days; i++) {
        const key = dayKey(cursor);
        positions.set(key, i);
        total.push({ label: key.slice(5), cost: 0 });
        cursor = bucketWindow(key, "day").until;
    }
    const costs = new Map<string, Map<number, number>>();
    const add = (key: string, index: number, cost: number) => {
        let values = costs.get(key);
        if (!values) costs.set(key, (values = new Map()));
        values.set(index, (values.get(index) ?? 0) + cost);
    };
    for (const record of records) {
        if (record.ts < since || record.ts >= until) continue;
        const index = positions.get(dayKey(record.ts));
        if (index === undefined) continue;
        total[index]!.cost += record.cost;
        const key = recordKey(record, mode);
        add(seriesKey(key), index, record.cost);
        if (mode === "provider") add(seriesKey(record.model, record.provider), index, record.cost);
    }
    const result = new Map<string, DailyCost[]>();
    for (const row of rows) {
        const key = seriesKey(row.key, row.parent);
        const values = costs.get(key);
        const bucket = isTimeMode(mode) ? bucketWindow(row.key, mode) : { since, until };
        const start = windowDays(since, Math.max(since, bucket.since));
        const end = windowDays(since, Math.min(until, bucket.until));
        result.set(
            key,
            total.slice(start, end).map((day, i) => ({ label: day.label, cost: values?.get(start + i) ?? 0 })),
        );
    }
    return { total, rows: result };
}

/** Sum `perBar` consecutive daily buckets into one bar, labeled by its first day. */
export function bucketCosts(days: DailyCost[], perBar: number): DailyCost[] {
    if (perBar <= 1) return days;
    const bars: DailyCost[] = [];
    for (let i = 0; i < days.length; i += perBar) {
        const group = days.slice(i, i + perBar);
        bars.push({ label: group[0]!.label, cost: group.reduce((sum, d) => sum + d.cost, 0) });
    }
    return bars;
}

/** Usage aggregation over Pi's persisted session JSONL files. */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

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
    /** Assistant messages this record stands for. */
    requests: number;
};

export type Stats = {
    cost: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};

type CacheEntry = { size: number; mtimeMs: number; records: UsageRecord[] };
type Cache = { version: number; files: Record<string, CacheEntry> };

export type GroupMode = "day" | "provider" | "model" | "project";
export type UsageFilter = { mode: GroupMode; key: string };

export type GroupRow = {
    key: string;
    name: string;
    stats: Stats;
    requests: number;
    delta?: number;
    /** Nested model rows; only produced by provider grouping. */
    children?: GroupRow[];
};

export type Summary = {
    stats: Stats;
    requests: number;
    /** Distinct session ids (files) seen in the window. */
    sessions: number;
};

export type DailyCost = { label: string; cost: number };
export type TimeWindow = { since: number; until: number };

type Tally = { stats: Stats; requests: number; models?: Map<string, Tally> };

const CACHE_VERSION = 5;

function emptyStats(): Stats {
    return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** One record per (day, provider, model, cwd, session); the dashboard groups no finer than a day. */
function aggregate(records: UsageRecord[]): UsageRecord[] {
    const buckets = new Map<string, UsageRecord>();
    for (const record of records) {
        const key = JSON.stringify([
            startOfDay(record.ts),
            record.provider,
            record.model,
            record.cwd,
            record.sessionId,
        ]);
        const bucket = buckets.get(key);
        if (!bucket) {
            buckets.set(key, { ...record });
            continue;
        }
        addStats(bucket, record);
        bucket.ts = Math.max(bucket.ts, record.ts);
        bucket.requests += record.requests;
    }
    return [...buckets.values()];
}

function addStats(stats: Stats, record: UsageRecord): void {
    stats.cost += record.cost;
    stats.input += record.input;
    stats.output += record.output;
    stats.cacheRead += record.cacheRead;
    stats.cacheWrite += record.cacheWrite;
}

function recordKey(record: UsageRecord, mode: GroupMode): string {
    return mode === "day" ? dayKey(record.ts) : mode === "project" ? record.cwd : record[mode];
}

function tokens(s: Stats): number {
    return s.input + s.output + s.cacheRead + s.cacheWrite;
}

/** Cost descending, then total tokens (so free models still rank by usage). */
function byCost(a: GroupRow, b: GroupRow): number {
    return b.stats.cost - a.stats.cost || tokens(b.stats) - tokens(a.stats);
}

function newTally(): Tally {
    return { stats: emptyStats(), requests: 0 };
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
        if (entry.isDirectory()) {
            await sessionFiles(path, out);
        } else if (entry.name.endsWith(".jsonl")) out.push(path);
    }
}

async function readCache(file: string): Promise<Record<string, CacheEntry>> {
    try {
        const cache = JSON.parse(await readFile(file, "utf8")) as Cache;
        if (cache?.version !== CACHE_VERSION || typeof cache.files !== "object" || cache.files === null) return {};
        return cache.files;
    } catch {
        return {};
    }
}

async function writeCache(file: string, files: Record<string, CacheEntry>): Promise<void> {
    const temp = join(dirname(file), `.tmp-${randomUUID()}`);
    try {
        await writeFile(temp, JSON.stringify({ version: CACHE_VERSION, files } satisfies Cache));
        await rename(temp, file);
    } catch {
        await unlink(temp).catch(() => undefined);
    }
}

/** Throws only on read errors, so a partial parse is never cached. */
async function parseFile(file: string): Promise<UsageRecord[]> {
    const records: UsageRecord[] = [];
    let cwd = "";
    let sessionId = "";
    const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
        // Cheap prefilter: escaped JSON inside tool results never matches this literal.
        const isUsage =
            line.includes('"role":"assistant"') ||
            line.includes('"type":"usage"') ||
            line.includes('"type":"compaction"') ||
            line.includes('"type":"branch_summary"');
        if (!isUsage) {
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
        const message = entry?.message;
        const usage =
            entry?.type === "message" ? (message?.role === "assistant" ? message.usage : undefined) : entry?.usage;
        if (!usage) continue;
        let provider: string;
        let model: string;
        if (entry.type === "message") {
            if (!message.provider || !message.model) continue;
            provider = String(message.provider);
            model = String(message.model);
        } else if (entry.type === "usage" && entry.provider && entry.model) {
            provider = String(entry.provider);
            model = String(entry.model);
        } else {
            // Compaction and branch-summary calls carry no model, so their cost gets its own row.
            provider = "(summaries)";
            model = String(entry.type || "unknown");
        }
        const cost = typeof usage.cost === "number" ? usage.cost : num(usage.cost?.total);
        const input = num(usage.input);
        const output = num(usage.output);
        const cacheRead = num(usage.cacheRead);
        const cacheWrite = num(usage.cacheWrite);
        // An aborted request (delegate children report one) carries no usage; counting it adds a phantom row.
        if (cost === 0 && input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue;
        const stamp = entry.type === "message" ? message.timestamp : entry.timestamp;
        records.push({
            provider,
            model,
            ts: typeof stamp === "string" ? num(Date.parse(stamp)) : num(stamp),
            cost,
            input,
            output,
            cacheRead,
            cacheWrite,
            requests: 1,
            cwd,
            sessionId,
        });
    }
    return records;
}

/**
 * One record per assistant message that carries usage, from every session file under `dir`.
 *
 * Files are streamed line by line: the corpus is gigabytes, and reading whole files stalls the event
 * loop and spikes RSS. The recursive scan includes `sessions/delegates`, where pi-delegate children
 * write their own transcripts, so subagent usage is counted with full provider/model attribution and
 * its own cwd. toolResult usage is ignored: those children persist their own session files inside
 * the scan, so counting it would double their cost.
 *
 * shortcut: a file rewritten with the same size and mtime is not re-parsed.
 * shortcut: usage reported by tools whose child sessions live outside this dir is not counted.
 */
export async function collectUsage(
    dir: string,
    onProgress?: (done: number, total: number) => void,
    cacheFile?: string,
    signal?: AbortSignal,
): Promise<UsageRecord[]> {
    const files: string[] = [];
    await sessionFiles(dir, files);
    const cached = cacheFile ? await readCache(cacheFile) : {};
    const next: Record<string, CacheEntry> = {};
    const records: UsageRecord[] = [];
    let dirty = false;
    for (const [done, file] of files.entries()) {
        if (signal?.aborted) return records;
        onProgress?.(done, files.length);
        let info;
        try {
            info = await stat(file);
        } catch {
            dirty = true;
            continue;
        }
        const hit = cached[file];
        if (hit?.size === info.size && hit.mtimeMs === info.mtimeMs && Array.isArray(hit.records)) {
            next[file] = hit;
            for (const record of hit.records) records.push(record);
            continue;
        }
        dirty = true;
        try {
            const parsed = aggregate(await parseFile(file));
            next[file] = { size: info.size, mtimeMs: info.mtimeMs, records: parsed };
            for (const record of parsed) records.push(record);
        } catch {
            continue; // unreadable or truncated file: skip it, keep what other files gave
        }
    }
    // A closed dashboard must not rewrite the cache with a partial scan.
    if (!cacheFile || signal?.aborted) return records;
    if (dirty || Object.keys(next).length !== Object.keys(cached).length) await writeCache(cacheFile, next);
    return records;
}

export function cacheView<T>(derive: () => T) {
    let cached: { key: string; value: T } | undefined;
    // `scope` is a grouping mode or the name of a non-grouping view.
    return (scope: string, filters: UsageFilter[], now = Date.now()): T => {
        const key = JSON.stringify([scope, filters, dayKey(now)]);
        if (!cached || cached.key !== key) cached = { key, value: derive() };
        return cached.value;
    };
}

export function dayKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startOfDay(ts: number): number {
    const date = new Date(ts);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

export function dayWindow(key: string, offset = 0): TimeWindow {
    const date = new Date(`${key}T00:00`);
    date.setDate(date.getDate() + offset);
    const since = startOfDay(date.getTime());
    date.setDate(date.getDate() + 1);
    return { since, until: startOfDay(date.getTime()) };
}

// UTC ordinals count local calendar days without DST changing their length.
export function windowDays(since: number, until: number): number {
    if (since >= until) return 0;
    function ordinal(ts: number): number {
        const d = new Date(ts);
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
    }
    return ordinal(until - 1) - ordinal(since) + 1;
}

export function percentChange(current: number, previous: number): number {
    return previous === 0 ? (current === 0 ? 0 : Infinity) : ((current - previous) / previous) * 100;
}

export function matchesFilter(record: UsageRecord, filter: UsageFilter): boolean {
    return recordKey(record, filter.mode) === filter.key;
}

export function usageWindow(records: UsageRecord[], day?: string, now = Date.now()): TimeWindow {
    if (day) return dayWindow(day);
    const until = dayWindow(dayKey(now)).until;
    let first = Infinity;
    for (const record of records) if (record.ts < until) first = Math.min(first, record.ts);
    return { since: first === Infinity ? until : dayWindow(dayKey(first)).since, until };
}

export function comparison(records: UsageRecord[], now = Date.now()) {
    const { since: today, until } = dayWindow(dayKey(now));
    const week = new Date(today);
    week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
    const weekStart = startOfDay(week.getTime());
    const lastWeek = dayWindow(dayKey(weekStart), -7).since;
    const month = new Date(today);
    month.setDate(1);
    const monthStart = startOfDay(month.getTime());
    month.setMonth(month.getMonth() - 1);
    const lastMonth = startOfDay(month.getTime());
    let todayCost = 0,
        weekCost = 0,
        lastWeekCost = 0,
        monthCost = 0,
        lastMonthCost = 0;
    for (const record of records) {
        if (record.ts >= until) continue;
        if (record.ts >= today) todayCost += record.cost;
        if (record.ts >= weekStart) weekCost += record.cost;
        else if (record.ts >= lastWeek) lastWeekCost += record.cost;
        if (record.ts >= monthStart) monthCost += record.cost;
        else if (record.ts >= lastMonth) lastMonthCost += record.cost;
    }
    return {
        today: todayCost,
        week: weekCost / windowDays(weekStart, until),
        lastWeek: lastWeekCost / 7,
        month: monthCost / windowDays(monthStart, until),
        lastMonth: lastMonthCost / windowDays(lastMonth, monthStart),
    };
}

export function buildRows(
    records: UsageRecord[],
    sinceMs = 0,
    mode: GroupMode = "provider",
    untilMs = Infinity,
): GroupRow[] {
    if (mode === "day" && (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)))
        throw new RangeError("Time grouping requires a finite window");
    const groups = new Map<string, Tally>();
    for (const record of records) {
        if (record.ts < sinceMs || record.ts >= untilMs) continue;
        const key = recordKey(record, mode);
        let group = groups.get(key);
        if (!group) {
            group = newTally();
            if (mode === "provider") group.models = new Map();
            groups.set(key, group);
        }
        addStats(group.stats, record);
        group.requests += record.requests;
        if (mode === "provider") {
            let model = group.models!.get(record.model);
            if (!model) group.models!.set(record.model, (model = newTally()));
            addStats(model.stats, record);
            model.requests += record.requests;
        }
    }
    if (mode === "day") {
        if (sinceMs < untilMs) {
            let key = dayKey(sinceMs);
            const last = dayKey(untilMs - 1);
            while (key <= last) {
                if (!groups.has(key)) groups.set(key, newTally());
                key = dayKey(dayWindow(key).until);
            }
        }
        const rows = [...groups]
            .map(([key, group]): GroupRow => ({ key, name: key, stats: group.stats, requests: group.requests }))
            .sort((a, b) => b.key.localeCompare(a.key));
        for (let i = 0; i + 1 < rows.length; i++)
            rows[i]!.delta = percentChange(rows[i]!.stats.cost, rows[i + 1]!.stats.cost);
        return rows;
    }
    function toRow([name, group]: [string, Tally]): GroupRow {
        return {
            key: name,
            name,
            stats: group.stats,
            requests: group.requests,
            children: group.models && [...group.models].map(toRow).sort(byCost),
        };
    }
    return [...groups].map(toRow).sort(byCost);
}

/** Totals for the summary block: one pass over [sinceMs, untilMs). */
export function summarize(records: UsageRecord[], sinceMs = 0, untilMs = Infinity): Summary {
    const stats = emptyStats();
    let requests = 0;
    const sessions = new Set<string>();
    for (const record of records) {
        if (record.ts < sinceMs || record.ts >= untilMs) continue;
        addStats(stats, record);
        requests += record.requests;
        sessions.add(record.sessionId);
    }
    return { stats, requests, sessions: sessions.size };
}

/** Total cost per local calendar day in `window`; without one, from the first recorded day through today. */
export function dailyTotals(records: UsageRecord[], window?: TimeWindow, now = Date.now()): DailyCost[] {
    const { since, until } = window ?? usageWindow(records, undefined, now);
    const positions = new Map<string, number>();
    const total: DailyCost[] = [];
    let cursor = since;
    for (let day = windowDays(since, until); day > 0; day--) {
        const key = dayKey(cursor);
        positions.set(key, total.length);
        total.push({ label: key, cost: 0 });
        cursor = dayWindow(key).until;
    }
    for (const record of records) {
        if (record.ts < since || record.ts >= until) continue;
        const index = positions.get(dayKey(record.ts));
        if (index !== undefined) total[index]!.cost += record.cost;
    }
    return total;
}

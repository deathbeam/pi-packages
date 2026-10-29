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

export type GroupMode = "provider" | "model" | "project";

export type GroupRow = {
    name: string;
    stats: Stats;
    requests: number;
    /** Nested model rows; only produced by provider grouping. */
    children?: GroupRow[];
};

const tokens = (s: Stats): number => s.input + s.output + s.cacheRead + s.cacheWrite;

/** Cost descending, then total tokens (so free models still rank by usage). */
const byCost = (a: GroupRow, b: GroupRow): number => b.stats.cost - a.stats.cost || tokens(b.stats) - tokens(a.stats);

type Tally = { stats: Stats; requests: number; models?: Map<string, Tally>; providers?: Set<string> };

const newTally = (): Tally => ({ stats: emptyStats(), requests: 0 });

/**
 * Aggregate records older than `sinceMs` into rows for one grouping mode.
 * Provider rows nest their models as children; model rows append `(n)` when n providers share the
 * model; project rows are keyed by the session cwd (delegates count toward their own cwd).
 */
export function buildRows(records: UsageRecord[], sinceMs = 0, mode: GroupMode = "provider"): GroupRow[] {
    const groups = new Map<string, Tally>();
    for (const record of records) {
        if (record.ts < sinceMs) continue;
        const key = mode === "provider" ? record.provider : mode === "model" ? record.model : record.cwd;
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
    const toRow = ([name, group]: [string, Tally]): GroupRow => ({
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

/** Totals for the summary block: one pass over the window. */
export function summarize(records: UsageRecord[], sinceMs = 0): Summary {
    const stats = emptyStats();
    let requests = 0;
    const sessions = new Set<string>();
    for (const record of records) {
        if (record.ts < sinceMs) continue;
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

/** Cost per local calendar day, oldest first, covering the `days` days ending today. */
export function dailyCosts(records: UsageRecord[], days: number, now = Date.now()): DailyCost[] {
    const buckets: DailyCost[] = [];
    const index = new Map<number, number>();
    const cursor = new Date(now);
    cursor.setHours(0, 0, 0, 0);
    for (let i = 0; i < days; i++) {
        index.set(cursor.getTime(), days - 1 - i);
        buckets.unshift({
            label: `${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`,
            cost: 0,
        });
        // setDate walks calendar days, so DST shifts cannot misplace a bucket.
        cursor.setDate(cursor.getDate() - 1);
    }
    for (const record of records) {
        const day = new Date(record.ts);
        day.setHours(0, 0, 0, 0);
        const at = index.get(day.getTime());
        if (at !== undefined) buckets[at]!.cost += record.cost;
    }
    return buckets;
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

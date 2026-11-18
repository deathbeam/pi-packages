import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
    buildDailySeries,
    buildRows,
    cacheView,
    collectUsage,
    comparison,
    dailyTotals,
    dayKey,
    dayWindow,
    matchesFilter,
    percentChange,
    seriesKey,
    startOfDay,
    summarize,
    usageWindow,
    windowDays,
    type UsageFilter,
    type UsageRecord,
} from "../src/usage.ts";

const now = Date.now();
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

/** Today minus `offset` days, at the current time of day. */
function daysAgo(offset: number): number {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    return date.getTime();
}

/** Noon local time, so the timestamp cannot land on a day boundary. */
const at = (date: string): number => new Date(`${date}T12:00:00`).getTime();
const midnight = (date: string): number => startOfDay(new Date(`${date}T12:00:00`).getTime());

function messageUsage(over: Record<string, unknown> = {}) {
    return {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.4, output: 0.1, total: 0.5 },
        ...over,
    };
}

function messageLine(provider: string, model: string, ts: number, usage: unknown): string {
    return JSON.stringify({
        type: "message",
        message: { role: "assistant", provider, model, timestamp: ts, usage },
    });
}

const sessionHeader = (id: string, cwd: string): string => JSON.stringify({ type: "session", version: 3, id, cwd });

function usageRecord(over: Partial<UsageRecord> = {}): UsageRecord {
    return {
        provider: "anthropic",
        model: "claude-x",
        ts: 0,
        cost: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cwd: "/tmp",
        sessionId: "s1",
        ...over,
    };
}

/** Writes a session tree under a fresh temp dir and returns its paths. */
function sessionTree(messages: string[]): { sessions: string; file: string; cacheFile: string } {
    const dir = tempDir("pi-usage-cache-");
    const sessions = join(dir, "sessions");
    mkdirSync(sessions);
    const file = join(sessions, "s.jsonl");
    writeFileSync(file, [sessionHeader("c1", "/tmp"), ...messages].join("\n"));
    return { sessions, file, cacheFile: join(dir, "cache.json") };
}

// Read-only fixture for every aggregation test: a parent session plus a delegate child session, four
// assistant messages in total. Rebuilt per file, not per test.
const sessionDir = tempDir("pi-usage-sessions-");
let records: UsageRecord[];

beforeAll(async () => {
    mkdirSync(join(sessionDir, "project"));
    mkdirSync(join(sessionDir, "delegates"));
    writeFileSync(
        join(sessionDir, "project", "parent.jsonl"),
        [
            sessionHeader("s1", "/tmp"),
            JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
            messageLine("anthropic", "claude-x", daysAgo(0), messageUsage()),
            messageLine("anthropic", "claude-x", daysAgo(40), messageUsage({ input: 1, output: 1, cost: 0.2 })),
            // The delegate tool result carries usage as well, but the child session below counts it.
            JSON.stringify({
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "delegate",
                    usage: messageUsage({ input: 50, output: 5, cost: { total: 0.1 } }),
                    content: [],
                },
            }),
            "not json at all",
        ].join("\n"),
    );
    // Delegate children (written by packages/pi-delegate) sit under sessions/delegates and carry their
    // own cwd. Both serve the same model, so model grouping must merge across providers.
    writeFileSync(
        join(sessionDir, "delegates", "child.jsonl"),
        [
            sessionHeader("d1", "/home/x/git/proj"),
            messageLine(
                "inferhub",
                "glm-5.3",
                daysAgo(1),
                messageUsage({ input: 50, output: 5, cacheRead: 500, cost: { total: 0.1 } }),
            ),
            messageLine(
                "openrouter",
                "glm-5.3",
                daysAgo(1),
                messageUsage({ input: 10, output: 1, cost: { total: 0.05 } }),
            ),
        ].join("\n"),
    );
    records = await collectUsage(sessionDir);
});

afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("collectUsage", () => {
    it("returns one record per assistant message and skips delegate tool results", () => {
        assert.deepEqual(records, [
            usageRecord({
                provider: "inferhub",
                model: "glm-5.3",
                ts: daysAgo(1),
                cost: 0.1,
                input: 50,
                output: 5,
                cacheRead: 500,
                cwd: "/home/x/git/proj",
                sessionId: "d1",
            }),
            usageRecord({
                provider: "openrouter",
                model: "glm-5.3",
                ts: daysAgo(1),
                cost: 0.05,
                input: 10,
                output: 1,
                cwd: "/home/x/git/proj",
                sessionId: "d1",
            }),
            usageRecord({ ts: daysAgo(0), cost: 0.5, input: 100, output: 10 }),
            usageRecord({ ts: daysAgo(40), cost: 0.2, input: 1, output: 1 }),
        ]);
    });

    it("returns nothing for a directory that does not exist", async () => {
        assert.deepEqual(await collectUsage(join(tempDir("pi-usage-missing-"), "sessions")), []);
    });
});

describe("buildRows", () => {
    it("groups models under the provider that served them, cost descending", () => {
        const providers = buildRows(records, 0, "provider");
        assert.deepEqual(
            providers.map((row) => [row.name, row.requests, row.stats.cost, row.stats.input]),
            [
                ["anthropic", 2, 0.7, 101],
                ["inferhub", 1, 0.1, 50],
                ["openrouter", 1, 0.05, 10],
            ],
        );
        assert.deepEqual(
            providers.flatMap((row) => row.children!.map((child) => [row.name, child.name, child.stats.cacheRead])),
            [
                ["anthropic", "claude-x", 0],
                ["inferhub", "glm-5.3", 500],
                ["openrouter", "glm-5.3", 0],
            ],
        );
    });

    it("merges one model across providers and appends the provider count", () => {
        const models = buildRows(records, 0, "model");
        assert.deepEqual(
            models.map((row) => [row.name, row.requests, row.stats.input]),
            [
                ["claude-x", 2, 101],
                ["glm-5.3 (2)", 2, 60],
            ],
        );
        assert.equal(models[0].stats.cost, 0.7);
        assert.ok(Math.abs(models[1].stats.cost - 0.15) < 1e-12); // 0.1 + 0.05 in binary floats
    });

    it("groups by the session cwd", () => {
        const projects = buildRows(records, 0, "project");
        assert.deepEqual(
            projects.map((row) => [row.name, row.requests]),
            [
                ["/tmp", 2],
                ["/home/x/git/proj", 2],
            ],
        );
        assert.equal(projects[0].stats.cost, 0.7);
        assert.ok(Math.abs(projects[1].stats.cost - 0.15) < 1e-12);
    });

    it("drops records older than sinceMs", () => {
        assert.deepEqual(
            buildRows(records, daysAgo(29), "provider").map((row) => [row.name, row.stats.cost]),
            [
                ["anthropic", 0.5],
                ["inferhub", 0.1],
                ["openrouter", 0.05],
            ],
        );
        assert.equal(buildRows(records, now + 1000, "model").length, 0);
    });

    it("returns one row per local day, newest first, with day-over-day deltas", () => {
        const window = usageWindow(records, undefined, now);
        const days = buildRows(records, window.since, "day", window.until);
        assert.deepEqual(days.map((row) => row.name).slice(0, 2), [dayKey(daysAgo(0)), dayKey(daysAgo(1))]);
        assert.equal(days.at(-1)!.name, dayKey(daysAgo(40)));
        assert.equal(days.find((row) => row.name === dayKey(daysAgo(2)))!.stats.cost, 0);
        assert.ok(Math.abs(days[1].stats.cost - 0.15) < 1e-12);
        assert.equal(days[1].delta, Infinity);
        assert.equal(days[2].delta, 0);
        assert.equal(days.at(-1)!.delta, undefined);
    });

    it("bounds a single day with untilMs", () => {
        const start = startOfDay(daysAgo(1));
        const end = dayWindow(dayKey(daysAgo(1))).until;
        assert.deepEqual(
            buildRows(records, start, "provider", end).map((row) => row.name),
            ["inferhub", "openrouter"],
        );
    });

    it("fills a day range with empty rows", () => {
        assert.equal(buildRows([], midnight("2025-05-01"), "day", midnight("2025-05-04")).length, 3);
    });

    it("rejects a day grouping without a finite window", () => {
        assert.throws(() => buildRows([], 0, "day"), RangeError);
    });
});

describe("summarize", () => {
    it("totals a window and counts distinct sessions", () => {
        const all = summarize(records);
        assert.deepEqual([all.requests, all.sessions, all.stats.input], [4, 2, 161]);
        assert.ok(Math.abs(all.stats.cost - 0.85) < 1e-12);

        const yesterday = summarize(records, startOfDay(daysAgo(1)), dayWindow(dayKey(daysAgo(1))).until);
        assert.equal(yesterday.requests, 2);
        assert.ok(Math.abs(yesterday.stats.cost - 0.15) < 1e-12);

        const recent = summarize(records, daysAgo(29));
        assert.equal(recent.requests, 3);
        assert.ok(Math.abs(recent.stats.cost - 0.65) < 1e-12);

        assert.equal(summarize([], 0).sessions, 0);
    });
});

describe("dayWindow", () => {
    it("starts a day at local midnight", () => {
        assert.equal(startOfDay(at("2025-09-07")), midnight("2025-09-07"));
        const window = dayWindow("2025-09-07");
        assert.equal(window.until, midnight("2025-09-08"));
        assert.equal(windowDays(window.since, window.until), 1);
    });

    it("counts calendar days, not 24-hour spans", () => {
        assert.equal(windowDays(midnight("2025-03-08"), midnight("2025-03-11")), 3);
    });

    it("shifts by whole local days", () => {
        assert.equal(dayWindow("2025-09-07", 1).since, midnight("2025-09-08"));
        assert.equal(dayWindow("2025-09-08", -1).since, midnight("2025-09-07"));
    });

    it("aggregates on local days across a DST change", () => {
        const window = dayWindow("2025-09-07");
        const dstRecords = [
            usageRecord({ ts: midnight("2025-09-06") + 1_800_000, cost: 7 }),
            usageRecord({ ts: at("2025-09-07"), cost: 5 }),
            usageRecord({ ts: midnight("2025-09-08") + 1_800_000, cost: 9 }),
        ];
        assert.equal(summarize(dstRecords, window.since, window.until).stats.cost, 5);
        const rows = buildRows(dstRecords, window.since, "day", window.until);
        assert.deepEqual(
            rows.map((row) => [row.name, row.stats.cost]),
            [["2025-09-07", 5]],
        );
        assert.deepEqual(comparison(dstRecords, at("2025-09-08")), {
            today: 9,
            week: 9,
            lastWeek: 12 / 7,
            month: 21 / 8,
            lastMonth: 0,
        });
        assert.deepEqual(
            buildDailySeries(dstRecords, midnight("2025-09-06"), midnight("2025-09-10"), "day").total.map((d) => [
                d.label,
                d.cost,
            ]),
            [
                ["09-06", 7],
                ["09-07", 5],
                ["09-08", 9],
                ["09-09", 0],
            ],
        );
    });
});

describe("comparison", () => {
    const sample = [
        usageRecord({ ts: at("2025-04-20"), cost: 30 }),
        usageRecord({ ts: at("2025-05-08"), cost: 10 }),
        usageRecord({ provider: "other", ts: at("2025-05-14"), cost: 28 }),
        usageRecord({ ts: at("2025-05-21"), cost: 9 }),
        usageRecord({ ts: at("2025-05-22"), cost: 100 }),
    ];

    it("averages the daily cost of today, this week and this month against the previous ones", () => {
        assert.deepEqual(comparison(sample, at("2025-05-21")), {
            today: 9,
            week: 3,
            lastWeek: 4,
            month: 47 / 21,
            lastMonth: 1,
        });
        assert.deepEqual(comparison([], at("2025-05-21")), {
            today: 0,
            week: 0,
            lastWeek: 0,
            month: 0,
            lastMonth: 0,
        });
        assert.equal(
            comparison(
                sample.filter((record) => matchesFilter(record, { mode: "provider", key: "other" })),
                at("2025-05-21"),
            ).lastWeek,
            4,
        );
    });

    it("starts the week on Monday", () => {
        const monday = comparison(
            [usageRecord({ ts: at("2025-05-18"), cost: 7 }), usageRecord({ ts: at("2025-05-19"), cost: 10 })],
            at("2025-05-19"),
        );
        assert.deepEqual([monday.week, monday.lastWeek], [10, 1]);
    });

    it("counts the leap day in the month window", () => {
        const leap = comparison(
            [usageRecord({ ts: at("2024-02-29"), cost: 58 }), usageRecord({ ts: at("2024-03-01"), cost: 6 })],
            at("2024-03-03"),
        );
        assert.deepEqual([leap.month, leap.lastMonth], [2, 2]);
    });
});

describe("matchesFilter", () => {
    it("matches a record by provider, model, project or day", () => {
        const record = usageRecord({
            provider: "openrouter",
            model: "glm-5.3",
            cwd: "/home/x/git/proj",
            ts: at("2025-05-14"),
        });
        const filters: UsageFilter[] = [
            { mode: "provider", key: "openrouter" },
            { mode: "provider", key: "anthropic" },
            { mode: "model", key: "glm-5.3" },
            { mode: "project", key: "/home/x/git/proj" },
            { mode: "day", key: "2025-05-14" },
        ];
        assert.deepEqual(
            filters.map((filter) => matchesFilter(record, filter)),
            [true, false, true, true, true],
        );
    });
});

describe("percentChange", () => {
    it("reports growth, decline and a zero baseline", () => {
        assert.deepEqual([percentChange(0, 0), percentChange(0, 1)], [0, -100]);
        assert.equal(percentChange(1, 0), Infinity);
    });
});

describe("usageWindow", () => {
    it("spans the first record through the end of today", () => {
        assert.deepEqual(usageWindow(records, undefined, now), {
            since: dayWindow(dayKey(daysAgo(40))).since,
            until: dayWindow(dayKey(now)).until,
        });
    });

    it("uses the given day instead of the records", () => {
        assert.deepEqual(usageWindow(records, "2025-05-21", at("2025-05-21")), dayWindow("2025-05-21"));
    });
});

describe("buildDailySeries", () => {
    const seriesRecords = [
        usageRecord({ provider: "a", model: "shared", ts: at("2025-05-19"), cost: 2 }),
        usageRecord({ provider: "b", model: "shared", ts: at("2025-05-20"), cost: 3 }),
        usageRecord({ provider: "a", model: "other", ts: at("2025-05-21"), cost: 4 }),
        usageRecord({ provider: "a", model: "shared", ts: at("2025-05-18"), cost: 100 }),
    ];
    const costsOf = (result: ReturnType<typeof buildDailySeries>, key: string, parentKey?: string) =>
        result.total.map((_, index) => result.rows.get(seriesKey(key, parentKey))?.get(index) ?? 0);

    it("fills one column per bucket for the total and per provider and model", () => {
        const series = buildDailySeries(seriesRecords, midnight("2025-05-19"), midnight("2025-05-22"), "provider");
        assert.deepEqual(
            series.total.map((day) => day.cost),
            [2, 3, 4],
        );
        assert.deepEqual(costsOf(series, "a"), [2, 0, 4]);
        assert.deepEqual(costsOf(series, "shared", "a"), [2, 0, 0]);
        assert.deepEqual(costsOf(series, "b"), [0, 3, 0]);
    });

    it("buckets by day and excludes records outside the window", () => {
        const daySeries = buildDailySeries(seriesRecords, midnight("2025-05-19"), midnight("2025-05-22"), "day");
        assert.deepEqual(costsOf(daySeries, "2025-05-20"), [0, 3, 0]);
    });

    it("covers the last three local days from the record corpus", () => {
        const costs = buildDailySeries(
            records,
            dayWindow(dayKey(now), -2).since,
            dayWindow(dayKey(now)).until,
            "provider",
        ).total;
        assert.equal(costs.length, 3);
        assert.equal(costs[0].cost, 0); // day before yesterday
        assert.ok(Math.abs(costs[1].cost - 0.15) < 1e-12); // yesterday
        assert.equal(costs[2].cost, 0.5); // today
        const total = costs.reduce((sum, day) => sum + day.cost, 0);
        assert.equal(total, 0.65); // the 40-day-old record is excluded
    });
});

describe("dailyTotals", () => {
    it("spans the first recorded day through today", () => {
        const totals = dailyTotals(records, now);
        assert.equal(totals.length, 41); // daysAgo(40) through today
        assert.deepEqual([totals[0].label, totals.at(-1)!.label], [dayKey(daysAgo(40)).slice(5), dayKey(now).slice(5)]);
        assert.equal(totals.at(-1)!.cost, 0.5); // today
        assert.ok(Math.abs(totals.at(-2)!.cost - 0.15) < 1e-12); // yesterday
        assert.ok(Math.abs(totals.reduce((sum, day) => sum + day.cost, 0) - 0.85) < 1e-12);
        assert.deepEqual(dailyTotals([], now), []);
    });
});

describe("cacheView", () => {
    it("re-derives only when the grouping or the day changes", () => {
        let scans = 0;
        const view = cacheView(() => ++scans);
        for (let cursor = 0; cursor < 3; cursor++) assert.equal(view("day", [], now), 1);
        assert.equal(view("provider", [], now), 2);
        assert.equal(view("provider", [{ mode: "provider", key: "anthropic" }], now), 3);
    });
});

describe("usage cache", () => {
    const first = messageLine("anthropic", "claude-x", daysAgo(0), messageUsage());
    const second = messageLine("openrouter", "glm-5.3", daysAgo(1), messageUsage({ cost: { total: 0.25 } }));

    it("writes a fresh scan to the cache and serves it on the next scan", async () => {
        const { sessions, file, cacheFile } = sessionTree([first]);
        const cold = await collectUsage(sessions, undefined, cacheFile);
        assert.deepEqual(await collectUsage(sessions, undefined, cacheFile), cold);
        assert.deepEqual(await collectUsage(sessions), cold); // the cached result equals a fresh scan
        assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")).files[file].records, cold);
    });

    it("re-parses a session file that grew", async () => {
        const { sessions, file, cacheFile } = sessionTree([first]);
        await collectUsage(sessions, undefined, cacheFile);
        writeFileSync(file, [sessionHeader("c1", "/tmp"), first, second].join("\n"));
        assert.deepEqual(
            (await collectUsage(sessions, undefined, cacheFile)).map((record) => record.provider),
            ["anthropic", "openrouter"],
        );
    });

    it("drops files that disappeared from the cache", async () => {
        const { sessions, cacheFile } = sessionTree([first]);
        await collectUsage(sessions, undefined, cacheFile);
        rmSync(sessions, { recursive: true });
        assert.deepEqual(await collectUsage(sessions, undefined, cacheFile), []);
        assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")).files, {});
    });

    it("rebuilds a corrupt cache", async () => {
        const { sessions, cacheFile } = sessionTree([first]);
        writeFileSync(cacheFile, "{not json");
        assert.deepEqual(await collectUsage(sessions, undefined, cacheFile), await collectUsage(sessions));
    });
});

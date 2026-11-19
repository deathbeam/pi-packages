import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
    buildRows,
    cacheView,
    collectUsage,
    comparison,
    dailyTotals,
    dayKey,
    dayWindow,
    matchesFilter,
    percentChange,
    startOfDay,
    summarize,
    usageWindow,
    windowDays,
    type DailyCost,
    type UsageFilter,
    type UsageRecord,
} from "../src/usage.ts";
import { busiestDay, heatmap, streaks, summaryModel, topGroups, topSessions } from "../src/summary.ts";

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

function messageLine(provider: string, model: string, ts: number, usage: unknown, content: unknown[] = []): string {
    return JSON.stringify({
        type: "message",
        message: { role: "assistant", provider, model, timestamp: ts, content, usage },
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
        requests: 1,
        tools: {},
        skills: {},
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

    it("names a typeless assistant line instead of leaving its row unnamed", async () => {
        const tree = tempDir("pi-usage-typeless-");
        writeFileSync(
            join(tree, "session.jsonl"),
            [
                sessionHeader("s1", "/tmp"),
                JSON.stringify({ role: "assistant", usage: messageUsage({ cost: 0.5 }) }),
            ].join("\n"),
        );
        const parsed = await collectUsage(tree);
        assert.deepEqual(
            parsed.map((record) => [record.provider, record.model]),
            [["(summaries)", "unknown"]],
        );
        for (const name of buildRows(parsed, 0, "model").map((row) => row.name)) assert.equal(typeof name, "string");
    });

    it("counts tool calls and skill reads, merged per day", async () => {
        const tree = tempDir("pi-usage-tools-");
        function toolCall(name: string, args: Record<string, unknown>) {
            return { type: "toolCall", id: `call-${name}`, name, arguments: args };
        }
        writeFileSync(
            join(tree, "session.jsonl"),
            [
                sessionHeader("s1", "/tmp"),
                messageLine("anthropic", "claude-x", daysAgo(0), messageUsage(), [
                    toolCall("read", { path: "/home/x/.agents/skills/prepare-plan/SKILL.md" }),
                    toolCall("bash", { command: "ls" }),
                ]),
                messageLine("anthropic", "claude-x", daysAgo(0) + 1000, messageUsage(), [
                    toolCall("bash", { command: "ls" }),
                    toolCall("read", { path: "/tmp/notes.md" }),
                    toolCall("edit", { path: "/tmp/notes.md", oldText: "a", newText: "b" }),
                ]),
            ].join("\n"),
        );
        const [record, ...rest] = await collectUsage(tree);
        assert.equal(rest.length, 0, "both messages count into one day record");
        assert.deepEqual(record!.tools, { read: 2, bash: 2, edit: 1 });
        assert.deepEqual(record!.skills, { "prepare-plan": 1 }, "only a SKILL.md read names a skill");
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

    it("merges one model across providers", () => {
        const models = buildRows(records, 0, "model");
        assert.deepEqual(
            models.map((row) => [row.name, row.requests, row.stats.input]),
            [
                ["claude-x", 2, 101],
                ["glm-5.3", 2, 60],
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
            weekTotal: 9,
            lastWeek: 12 / 7,
            month: 21 / 8,
            monthTotal: 21,
            lastMonth: 0,
            lastMonthTotal: 0,
        });
        assert.deepEqual(
            dailyTotals(dstRecords, { since: midnight("2025-09-06"), until: midnight("2025-09-10") }).map((day) => [
                day.label,
                day.cost,
            ]),
            [
                ["2025-09-06", 7],
                ["2025-09-07", 5],
                ["2025-09-08", 9],
                ["2025-09-09", 0],
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

    it("totals and averages the week and month against the previous ones", () => {
        assert.deepEqual(comparison(sample, at("2025-05-21")), {
            today: 9,
            week: 3,
            weekTotal: 9,
            lastWeek: 4,
            month: 47 / 21,
            monthTotal: 47,
            lastMonth: 1,
            lastMonthTotal: 30,
        });
        assert.deepEqual(comparison([], at("2025-05-21")), {
            today: 0,
            week: 0,
            weekTotal: 0,
            lastWeek: 0,
            month: 0,
            monthTotal: 0,
            lastMonth: 0,
            lastMonthTotal: 0,
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
        assert.deepEqual([monday.week, monday.weekTotal, monday.lastWeek], [10, 10, 1]);
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

describe("dailyTotals", () => {
    it("spans the first recorded day through today", () => {
        const totals = dailyTotals(records, undefined, now);
        assert.equal(totals.length, 41); // daysAgo(40) through today
        assert.deepEqual([totals[0]!.label, totals.at(-1)!.label], [dayKey(daysAgo(40)), dayKey(now)]);
        assert.equal(totals.at(-1)!.cost, 0.5); // today
        assert.ok(Math.abs(totals.at(-2)!.cost - 0.15) < 1e-12); // yesterday
        assert.ok(Math.abs(totals.reduce((sum, day) => sum + day.cost, 0) - 0.85) < 1e-12);
        assert.deepEqual(dailyTotals([], undefined, now), []);
    });

    it("covers exactly the days of the given window", () => {
        const window = { since: dayWindow(dayKey(now), -2).since, until: dayWindow(dayKey(now)).until };
        const costs = dailyTotals(records, window);
        assert.equal(costs.length, 3);
        assert.equal(costs[0]!.cost, 0); // day before yesterday
        assert.ok(Math.abs(costs[1]!.cost - 0.15) < 1e-12); // yesterday
        assert.equal(costs[2]!.cost, 0.5); // today
        assert.equal(
            costs.reduce((sum, day) => sum + day.cost, 0),
            0.65,
        ); // the 40-day-old record is excluded
    });
});

describe("summary aggregation", () => {
    /** Contiguous days starting at `start`, the shape dailyTotals() produces. */
    function series(start: string, costs: number[]): DailyCost[] {
        const first = at(start);
        return costs.map((cost, i) => ({ label: dayKey(first + i * 86_400_000).slice(5), cost }));
    }

    it("counts the current and the longest run of active days", () => {
        assert.deepEqual(streaks([]), { current: 0, longest: 0 });
        assert.deepEqual(streaks(series("2025-05-01", [1, 0, 1, 1, 0, 1, 1, 1])), { current: 3, longest: 3 });
        assert.deepEqual(streaks(series("2025-05-01", [1, 1, 1, 1, 0])), { current: 0, longest: 4 });
        assert.deepEqual(streaks(series("2025-05-01", [2, 2])), { current: 2, longest: 2 });
    });

    it("finds the busiest day and ignores free days", () => {
        assert.deepEqual(busiestDay(series("2025-05-01", [1, 5, 3])), { label: "05-02", cost: 5 });
        assert.equal(busiestDay(series("2025-05-01", [0, 0])), undefined);
        assert.equal(busiestDay([]), undefined);
    });

    it("buckets days into a Monday-first grid ending on the current week", () => {
        // 2025-05-21 is a Wednesday, so a 2-week grid starts Mon 2025-05-12.
        const costs = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 3, 9];
        const heat = heatmap(series("2025-05-08", costs), 2, at("2025-05-21"));
        assert.equal(heat.header, "    May");
        // Log scale over a max of 9: cost 1 lands on level 2, 3 on level 3 and the max on level 4.
        assert.deepEqual(heat.rows[0]![0], { cost: 1, level: 2 });
        assert.deepEqual(heat.rows[1]![1], { cost: 3, level: 3 });
        assert.deepEqual(heat.rows[2]![1], { cost: 9, level: 4 });
        assert.deepEqual(heat.rows[3]![1], undefined); // Thursday is still in the future
    });

    it("leaves the grid empty before the first recorded day and shrinks to the history", () => {
        const daily = series("2025-05-14", [0, 0, 1, 0, 0, 2, 0, 4]); // 05-14 .. 05-21
        const heat = heatmap(daily, 2, at("2025-05-21"));
        assert.deepEqual(heat.rows[0]![0], undefined); // the week before the history starts
        assert.deepEqual(heat.rows[2]![0], { cost: 0, level: 0 });
        assert.deepEqual(heat.rows[4]![0], { cost: 1, level: 2 });
        assert.deepEqual(heat.rows[0]![1], { cost: 2, level: 3 });
        assert.deepEqual(heat.rows[2]![1], { cost: 4, level: 4 });
        assert.deepEqual(heat.rows[3]![1], undefined);
        // A wide terminal must not pad the grid with blank weeks.
        assert.equal(heatmap(daily, 40, at("2025-05-21")).rows[0]!.length, 2);
    });

    it("puts a mid-range day and the busiest day on different levels", () => {
        const levels = heatmap(series("2025-05-19", [1, 5, 100]), 1, at("2025-05-21"))
            .rows.flat()
            .map((cell) => cell?.level);
        assert.deepEqual(
            levels.filter((level) => level !== undefined),
            [1, 2, 4],
        );
    });

    it("labels a one-day calendar with that day's month", () => {
        const heat = heatmap(series("2025-05-21", [4]), 1, at("2025-05-21"));
        assert.equal(heat.header, "    May");
        assert.deepEqual(heat.rows[2]![0], { cost: 4, level: 4 });
        assert.equal(heat.rows.filter((row) => row.some((cell) => cell !== undefined)).length, 1);
    });

    const ranking = [
        usageRecord({ sessionId: "aaa", cwd: "/home/deathbeam/git/x", ts: at("2025-05-10"), cost: 2 }),
        usageRecord({ sessionId: "aaa", cwd: "/home/deathbeam/git/x", ts: at("2025-05-11"), cost: 1 }),
        usageRecord({ sessionId: "bbb", cwd: "/tmp", ts: at("2025-05-12"), cost: 5, model: "other-model" }),
        usageRecord({ sessionId: "ccc", cwd: "", ts: at("2025-05-12"), cost: 0.5 }),
        usageRecord({ sessionId: "ddd", cwd: "/tmp", ts: at("2025-06-01"), cost: 100 }),
    ];

    it("ranks sessions by cost inside the window", () => {
        const top = topSessions(ranking, midnight("2025-05-01"), midnight("2025-05-21"), 2);
        assert.deepEqual(
            top.map((row) => [row.key, row.name, row.stats.cost, row.requests]),
            [
                ["bbb", "05-12 bbb tmp", 5, 1],
                ["aaa", "05-10 aaa x", 3, 2],
            ],
        );
    });

    it("ranks groups by cost and keeps the requested count", () => {
        const since = midnight("2025-05-01");
        const until = midnight("2025-05-21");
        assert.deepEqual(
            topGroups(ranking, since, until, "model", 1).map((row) => [row.name, row.stats.cost]),
            [["other-model", 5]],
        );
        assert.deepEqual(
            topGroups(ranking, since, until, "project").map((row) => [row.key, row.stats.cost]),
            [
                ["/tmp", 5],
                ["/home/deathbeam/git/x", 3],
                ["", 0.5],
            ],
        );
    });
});

describe("summaryModel", () => {
    const records = [
        usageRecord({ sessionId: "a", cwd: "/tmp/x", ts: at("2025-05-19"), cost: 2, requests: 2, cacheRead: 300 }),
        usageRecord({ sessionId: "a", cwd: "/tmp/x", ts: at("2025-05-20"), cost: 3, requests: 4 }),
        usageRecord({ sessionId: "b", cwd: "/tmp/x", ts: at("2025-05-21"), cost: 5 }),
    ];
    const model = summaryModel(records, true, at("2025-05-21"));

    it("totals the active records and averages per active day and session", () => {
        assert.deepEqual([model.stats.cost, model.requests, model.sessions], [10, 7, 2]);
        assert.deepEqual([model.activeDays, model.perDay, model.perSession], [3, 10 / 3, 5]);
        assert.deepEqual(model.streak, { current: 3, longest: 3 });
        assert.deepEqual(model.busiest, { label: "2025-05-21", cost: 5 });
        assert.equal(model.daily.length, 3);
    });

    it("builds the calendar over the given window instead of through today", () => {
        const window = dayWindow("2025-05-20");
        const scoped = records.filter((record) => record.ts >= window.since && record.ts < window.until);
        const day = summaryModel(scoped, false, at("2025-05-21"), window);
        assert.deepEqual(day.daily, [{ label: "2025-05-20", cost: 3 }]);
        assert.deepEqual([day.activeDays, day.perDay, day.busiest?.label], [1, 3, "2025-05-20"]);
    });

    it("compares the week and month so far with the previous ones", () => {
        assert.equal(model.trends?.today, 5);
        assert.equal(model.trends?.week, 10 / 3);
        assert.equal(model.trends?.weekDelta, Infinity); // last week had no spend
        assert.equal(summaryModel(records, false, at("2025-05-21")).trends, undefined);
    });

    it("projects the month from the daily average so far", () => {
        // $10 over the 21 days of May 2025 that had started; February has 28 days and 10 had started.
        assert.equal(model.trends?.projection, (10 / 21) * 31);
        const february = [usageRecord({ ts: at("2025-02-01"), cost: 10 })];
        assert.equal(summaryModel(february, true, at("2025-02-10")).trends?.projection, 28);
    });

    it("splits the delegate child cost out of the total", () => {
        const mixed = [
            usageRecord({ sessionId: "main", ts: at("2025-05-21"), cost: 3 }),
            usageRecord({ sessionId: "delegate-cee55d71", ts: at("2025-05-21"), cost: 1 }),
        ];
        assert.deepEqual(summaryModel(mixed, false, at("2025-05-21")).delegates, { cost: 1, share: 0.25 });
        assert.deepEqual(summaryModel([], true, at("2025-05-21")).delegates, { cost: 0, share: 0 });
    });

    it("ranks the top providers next to the models and projects", () => {
        const mixed = [
            usageRecord({ provider: "openai", ts: at("2025-05-21"), cost: 4 }),
            usageRecord({ provider: "anthropic", ts: at("2025-05-21"), cost: 6 }),
            usageRecord({ provider: "google", ts: at("2025-05-21"), cost: 0.5 }),
        ];
        assert.deepEqual(
            summaryModel(mixed, false, at("2025-05-21")).top.providers.map((row) => [row.name, row.stats.cost]),
            [
                ["anthropic", 6],
                ["openai", 4],
                ["google", 0.5],
            ],
        );
    });

    it("ranks the top models, projects and sessions by cost", () => {
        assert.deepEqual(
            model.top.models.map((row) => [row.name, row.stats.cost]),
            [["claude-x", 10]],
        );
        assert.deepEqual(
            model.top.projects.map((row) => [row.key, row.stats.cost]),
            [["/tmp/x", 10]],
        );
        // Equal cost breaks the tie on requests, so the busier session comes first.
        assert.deepEqual(
            model.top.sessions.map((row) => [row.key, row.stats.cost]),
            [
                ["a", 5],
                ["b", 5],
            ],
        );
    });

    it("degrades to zeros on an empty record set", () => {
        const empty = summaryModel([], true, at("2025-05-21"));
        assert.deepEqual([empty.stats.cost, empty.activeDays, empty.perDay, empty.perSession], [0, 0, 0, 0]);
        assert.deepEqual(empty.streak, { current: 0, longest: 0 });
        assert.equal(empty.busiest, undefined);
        assert.deepEqual(empty.daily, []);
        assert.deepEqual(empty.top, {
            models: [],
            providers: [],
            projects: [],
            sessions: [],
            tools: [],
            skills: [],
            toolCalls: 0,
            skillCalls: 0,
        });
        assert.deepEqual(empty.delegates, { cost: 0, share: 0 });
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

    it("stops at the first file when aborted and leaves the cache alone", async () => {
        const { sessions, cacheFile } = sessionTree([first, second]);
        const controller = new AbortController();
        controller.abort();
        assert.deepEqual(await collectUsage(sessions, undefined, cacheFile, controller.signal), []);
        assert.equal(existsSync(cacheFile), false);
    });

    it("stores one record per day, provider, model, cwd and session", async () => {
        const { sessions, file, cacheFile } = sessionTree([
            messageLine("anthropic", "claude-x", daysAgo(0), messageUsage()),
            messageLine("anthropic", "claude-x", daysAgo(0), messageUsage({ cost: { total: 0.25 } })),
            messageLine("anthropic", "claude-x", daysAgo(1), messageUsage()),
        ]);
        const aggregated = await collectUsage(sessions, undefined, cacheFile);
        assert.deepEqual(
            aggregated.map((record) => [dayKey(record.ts), record.requests, record.cost]),
            [
                [dayKey(daysAgo(0)), 2, 0.75],
                [dayKey(daysAgo(1)), 1, 0.5],
            ],
        );
        assert.equal(buildRows(aggregated, 0, "model")[0]!.requests, 3);
        assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).files[file].records.length, 2);
    });

    it("skips an assistant message that reports no tokens and no cost", async () => {
        const { sessions } = sessionTree([
            messageLine("combo", "cheap", daysAgo(0), messageUsage({ input: 0, output: 0, cost: { total: 0 } })),
            messageLine("anthropic", "claude-x", daysAgo(0), messageUsage()),
        ]);
        assert.deepEqual(
            (await collectUsage(sessions)).map((record) => [record.provider, record.model, record.requests]),
            [["anthropic", "claude-x", 1]],
        );
    });
});

describe("non-message usage entries", () => {
    it("counts usage entries and summarization calls like pi does", async () => {
        const stamp = new Date(at("2025-01-02")).toISOString();
        const { sessions } = sessionTree([
            JSON.stringify({
                type: "usage",
                timestamp: stamp,
                kind: "cache_warm",
                provider: "anthropic",
                model: "claude-x",
                usage: messageUsage({ input: 0, output: 0, cost: { total: 0.015 } }),
            }),
            JSON.stringify({
                type: "compaction",
                timestamp: stamp,
                usage: messageUsage({ input: 1000, output: 100, cost: { total: 0.3 } }),
            }),
            JSON.stringify({
                type: "branch_summary",
                timestamp: stamp,
                usage: messageUsage({ input: 200, output: 20, cost: { total: 0.2 } }),
            }),
            // Tool results keep their own session files; counting them here would double-count.
            JSON.stringify({
                type: "message",
                message: { role: "toolResult", toolName: "bash", usage: messageUsage(), content: [] },
            }),
        ]);
        const parsed = await collectUsage(sessions);
        assert.deepEqual(
            parsed.map((record) => [record.provider, record.model, record.cost, record.input, record.requests]),
            [
                ["anthropic", "claude-x", 0.015, 0, 1],
                ["(summaries)", "compaction", 0.3, 1000, 1],
                ["(summaries)", "branch_summary", 0.2, 200, 1],
            ],
        );
        assert.equal(summarize(parsed).requests, 3);
    });
});

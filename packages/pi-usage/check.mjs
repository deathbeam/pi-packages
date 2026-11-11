import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildRows,
    buildDailySeries,
    bucketCosts,
    bucketKey,
    bucketWindow,
    cacheView,
    clearTimeFilters,
    collectUsage,
    dayKey,
    isTimeFilter,
    matchesFilter,
    percentChange,
    previousSummary,
    seriesKey,
    stepFilter,
    summarize,
    usageWindow,
    windowDays,
} from "./usage.ts";

const now = Date.now();
const day = (offset) => {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    return date.getTime();
};

const dir = mkdtempSync(join(tmpdir(), "pi-usage-check-"));
mkdirSync(join(dir, "project"));
mkdirSync(join(dir, "delegates"));
const usage = (over) => ({
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0.4, output: 0.1, total: 0.5 },
    ...over,
});
const assistant = (provider, model, ts, u) =>
    JSON.stringify({
        type: "message",
        message: { role: "assistant", provider, model, timestamp: ts, usage: u },
    });

// Parent session: one assistant message, plus a delegate tool result whose usage must be ignored
// because the child session below already counts it.
writeFileSync(
    join(dir, "project", "parent.jsonl"),
    [
        JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
        assistant("anthropic", "claude-x", day(0), usage({})),
        assistant("anthropic", "claude-x", day(40), usage({ input: 1, output: 1, cost: 0.2 })), // cost as plain number
        JSON.stringify({
            type: "message",
            message: {
                role: "toolResult",
                toolName: "delegate",
                usage: usage({ input: 50, output: 5, cost: { total: 0.1 } }),
                content: [],
            },
        }),
        "not json at all",
    ].join("\n"),
);
// Delegate child sessions (packages/pi-delegate writes these under sessions/delegates), one per
// provider, both on the same model so model grouping must aggregate across providers.
writeFileSync(
    join(dir, "delegates", "child.jsonl"),
    [
        JSON.stringify({ type: "session", version: 3, id: "d1", cwd: "/home/x/git/proj" }),
        assistant("inferhub", "glm-5.3", day(1), usage({ input: 50, output: 5, cacheRead: 500, cost: { total: 0.1 } })),
        assistant("openrouter", "glm-5.3", day(1), usage({ input: 10, output: 1, cost: { total: 0.05 } })),
    ].join("\n"),
);

try {
    const records = await collectUsage(dir);
    // The delegate toolResult's usage is skipped, so exactly the four assistant messages remain.
    assert.equal(records.length, 4);
    // readdir is alphabetical, so the delegates file is scanned before the parent session.
    const [inferhub, openrouter, parent, old] = records;
    assert.equal(parent.cwd, "/tmp");
    assert.equal(parent.sessionId, "s1");
    assert.equal(inferhub.cwd, "/home/x/git/proj"); // cwd from the child's own session header
    assert.equal(inferhub.sessionId, "d1");

    // Provider grouping: models nested under their provider, cost descending.
    const providers = buildRows(records, 0, "provider");
    assert.deepEqual(
        providers.map((r) => r.name),
        ["anthropic", "inferhub", "openrouter"],
    );
    assert.equal(providers[0].stats.cost, 0.7);
    assert.equal(providers[0].stats.input, 101);
    assert.equal(providers[0].requests, 2);
    assert.deepEqual(
        providers[0].children.map((c) => c.name),
        ["claude-x"],
    );
    assert.equal(providers[0].children[0].stats.cacheRead, 0);
    assert.equal(providers[1].children[0].stats.cacheRead, 500);
    assert.equal(providers[2].stats.cost, 0.05);

    // Model grouping: the same model from two providers merges, with the provider count appended.
    const models = buildRows(records, 0, "model");
    assert.deepEqual(
        models.map((r) => r.name),
        ["claude-x", "glm-5.3 (2)"],
    );
    assert.equal(models[0].stats.cost, 0.7);
    assert.ok(Math.abs(models[1].stats.cost - 0.15) < 1e-12); // 0.1 + 0.05 in binary floats
    assert.equal(models[1].requests, 2);
    assert.equal(models[1].stats.input, 60);

    // Project grouping: by session cwd; delegate children count toward their own cwd.
    const projects = buildRows(records, 0, "project");
    assert.deepEqual(
        projects.map((r) => r.name),
        ["/tmp", "/home/x/git/proj"],
    );
    assert.equal(projects[0].stats.cost, 0.7);
    assert.ok(Math.abs(projects[1].stats.cost - 0.15) < 1e-12);
    assert.equal(projects[1].requests, 2);

    // A sinceMs cutoff drops older records (day(40) is outside a 30-day window).
    assert.deepEqual(
        buildRows(records, day(29), "provider").map((r) => r.name),
        ["anthropic", "inferhub", "openrouter"],
    );
    assert.equal(buildRows(records, day(29), "provider")[0].stats.cost, 0.5);
    assert.equal(buildRows(records, now + 1000, "model").length, 0);

    // Day grouping: one row per local day, newest first; untilMs bounds a single-day window.
    const allWindow = usageWindow(records, Infinity, [], now);
    const days = buildRows(records, allWindow.since, "day", allWindow.until);
    assert.equal(days[0].name, dayKey(day(0)));
    assert.equal(days[1].name, dayKey(day(1)));
    assert.equal(days.at(-1).name, dayKey(day(40)));
    assert.equal(days.find((r) => r.name === dayKey(day(2))).stats.cost, 0);
    assert.ok(Math.abs(days[1].stats.cost - 0.15) < 1e-12);
    const start = new Date(day(1));
    start.setHours(0, 0, 0, 0);
    const end = new Date(bucketWindow(dayKey(day(1)), "day").until);
    assert.equal(summarize(records, start.getTime(), end.getTime()).requests, 2);
    assert.deepEqual(
        buildRows(records, start.getTime(), "provider", end.getTime()).map((r) => r.name),
        ["inferhub", "openrouter"],
    );

    // Summary: totals, request and session counts, cache hit ratio.
    const all = summarize(records);
    assert.ok(Math.abs(all.stats.cost - 0.85) < 1e-12);
    assert.equal(all.requests, 4);
    assert.equal(all.sessions, 2);
    assert.equal(all.stats.input, 161);
    assert.ok(Math.abs(all.hit - 500 / 661) < 1e-12); // cacheRead / (input + cacheRead + cacheWrite)
    const recent = summarize(records, day(29));
    assert.ok(Math.abs(recent.stats.cost - 0.65) < 1e-12);
    assert.equal(recent.requests, 3);
    assert.ok(Math.abs(recent.hit - 500 / 660) < 1e-12); // only the delegate child has cache reads
    const empty = summarize([], 0);
    assert.equal(empty.sessions, 0);

    const at = (date) => new Date(`${date}T12:00:00`).getTime();
    const midnight = (date) => new Date(`${date}T00:00:00`).getTime();
    assert.equal(bucketKey(at("2025-05-11"), "week"), "2025-05-05");
    assert.equal(bucketKey(at("2025-05-12"), "week"), "2025-05-12");
    assert.equal(bucketKey(bucketWindow("2025-01", "month", -1).since, "month"), "2024-12");
    assert.equal(bucketWindow("2025-02", "month").until, midnight("2025-03-01"));
    assert.equal(windowDays(midnight("2025-03-08"), midnight("2025-03-11")), 3);
    const dst = bucketWindow("2025-09-07", "day");
    assert.equal(dst.until, midnight("2025-09-08"));
    assert.equal(windowDays(dst.since, dst.until), 1);
    assert.equal(usageWindow([], 7, [], at("2025-09-07")).days, 7);
    assert.equal(usageWindow([], 7, [], at("2025-09-13")).since, midnight("2025-09-07"));
    const dstRecords = [
        { ...parent, ts: midnight("2025-09-06") + 1_800_000, cost: 7 },
        { ...parent, ts: at("2025-09-07"), cost: 5 },
        { ...parent, ts: midnight("2025-09-08") + 1_800_000, cost: 9 },
    ];
    assert.equal(previousSummary(dstRecords, dst.since, 1).stats.cost, 7);
    assert.equal(summarize(dstRecords, dst.since, dst.until).stats.cost, 5);
    const dstRows = buildRows(dstRecords, dst.since, "day", dst.until);
    assert.equal(dstRows.length, 1);
    assert.equal(dstRows[0].perDay, 5);
    const dstSeries = buildDailySeries(dstRecords, midnight("2025-09-06"), midnight("2025-09-10"), "day", []);
    assert.deepEqual(
        dstSeries.total.map((d) => [d.label, d.cost]),
        [
            ["09-06", 7],
            ["09-07", 5],
            ["09-08", 9],
            ["09-09", 0],
        ],
    );

    const sample = [
        { ...parent, ts: at("2025-05-08"), cost: 10 },
        { ...parent, ts: at("2025-05-14"), cost: 28 },
        { ...parent, ts: at("2025-05-21"), cost: 9 },
        { ...parent, ts: at("2025-05-22"), cost: 100 },
    ];
    const weeks = buildRows(sample, midnight("2025-05-07"), "week", midnight("2025-05-22"));
    assert.deepEqual(
        weeks.map((row) => row.key),
        ["2025-05-19", "2025-05-12", "2025-05-05"],
    );
    assert.deepEqual(
        weeks.map((row) => row.perDay),
        [3, 4, 2],
    );
    assert.deepEqual(
        weeks.map((row) => row.delta),
        [-25, 100, undefined],
    );
    assert.equal(percentChange(0, 0), 0);
    assert.equal(percentChange(1, 0), Infinity);
    assert.equal(percentChange(0, 1), -100);
    const months = buildRows(sample, midnight("2025-03-20"), "month", midnight("2025-05-22"));
    assert.deepEqual(
        months.map((row) => row.key),
        ["2025-05", "2025-04", "2025-03"],
    );
    assert.equal(months[0].stats.cost, 47);
    assert.equal(months[1].stats.cost, 0);
    assert.equal(months[2].perDay, 0);
    assert.equal(months[0].delta, Infinity);
    assert.equal(buildRows([], midnight("2025-05-01"), "day", midnight("2025-05-04")).length, 3);
    assert.equal(buildRows([], midnight("2025-05-04"), "day", midnight("2025-05-04")).length, 0);
    assert.throws(() => buildRows([], 0, "day"), RangeError);
    assert.deepEqual(
        buildRows([], midnight("2099-01-01"), "day", midnight("2099-01-03")).map((r) => r.key),
        ["2099-01-02", "2099-01-01"],
    );

    const weekFilter = { mode: "week", key: "2025-05-19" };
    const window = usageWindow(sample, 30, [weekFilter], at("2025-05-21"));
    assert.deepEqual(window, { since: midnight("2025-05-19"), until: midnight("2025-05-22"), days: 3 });
    assert.equal(previousSummary(sample, window.since, window.days).stats.cost, 0);
    assert.equal(previousSummary(sample, midnight("2025-05-19"), 7).stats.cost, 28);
    assert.equal(matchesFilter(sample[2], weekFilter), true);
    assert.equal(matchesFilter(sample[1], weekFilter), false);
    assert.equal(models[1].key, "glm-5.3");
    const nested = usageWindow(sample, 30, [weekFilter, { mode: "day", key: "2025-05-21" }], at("2025-05-21"));
    assert.deepEqual(nested, { since: midnight("2025-05-21"), until: midnight("2025-05-22"), days: 1 });

    const monday = { mode: "day", key: "2025-05-19" };
    assert.equal(stepFilter([weekFilter, monday], -1, at("2025-05-21")), undefined);
    assert.equal(stepFilter([weekFilter, monday], 1, at("2025-05-21")), "2025-05-20");
    assert.equal(stepFilter([{ mode: "day", key: "2025-05-21" }], 1, at("2025-05-21")), undefined);
    assert.equal(stepFilter([weekFilter, { mode: "provider", key: "anthropic" }], -1, at("2025-05-21")), undefined);
    const outer = [
        { mode: "month", key: "2025-05" },
        { mode: "week", key: "2025-05-26" },
        { mode: "day", key: "2025-05-31" },
    ];
    assert.equal(stepFilter(outer, 1, at("2025-06-03")), undefined);
    assert.equal(stepFilter(outer, -1, at("2025-06-03")), "2025-05-30");
    assert.equal(isTimeFilter([weekFilter, monday].at(-1)), true);
    const keep = { filters: [{ mode: "provider", key: "anthropic" }], cursor: 3 };
    const stack = [{ filters: [weekFilter], cursor: 0 }, keep, { filters: [monday], cursor: 1 }];
    assert.equal(isTimeFilter(keep.filters.at(-1)), false);
    clearTimeFilters(stack);
    assert.deepEqual(stack, [keep]);

    let scans = 0;
    const view = cacheView(() => ++scans);
    for (let cursor = 0; cursor < 3; cursor++) assert.equal(view(2, "week", [weekFilter], now), 1);
    assert.equal(view(2, "day", [weekFilter], now), 2);
    assert.equal(view(2, "day", keep.filters, now), 3);
    assert.equal(view(3, "day", keep.filters, now), 4);

    const seriesRecords = [
        { ...parent, provider: "a", model: "shared", ts: at("2025-05-19"), cost: 2 },
        { ...parent, provider: "b", model: "shared", ts: at("2025-05-20"), cost: 3 },
        { ...parent, provider: "a", model: "other", ts: at("2025-05-21"), cost: 4 },
        { ...parent, provider: "a", model: "shared", ts: at("2025-05-18"), cost: 100 },
    ];
    const seriesRows = [{ key: "a" }, { key: "shared", parent: "a" }, { key: "b" }];
    let passes = 0;
    const once = [...seriesRecords];
    once[Symbol.iterator] = function* () {
        passes++;
        yield* seriesRecords;
    };
    const series = buildDailySeries(once, midnight("2025-05-19"), midnight("2025-05-22"), "provider", seriesRows);
    assert.equal(passes, 1);
    const costsOf = (result, key, parent) => result.rows.get(seriesKey(key, parent)).map((d) => d.cost);
    assert.deepEqual(
        series.total.map((d) => d.cost),
        [2, 3, 4],
    );
    assert.deepEqual(costsOf(series, "a"), [2, 0, 4]);
    assert.deepEqual(costsOf(series, "shared", "a"), [2, 0, 0]);
    assert.deepEqual(costsOf(series, "b"), [0, 3, 0]);
    const startSeries = midnight("2025-05-19"),
        endSeries = midnight("2025-05-22");
    const modelSeries = buildDailySeries(seriesRecords, startSeries, endSeries, "model", [{ key: "shared" }]);
    assert.deepEqual(costsOf(modelSeries, "shared"), [2, 3, 0]);
    const projectSeries = buildDailySeries(seriesRecords, startSeries, endSeries, "project", [{ key: parent.cwd }]);
    assert.deepEqual(costsOf(projectSeries, parent.cwd), [2, 3, 4]);
    const timeSeries = buildDailySeries(sample, midnight("2025-05-07"), endSeries, "week", weeks);
    assert.deepEqual(costsOf(timeSeries, "2025-05-19"), [0, 0, 9]);
    assert.deepEqual(
        timeSeries.rows.get(seriesKey("2025-05-05")).map((d) => d.label),
        ["05-07", "05-08", "05-09", "05-10", "05-11"],
    );
    const zeroSeries = buildDailySeries([], midnight("2025-05-07"), endSeries, "week", weeks);
    assert.deepEqual(costsOf(zeroSeries, "2025-05-19"), [0, 0, 0]);

    // Daily buckets: local calendar days, oldest first, out-of-range records excluded.
    const three = usageWindow(records, 3, [], now);
    const costs = buildDailySeries(records, three.since, three.until, "provider", []).total;
    assert.equal(costs.length, 3);
    assert.equal(costs[2].cost, 0.5); // today
    assert.ok(Math.abs(costs[1].cost - 0.15) < 1e-12); // yesterday
    assert.equal(costs[0].cost, 0); // day before
    const total = costs.reduce((sum, d) => sum + d.cost, 0);
    assert.equal(total, 0.65); // the 40-day-old record is excluded

    // Downsampling for the sparkline: 10 days into 4 bars (3+3+3+1) sums correctly and keeps the total.
    const ten = Array.from({ length: 10 }, (_, i) => ({ label: `d${i}`, cost: i + 1 }));
    const bars = bucketCosts(ten, 3);
    assert.deepEqual(
        bars.map((b) => b.cost),
        [1 + 2 + 3, 4 + 5 + 6, 7 + 8 + 9, 10],
    );
    assert.deepEqual(
        bars.map((b) => b.label),
        ["d0", "d3", "d6", "d9"],
    );
    assert.equal(
        bars.reduce((sum, b) => sum + b.cost, 0),
        55,
    );
    assert.equal(bucketCosts(ten, 1), ten); // no bucketing when every day fits

    console.log("pi-usage check passed");
} finally {
    rmSync(dir, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRows, bucketCosts, collectUsage, dailyCosts, summarize } from "./usage.ts";

const now = Date.now();
const day = (offset) => new Date(now - offset * 86_400_000).getTime();

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

    // Daily buckets: local calendar days, oldest first, out-of-range records excluded.
    const costs = dailyCosts(records, 3, now);
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

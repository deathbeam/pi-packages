import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, it } from "vitest";
import { registerGain } from "../src/gain.ts";
import { placeholder } from "../src/prune.ts";
import { agentDir, cleanup, dir, fire, host, loadExtension, result, rtkExec, toolResult, turn } from "./helpers.ts";

afterAll(cleanup);

const gainFile = join(agentDir, "pi-context-gain.jsonl");
const fileA = join(dir, "a.ts");
const gainText = "z".repeat(4000);

// Pruning replaces the result with the placeholder and counts 4 chars per token.
const prunedTokens = Math.round((gainText.length - placeholder(fileA).length) / 4);
// A short cache lifetime makes a fresh extension prune on its very first request.
const cacheModel = { provider: "p", id: "m", promptCache: { short: 300 } };

/** A read result of `gainText` chars that a later edit makes stale. */
const prunableTranscript = [
    turn([["p1", "read", { path: fileA }]]),
    { ...toolResult("p1"), content: [{ type: "text", text: gainText }] },
    turn([["p2", "edit", { path: fileA, edits: [] }]]),
    toolResult("p2"),
    turn([]),
];

const writeFlushed = (entries: object[]) =>
    writeFileSync(gainFile, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
const flushed = () =>
    readFileSync(gainFile, "utf8")
        .split("\n")
        .filter((line) => line.endsWith("}"))
        .map((line) => JSON.parse(line));

/** Runs /gain and returns the notification it showed. */
async function gainReport(commands: Map<string, any>) {
    const notices: Array<{ message: string; level: string }> = [];
    await commands.get("gain").handler("", {
        cwd: dir,
        ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
    });
    return notices.at(-1);
}

beforeEach(() => {
    rmSync(gainFile, { force: true });
});

describe("/gain", () => {
    it("estimates a pruned result at 4 chars per token when the session ends", async () => {
        const { handlers } = await loadExtension();
        fire(handlers, "context", { type: "context", messages: prunableTranscript }, { cwd: dir, model: cacheModel });
        fire(handlers, "session_shutdown", {});
        assert.deepEqual(
            flushed().map(({ time, ...entry }) => entry),
            [{ source: "prune", tokens: prunedTokens }],
        );
    });

    it("adds every flushed line to the live count", async () => {
        const { commands, pi } = host(rtkExec(result(127)));
        const gain = registerGain(pi);
        gain.record("prune", 100);
        gain.report("rtk", async () => 2000);
        // The cwd of older lines is ignored, and a line cut short by a crash is skipped.
        writeFlushed([
            { time: 1, cwd: dir, source: "prune", tokens: 4000 },
            { time: 2, cwd: "/elsewhere", source: "prune", tokens: 8000 },
            { time: 3, cwd: dir, source: "prune", tokens: 1000 },
        ]);
        writeFileSync(gainFile, '{"time":4,"cwd\n', { flag: "a" });
        assert.deepEqual(await gainReport(commands), {
            message: "Tokens saved\n  prune  13.1K\n  rtk    2.0K\n  total  15.1K",
            level: "info",
        });
    });

    it("reports rtk's own total", async () => {
        const installed = await loadExtension(async (_command, args) =>
            args[1] === "--help"
                ? result(0, "rtk 0.40.0")
                : result(0, JSON.stringify({ summary: { total_saved: 2000 } })),
        );
        assert.deepEqual(await gainReport(installed.commands), {
            message: "Tokens saved\n  rtk    2.0K\n  total  2.0K",
            level: "info",
        });
    });

    it("flushes one line per source, skips zero totals and clears the counters", async () => {
        const { handlers, pi } = host(rtkExec(result(127)));
        const gain = registerGain(pi);
        gain.record("prune", 100);
        gain.record("other", 40);
        gain.record("zero", 0);
        fire(handlers, "session_shutdown", {});
        fire(handlers, "session_shutdown", {});
        assert.deepEqual(
            flushed().map(({ source, tokens }) => [source, tokens]),
            [
                ["prune", 100],
                ["other", 40],
            ],
        );
    });

    it("shows n/a for a failing report and leaves it out of the total", async () => {
        const { commands, pi } = host(rtkExec(result(127)));
        const gain = registerGain(pi);
        gain.record("prune", 100);
        gain.report("rtk", async () => {
            throw new Error("boom");
        });
        writeFlushed([{ time: 1, source: "prune", tokens: 1000 }]);
        assert.deepEqual(await gainReport(commands), {
            message: "Tokens saved\n  prune  1.1K\n  rtk    n/a\n  total  1.1K",
            level: "info",
        });
    });
});

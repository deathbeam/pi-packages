import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, afterEach, describe, it, vi } from "vitest";
import { placeholder, superseded } from "../src/prune.ts";
import { cleanup, dir, fire, loadExtension, toolResult, turn, type Call } from "./helpers.ts";

afterAll(cleanup);

const fileA = join(dir, "a.ts");
const readA = { path: fileA };
const editA = { path: fileA, edits: [] };

const staleIds = (messages: any[]) => superseded(messages, dir).map((item) => item.toolCallId);

/** A read of `path` followed by an edit of it, so the read result is stale. */
const readThenEdit = (id: string, path: string) => [
    turn([[id, "read", { path }]]),
    toolResult(id),
    turn([[`${id}e`, "edit", { path, edits: [] }]]),
    toolResult(`${id}e`),
];

// [label, calls in the earlier turn, later call, result overrides, expected stale ids]
const cases: Array<[string, any[], any, any, string[]]> = [
    ["edit supersedes read", [["r", "read", readA]], ["e", "edit", editA], {}, ["r"]],
    ["write supersedes read", [["r", "read", readA]], ["w", "write", { path: fileA }], {}, ["r"]],
    ["write result kept", [["w", "write", { path: fileA }]], ["e", "edit", editA], {}, []],
    ["edit supersedes edit", [["e1", "edit", editA]], ["e2", "edit", editA], {}, ["e1"]],
    [
        "identical re-read supersedes",
        [["r1", "read", { path: fileA, offset: 2, limit: 3 }]],
        ["r2", "read", { path: fileA, offset: 2, limit: 3 }],
        {},
        ["r1"],
    ],
    [
        "different-range read keeps",
        [["r1", "read", { path: fileA, offset: 2, limit: 3 }]],
        ["r2", "read", { path: fileA, offset: 3, limit: 2 }],
        {},
        [],
    ],
    ["raw read keeps anchored", [["r1", "read", readA]], ["r2", "read", { path: fileA, raw: true }], {}, []],
    [
        "noop edit supersedes nothing",
        [["r1", "read", readA]],
        ["e1", "edit", editA],
        { e1: { details: { diff: "" } } },
        [],
    ],
    [
        "errored read superseded, grep skipped",
        [
            ["r1", "read", readA],
            ["g1", "grep", { pattern: "x", path: fileA }],
            ["x1", "read", readA],
        ],
        ["e1", "edit", editA],
        { x1: { isError: true } },
        ["r1", "x1"],
    ],
    [
        "errored edit kept after failed retry",
        [["x1", "edit", editA]],
        ["x2", "edit", editA],
        { x1: { isError: true }, x2: { isError: true } },
        [],
    ],
    [
        "failed edit superseded by read",
        [["x1", "edit", editA]],
        ["r1", "read", readA],
        { x1: { isError: true } },
        ["x1"],
    ],
    ["failed edit leaves earlier read", [["r1", "read", readA]], ["x1", "edit", editA], { x1: { isError: true } }, []],
    [
        "same bash command supersedes",
        [["b1", "bash", { command: "npm test" }]],
        ["b2", "bash", { command: "npm test" }],
        { b1: { isError: true }, b2: { isError: true } },
        ["b1"],
    ],
    [
        "different bash command keeps",
        [["b1", "bash", { command: "npm test" }]],
        ["b2", "bash", { command: "npm run check" }],
        {},
        [],
    ],
    // An invalid file:// URL falls back to a plain path instead of throwing.
    ["invalid file url", [["r1", "read", { path: "file:///%" }]], ["e1", "edit", { path: "file:///%" }], {}, ["r1"]],
    // No trailing turn: these results belong to the latest turn and stay.
    [
        "latest turn skipped",
        [
            ["r1", "read", readA],
            ["e1", "edit", editA],
        ],
        null,
        {},
        [],
    ],
];

// The later call and its result, or nothing when the case has no later turn.
const laterTurn = (later: Call | null, overrides: any) =>
    later ? [turn([later]), toolResult(later[0], overrides[later[0]]?.isError, overrides[later[0]]?.details)] : [];

describe("superseded tool results", () => {
    for (const [label, calls, later, overrides, expected] of cases) {
        it(label, () => {
            const results = calls.map(([id]) => toolResult(id, overrides[id]?.isError, overrides[id]?.details));
            assert.deepEqual(staleIds([turn(calls), ...results, ...laterTurn(later, overrides)]), expected);
        });
    }

    it("names the file in the placeholder that replaces a stale result", () => {
        assert.match(placeholder("a.ts"), /^\[superseded: a\.ts /);
    });
});

describe("cache-aware pruning gate", () => {
    const model = { provider: "p", id: "m", promptCache: { short: 300 } };

    const prunedIds = (outcome: any) =>
        (outcome?.messages ?? [])
            .filter((m: any) => m.role === "toolResult" && m.content[0].text.startsWith("[superseded"))
            .map((m: any) => m.toolCallId);

    // Registration is in-memory, so every test gets its own instance instead of sharing gate state.
    const setup = async () => {
        const { handlers } = await loadExtension();
        const context = (messages: any[], forModel: any = model) =>
            fire(handlers, "context", { type: "context", messages }, { cwd: dir, model: forModel });
        const event = (name: string, payload: any = {}, forModel: any = model) =>
            fire(handlers, name, payload, { cwd: dir, model: forModel });
        return { context, event };
    };

    const later = (ms: number) => {
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + ms);
    };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("prunes a stale result while the cache is cold", async () => {
        const { context } = await setup();
        assert.deepEqual(prunedIds(context([...readThenEdit("g1", fileA), turn([])])), ["g1"]);
    });

    it("leaves a stale result alone while the cache is warm", async () => {
        const { context, event } = await setup();
        event("before_provider_request");
        assert.deepEqual(prunedIds(context([...readThenEdit("g3", fileA), turn([])])), []);
    });

    it("keeps the gate closed after an extension warm decision", async () => {
        const { context, event } = await setup();
        event("before_provider_request");
        later(2 * 60 * 60 * 1000);
        event("cache_warming_decision", { action: "warm" });
        assert.deepEqual(prunedIds(context([...readThenEdit("g3", fileA), turn([])])), []);
    });

    it("keeps an id pruned after its superseding call is gone", async () => {
        const { context } = await setup();
        assert.deepEqual(prunedIds(context([...readThenEdit("g1", fileA), turn([])])), ["g1"]);
        const withoutEdit = [turn([["g1", "read", readA]]), toolResult("g1"), turn([])];
        assert.deepEqual(staleIds(withoutEdit), [], "the transcript no longer marks g1 stale");
        assert.deepEqual(prunedIds(context(withoutEdit)), ["g1"]);
    });

    it("opens the gate on a model switch", async () => {
        const { context } = await setup();
        assert.deepEqual(prunedIds(context([...readThenEdit("g1", fileA), turn([])])), ["g1"]);
        assert.deepEqual(
            prunedIds(
                context([turn([["g1", "read", readA]]), toolResult("g1"), ...readThenEdit("g3", fileA), turn([])], {
                    ...model,
                    id: "m2",
                }),
            ),
            ["g1", "g3"],
        );
    });

    it("opens the gate after a compaction", async () => {
        const { context, event } = await setup();
        event("before_provider_request");
        event("session_compact");
        assert.deepEqual(prunedIds(context([...readThenEdit("g3", fileA), turn([])])), ["g3"]);
    });

    it("forgets pruned ids on a new session", async () => {
        const { context, event } = await setup();
        assert.deepEqual(prunedIds(context([...readThenEdit("g1", fileA), turn([])])), ["g1"]);
        event("session_start", { reason: "reload" });
        assert.deepEqual(prunedIds(context([turn([["g1", "read", readA]]), toolResult("g1"), turn([])])), []);
    });

    it("opens the gate when the declared cache lifetime has expired", async () => {
        const { context, event } = await setup();
        event("before_provider_request");
        later(301_000);
        assert.deepEqual(prunedIds(context([...readThenEdit("g3", fileA), turn([])])), ["g3"]);
    });

    it("never expires a cache lifetime the model does not declare", async () => {
        const noCache = { provider: "p", id: "nocache" };
        const { context, event } = await setup();
        event("before_provider_request", {}, noCache);
        later(2 * 60 * 60 * 1000);
        assert.deepEqual(prunedIds(context([...readThenEdit("g3", fileA), turn([])], noCache)), []);
    });
});

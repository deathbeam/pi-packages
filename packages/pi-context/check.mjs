// Run: node check.mjs (Node >=22.19 supports TypeScript type stripping).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An isolated agent dir keeps the global-settings half of the compaction lookup deterministic.
const agentDir = mkdtempSync(join(tmpdir(), "pi-context-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const extension = (await import("./index.ts")).default;
const { placeholder, superseded } = await import("./src/prune.ts");
const { readCompactionModel } = await import("./src/compaction.ts");

const result = (code, stdout = "") => ({ code, stdout, stderr: "", killed: false });
const replies = { ls: result(0, "rtk ls\n"), grep: result(3, "rtk grep\n"), cat: result(1), rm: result(2, "deny") };

const host = (exec) => {
    const handlers = new Map();
    return {
        handlers,
        pi: {
            exec,
            on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
            registerCommand: () => {},
            registerEntryRenderer: () => {},
        },
    };
};
const rtkExec = (version) => async (_command, args) => {
    if (args[0] === "gain") return version;
    if (args[1] === "boom") throw new Error("spawn failed");
    return replies[args[1]];
};
const fire = (handlers, event, payload, ctx) => {
    let outcome;
    for (const handler of handlers.get(event) ?? []) outcome = handler(payload, ctx) ?? outcome;
    return outcome;
};

// Missing rtk still loads pruning and compaction, but registers no RTK hooks.
const missing = host(rtkExec(result(127)));
await extension(missing.pi);
assert.deepEqual(
    [...missing.handlers.keys()].sort(),
    [
        "before_provider_request",
        "cache_warming_decision",
        "context",
        "session_before_compact",
        "session_compact",
        "session_start",
        "session_tree",
    ],
    "a missing rtk must skip only the RTK hooks",
);

const { handlers, pi } = host(rtkExec(result(0, "rtk 0.40.0")));
await extension(pi);

// Exit 0/3 rewrite; 1, 2 and a throwing rtk pass the command through.
for (const [command, expected] of [
    ["ls", "rtk ls"],
    ["grep", "rtk grep"],
    ["cat", "cat"],
    ["rm", "rm"],
    ["boom", "boom"],
]) {
    const event = { toolName: "bash", input: { command } };
    await handlers.get("tool_call")[0](event, {});
    assert.equal(event.input.command, expected);
}

// RTK usage instructions go into their own system prompt section.
const prompt = { systemPromptOptions: { sections: {} } };
fire(handlers, "before_agent_start", prompt);
assert.match(prompt.systemPromptOptions.sections.command_output, /rtk bypass/);
console.log("--- rtk: rewrite, passthrough, prompt, missing binary OK ---");

const dir = mkdtempSync(join(tmpdir(), "pi-context-check-"));

// Superseded read/edit pruning replaces only results a later call made stale.
const turn = (calls) => ({
    role: "assistant",
    content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
});
const toolResult = (id, isError = false, details) => ({
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text: "x" }],
    isError,
    details,
});
const stale = (messages) => superseded(messages, dir).map((item) => item.toolCallId);
const same = (actual, expected, label) => {
    if (actual.join() !== expected.join()) throw new Error(`${label}: ${JSON.stringify(actual)}`);
};
const fileA = join(dir, "prune-a.ts");
const fileB = join(dir, "prune-b.ts");
const readA = { path: fileA };
const editA = { path: fileA, edits: [] };
const cases = [
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
const results = (ids, overrides) =>
    ids.map((id) => toolResult(id, overrides[id]?.isError ?? false, overrides[id]?.details));
for (const [label, calls, later, overrides, expected] of cases) {
    same(
        stale([
            turn(calls),
            ...results(
                calls.map(([id]) => id),
                overrides,
            ),
            ...(later ? [turn([later]), ...results([later[0]], overrides)] : []),
        ]),
        expected,
        label,
    );
}
if (!placeholder("a.ts").startsWith("[superseded: a.ts ")) throw new Error("placeholder text changed");
console.log("--- superseded read/edit pruning OK ---");

// Pruning only adds new ids while the cache is cold, and stays sticky.
const model = { provider: "p", id: "m", promptCache: { short: 300 } };
const ctx = { cwd: dir, model };
const pair = (id, path = fileB) => [
    turn([[id, "read", { path }]]),
    toolResult(id),
    turn([[`${id}e`, "edit", { path, edits: [] }]]),
    toolResult(`${id}e`),
];
const transcript = (...extra) => [
    turn([["g1", "read", readA]]),
    toolResult("g1"),
    turn([["g2", "edit", editA]]),
    toolResult("g2"),
    ...extra,
    turn([]),
];
const prunedIds = (outcome) =>
    (outcome?.messages ?? [])
        .filter((m) => m.role === "toolResult" && m.content[0].text.startsWith("[superseded"))
        .map((m) => m.toolCallId);
const context = (messages, modelOverride = model) =>
    fire(handlers, "context", { type: "context", messages }, { ...ctx, model: modelOverride });

// No request yet in this process, so the cache counts as cold.
same(prunedIds(context(transcript())), ["g1"], "cold prune");
fire(handlers, "before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
// Warm: a new stale pair is left alone, g1 stays pruned.
same(prunedIds(context(transcript(...pair("g3")))), ["g1"], "warm cache");
// Sticky: g1 stays pruned even though its superseding edit is no longer listed.
const sticky = [turn([["g1", "read", readA]]), toolResult("g1"), turn([])];
same(stale(sticky), [], "sticky precondition");
same(prunedIds(context(sticky)), ["g1"], "sticky");
// A model change or a compaction opens the gate.
same(prunedIds(context(transcript(...pair("g3")), { ...model, id: "m2" })), ["g1", "g3"], "model change");
fire(handlers, "before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
fire(handlers, "session_compact", { type: "session_compact" }, ctx);
same(
    prunedIds(context(transcript(...pair("g3"), ...pair("g5", join(dir, "prune-c.ts"))))),
    ["g1", "g3", "g5"],
    "after compaction",
);
// A new session starts with nothing pruned and a cold cache.
fire(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
same(prunedIds(context(transcript())), ["g1"], "after session start");
console.log("--- cache-aware pruning gate OK ---");

// context.compaction parses "provider/model-id[:thinking]"; project settings override global ones.
const settingsAt = (value, key = "context") => {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ [key]: { compaction: value } }));
    return readCompactionModel(dir);
};
assert.deepEqual(settingsAt("openrouter/google/gemini-flash:low"), {
    value: "openrouter/google/gemini-flash:low",
    provider: "openrouter",
    id: "google/gemini-flash",
    thinking: "low",
});
assert.deepEqual(settingsAt("ollama/llama3:8b"), {
    value: "ollama/llama3:8b",
    provider: "ollama",
    id: "llama3:8b",
    thinking: undefined,
});
assert.equal(settingsAt("no-provider").provider, "");
assert.equal(settingsAt("no-provider").id, "no-provider");
// The old archive.compaction key is gone, with no fallback.
assert.equal(settingsAt("openrouter/google/gemini-flash:low", "archive"), undefined);
console.log("--- context.compaction parsing OK ---");

// An unresolvable compaction model warns and leaves the session model in charge.
const notices = [];
const compactCtx = {
    cwd: dir,
    hasUI: true,
    ui: { notify: (message, level) => notices.push({ message, level }) },
    modelRegistry: { find: () => undefined },
};
settingsAt("openrouter/google/gemini-flash:low");
const outcome = await fire(
    handlers,
    "session_before_compact",
    { preparation: {}, customInstructions: undefined, signal: new AbortController().signal },
    compactCtx,
);
assert.equal(outcome, undefined);
assert.equal(notices.at(-1)?.level, "warning");
assert.match(
    notices.at(-1)?.message ?? "",
    /context\.compaction "openrouter\/google\/gemini-flash:low" does not resolve/,
);
console.log("--- compaction model fallback warning OK ---");

rmSync(dir, { recursive: true, force: true });
rmSync(agentDir, { recursive: true, force: true });

console.log("\npi-context: all checks passed");

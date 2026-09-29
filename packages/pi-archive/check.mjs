// Run: node check.mjs (Node >=22.19 supports TypeScript type stripping).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import {
    default as piArchive,
    searchSessions,
    entryText,
    matchesAll,
    excerptAround,
    projectLabel,
    firstUserTitle,
    recentSessions,
    formatResults,
} from "./index.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-check-"));
const projA = path.join(root, "--home-user-git-projA--");
const projB = path.join(root, "--home-user-git-projB--");
fs.mkdirSync(projA);
fs.mkdirSync(projB);

const line = (obj) => JSON.stringify(obj);
fs.writeFileSync(
    path.join(projA, "2026-09-01T00-00-00-000Z_aaaa.jsonl"),
    [
        line({ type: "session", version: 3, id: "aaaa" }),
        line({
            type: "message",
            id: "m1",
            parentId: null,
            message: { role: "user", content: [{ type: "text", text: "fix the jwt auth refresh bug" }] },
        }),
        line({
            type: "message",
            id: "m2",
            parentId: "m1",
            message: {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "irrelevant" },
                    { type: "text", text: "the token expiry was 5 minutes, raised to 30" },
                ],
            },
        }),
        line({ type: "compaction", id: "c1", parentId: "m2", summary: "Fixed jwt refresh; expiry 5->30 min" }),
        line({
            type: "message",
            id: "m3",
            parentId: "m2",
            message: {
                role: "toolResult",
                toolCallId: "t1",
                toolName: "bash",
                content: [{ type: "text", text: "Error EACCES: jwt key file unreadable" }],
            },
        }),
        "",
    ].join("\n"),
);
fs.writeFileSync(
    path.join(projB, "2026-09-02T00-00-00-000Z_bbbb.jsonl"),
    [
        line({ type: "session", version: 3, id: "bbbb" }),
        line({
            type: "message",
            id: "m1",
            parentId: null,
            message: { role: "user", content: [{ type: "text", text: "unrelated work on the renderer" }] },
        }),
        "",
    ].join("\n"),
);
const currentFile = path.join(projA, "2026-09-03T00-00-00-000Z_cccc.jsonl");
fs.writeFileSync(
    currentFile,
    [
        line({ type: "session", version: 3, id: "cccc" }),
        line({
            type: "message",
            id: "m1",
            parentId: null,
            message: { role: "user", content: [{ type: "text", text: "jwt again but this session is the live one" }] },
        }),
        ...Array.from({ length: 2 }, (_u, i) =>
            line({ type: "message", message: { role: "user", content: `signal intent ${i}` } }),
        ),
        ...Array.from({ length: 5 }, (_u, i) =>
            line({
                type: "message",
                message: { role: "toolResult", content: [{ type: "text", text: `signal noise ${i}` }] },
            }),
        ),
        "",
    ].join("\n"),
);
fs.writeFileSync(
    path.join(projB, "2026-09-04T00-00-00-000Z_dddd.jsonl"),
    line({ type: "message", message: { role: "user", content: "literal\u2028and\u2029separators plain string" } }) +
        "\n",
);
fs.writeFileSync(
    path.join(projB, "2026-09-06T00-00-00-000Z_ffff.jsonl"),
    [
        line({ type: "session", version: 3, id: "ffff" }),
        ...Array.from({ length: 6 }, (_u, i) =>
            line({ type: "message", message: { role: "user", content: `capmark hit number ${i}` } }),
        ),
        "",
    ].join("\n"),
);
const largeFile = path.join(projB, "2026-09-05T00-00-00-000Z_eeee.jsonl");
const largeFd = fs.openSync(largeFile, "w");
fs.writeFileSync(largeFd, Buffer.alloc(16 * 1024 * 1024 + 128 * 1024, 120)); // oversized record spans chunks
fs.writeFileSync(
    largeFd,
    `\n${line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "largeentry survives" }] } })}\n${line({ type: "message", message: { role: "user", content: "late title" } })}\n`,
);
fs.closeSync(largeFd);

// entryText: skips thinking, reads compaction summaries
const et = entryText({
    type: "message",
    message: {
        role: "assistant",
        content: [
            { type: "thinking", thinking: "x" },
            { type: "text", text: "hello" },
        ],
    },
});
assert.equal(et?.text, "hello");
assert.equal(entryText({ type: "compaction", summary: "sum" })?.role, "summary");
assert.equal(entryText({ type: "model_change" }), null);
assert.equal(entryText({ type: "message", message: { role: "user", content: "plain string" } })?.text, "plain string");
assert.equal(entryText({ type: "message", message: { role: "system", content: "not searchable" } }), null);
assert.equal(
    entryText({
        type: "message",
        message: { role: "toolResult", toolName: "search_archive", content: [{ type: "text", text: "derived hit" }] },
    }),
    null,
    "archive search results should not match themselves",
);

assert.ok(matchesAll("Fix The JWT Bug", ["jwt", "bug"]));
assert.ok(!matchesAll("Fix The JWT Bug", ["jwt", "renderer"]));

assert.ok(excerptAround("x".repeat(400) + "needle" + "y".repeat(400), ["needle"]).includes("needle"));
assert.ok(excerptAround("a".repeat(400), ["needle"]).startsWith("a".repeat(300) + "…")); // no match: truncated prefix + ellipsis

assert.equal(projectLabel("--home-deathbeam-git-dotfiles--"), "git/dotfiles");
assert.equal(projectLabel("--home-user--"), "home/user");

// search: ranking (current session first, then same project), AND terms, compaction hit
const res = await searchSessions(root, "jwt", { currentFile, currentDir: projA });
assert.equal(res.matches.length, 4);
assert.equal(res.matches[0].currentSession, true);
assert.equal(res.matches[0].role, "user");
assert.equal(res.matches[1].sameProject, true);
assert.equal(res.matches[1].date, "2026-09-01");
assert.ok(res.matches.some((m) => m.role === "summary"));
assert.ok(res.matches.some((m) => m.role === "toolResult" && m.excerpt.includes("EACCES")));
assert.ok(res.matches.some((m) => m.excerpt.includes("30")));
assert.match(formatResults("jwt", res), /\[this session \|/);
assert.match(formatResults("jwt", res), /\[other session in this project \|/);
assert.equal(formatResults("jwt", res).split(res.matches[1].file).length - 1, 1);
const favored = await searchSessions(root, "signal", { currentFile, currentDir: projA });
assert.deepEqual(
    favored.matches.map((m) => m.role),
    ["user", "user", "toolResult"],
);
assert.deepEqual(
    favored.matches.map((m) => m.excerpt),
    ["signal intent 1", "signal intent 0", "signal noise 4"],
);

// AND across terms finds nothing in projB
const none = await searchSessions(root, "jwt renderer", {});
assert.equal(none.matches.length, 0);

// session filter
const filtered = await searchSessions(root, "renderer", { sessionFilter: "projB" });
assert.equal(filtered.matches[0].project, "git/projB");

// LF streaming must not split literal U+2028/U+2029, and oversized records must not be silently omitted.
assert.equal((await searchSessions(root, "literal", {})).matches.length, 1);
const large = await searchSessions(root, "largeentry", {});
assert.equal(large.matches.length, 1);
assert.equal(large.truncated, true);
assert.equal(await firstUserTitle(largeFile), "late title");

// limit
const limited = await searchSessions(root, "jwt", { currentFile, currentDir: projA, limit: 1 });
assert.equal(limited.matches.length, 1);
assert.equal(limited.limitReached, true);
assert.equal(limited.scanIncomplete, false);
assert.match(formatResults("jwt", limited), /Result limit reached/);
assert.doesNotMatch(formatResults("jwt", limited), /Search incomplete/);
for (const limit of [0, -1, 1.5, Infinity, 101]) {
    await assert.rejects(searchSessions(root, "jwt", { limit }), /limit must be an integer/);
}
await assert.rejects(searchSessions(root, "", { limit: 0 }), /limit must be an integer/);

const capped = await searchSessions(root, "capmark", {});
assert.equal(capped.matches.length, 3);
assert.deepEqual(
    capped.matches.map((m) => m.excerpt),
    [5, 4, 3].map((i) => `capmark hit number ${i}`),
);
assert.match(formatResults("capmark", capped), /at most 3 per session file/);
assert.equal(formatResults("capmark", capped).split(capped.matches[0].file).length - 1, 1);
const page1 = await searchSessions(root, "capmark", { perSession: 6, limit: 2 });
const page2 = await searchSessions(root, "capmark", { perSession: 6, limit: 2, offset: 2 });
assert.deepEqual(
    page1.matches.map((m) => m.excerpt),
    ["capmark hit number 5", "capmark hit number 4"],
);
assert.deepEqual(
    page2.matches.map((m) => m.excerpt),
    ["capmark hit number 3", "capmark hit number 2"],
);
assert.match(formatResults("capmark", page2), /at offset 2 — at most 6 per session file/);
assert.match(
    formatResults("capmark", await searchSessions(root, "capmark", { perSession: 6, offset: 6 })),
    /No matches.*after offset 6/,
);
assert.equal(
    (await searchSessions(root, "signal", { currentFile, currentDir: projA, perSession: 1 })).matches[0].role,
    "user",
);
assert.equal(
    (await searchSessions(root, "jwt", { currentFile, currentDir: projA, offset: 1, limit: 1 })).matches[0].sameProject,
    true,
);
for (const perSession of [0, -1, 1.5, Infinity, 1001]) {
    await assert.rejects(searchSessions(root, "", { perSession }), /perSession must be an integer/);
}
for (const offset of [-1, 1.5, Infinity, 10001]) {
    await assert.rejects(searchSessions(root, "", { offset }), /offset must be an integer/);
}

// Missing archives are normal; permission errors are not clean misses.
assert.deepEqual(await searchSessions(path.join(root, "no-such-root"), "jwt", {}), {
    matches: [],
    bytesScanned: 0,
    filesScanned: 0,
    truncated: false,
});
const deny = (code) => Object.assign(new Error(`${code}: denied`), { code });
const realReaddir = fs.promises.readdir;
fs.promises.readdir = async (dir, opts) => {
    if (dir === root) throw deny("EACCES");
    return realReaddir(dir, opts);
};
try {
    await assert.rejects(searchSessions(root, "jwt", {}), { code: "EACCES" });
} finally {
    fs.promises.readdir = realReaddir;
}

fs.promises.readdir = async (dir, opts) => {
    if (dir === projB) throw deny("EACCES");
    return realReaddir(dir, opts);
};
try {
    const partial = await searchSessions(root, "jwt", {});
    assert.ok(partial.matches.length > 0);
    assert.equal(partial.truncated, true);
} finally {
    fs.promises.readdir = realReaddir;
}

// abort: signal already aborted yields zero matches, truncated flag set
const ac = new AbortController();
ac.abort();
const aborted = await searchSessions(root, "jwt", {}, ac.signal);
assert.equal(aborted.matches.length, 0);
assert.equal(aborted.truncated, true);

// Vanished files are skipped; unreadable files make the search incomplete.
const realStat = fs.promises.stat;
for (const code of ["ENOENT", "EACCES"]) {
    const truncated = code === "EACCES";
    fs.promises.stat = async () => {
        throw deny(code);
    };
    try {
        const result = await searchSessions(root, "jwt", {});
        assert.equal(result.matches.length, 0);
        assert.equal(result.truncated, truncated);
    } finally {
        fs.promises.stat = realStat;
    }
}

// A read error is incomplete, not a definitive archive miss.
const realStream = fs.createReadStream;
fs.createReadStream = () =>
    Readable.from(
        (async function* () {
            throw new Error("read failed");
        })(),
    );
try {
    assert.equal((await searchSessions(root, "missing", { sessionFilter: "projA" })).truncated, true);
} finally {
    fs.createReadStream = realStream;
}

// Zero hits from an incomplete search must not claim a complete no-match result.
const empty = { matches: [], bytesScanned: 1, filesScanned: 1, truncated: true };
assert.match(formatResults("nothing", empty), /Search incomplete/);
assert.doesNotMatch(formatResults("nothing", { ...empty, truncated: false }), /Search incomplete/);

// titles + recent sessions
assert.equal(
    await firstUserTitle(path.join(projA, "2026-09-01T00-00-00-000Z_aaaa.jsonl")),
    "fix the jwt auth refresh bug",
);
assert.equal(await firstUserTitle(path.join(projB, "does-not-exist.jsonl")), null);
assert.equal(
    await firstUserTitle(path.join(projB, "2026-09-04T00-00-00-000Z_dddd.jsonl")),
    "literal\u2028and\u2029separators plain string",
);
const recent = recentSessions(projA, currentFile, 5);
assert.equal(recent.length, 1);
assert.equal(recent[0].name, "2026-09-01T00-00-00-000Z_aaaa.jsonl");

// Keep the retrieval rule in both the system guidelines and the tool schema (used with custom SYSTEM.md).
let registeredTool;
let beforeAgentStart;
await piArchive({
    registerTool: (tool) => (registeredTool = tool),
    on: (event, handler) => {
        if (event === "before_agent_start") beforeAgentStart = handler;
    },
});
assert.match(registeredTool.promptGuidelines?.join("\n") ?? "", /compaction.*search_archive/is);
assert.match(registeredTool.description, /compaction.*search_archive/is);
const archiveCtx = (entries, file = currentFile) => ({
    sessionManager: {
        getEntries: () => entries,
        getSessionDir: () => projA,
        getSessionFile: () => file,
    },
});
assert.equal(await beforeAgentStart({}, archiveCtx([{ type: "message" }])), undefined);
assert.equal(
    await beforeAgentStart({}, archiveCtx([{ type: "custom_message", customType: "archive-memory" }])),
    undefined,
);
const hint = (await beforeAgentStart({}, archiveCtx([])))?.message?.content;
assert.match(hint ?? "", /^Recent sessions in this project/);
assert.doesNotMatch(hint, /\[pi-archive\]/);
assert.match(hint, /fix the jwt auth refresh bug/);
assert.ok(
    (await beforeAgentStart({}, archiveCtx([], path.join(projA, "new-session.jsonl"))))?.message,
    "new sessions receive their own titles",
);

fs.rmSync(root, { recursive: true, force: true });
console.log("pi-archive: all checks passed");

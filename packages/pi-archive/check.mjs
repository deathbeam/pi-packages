// Run: node check.mjs (Node >=22.19 supports TypeScript type stripping).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import piArchive from "./index.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-check-"));
const projA = path.join(root, "--home-user-git-projA--");
const projB = path.join(root, "--home-user-git-projB--");
const projShort = path.join(root, "--home-user--");
fs.mkdirSync(projA);
fs.mkdirSync(projB);
fs.mkdirSync(projShort);

const line = (obj) => JSON.stringify(obj);
const aaaa = path.join(projA, "2026-09-01T00-00-00-000Z_aaaa.jsonl");
fs.writeFileSync(
    aaaa,
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
        // Entries that must never match: search_archive's own results, system messages, non-message entries.
        line({
            type: "message",
            message: {
                role: "toolResult",
                toolName: "search_archive",
                content: [{ type: "text", text: "derived selfskip hit" }],
            },
        }),
        line({ type: "model_change", model: "modelskip" }),
        line({ type: "message", message: { role: "system", content: "confidential systemskip memo" } }),
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
            message: { role: "user", content: "jwt again but this session is the live one" },
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
// The oversized first record spans read chunks and must be skipped, not dropped.
const largeFile = path.join(projA, "2026-09-05T00-00-00-000Z_eeee.jsonl");
const largeFd = fs.openSync(largeFile, "w");
fs.writeFileSync(largeFd, Buffer.alloc(16 * 1024 * 1024 + 128 * 1024, 120));
fs.writeFileSync(
    largeFd,
    `\n${line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "largeentry survives" }] } })}\n${line({ type: "message", message: { role: "user", content: "late title" } })}\n`,
);
fs.closeSync(largeFd);
const ffff = path.join(projB, "2026-09-06T00-00-00-000Z_ffff.jsonl");
fs.writeFileSync(
    ffff,
    [
        line({ type: "session", version: 3, id: "ffff" }),
        ...Array.from({ length: 6 }, (_u, i) =>
            line({ type: "message", message: { role: "user", content: `capmark hit number ${i}` } }),
        ),
        "",
    ].join("\n"),
);
fs.writeFileSync(
    path.join(projShort, "2026-09-07T00-00-00-000Z_gggg.jsonl"),
    [
        line({ type: "session", version: 3, id: "gggg" }),
        line({ type: "message", message: { role: "user", content: "zephyr works in short projects" } }),
        line({ type: "message", message: { role: "user", content: "x".repeat(400) + "needle" + "y".repeat(400) } }),
        "",
    ].join("\n"),
);
// No user message: the recent-sessions hint falls back to "(no user message)".
fs.writeFileSync(
    path.join(projA, "2026-09-08T00-00-00-000Z_hhhh.jsonl"),
    [
        line({ type: "session", version: 3, id: "hhhh" }),
        line({
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "assistant only entry" }] },
        }),
        "",
    ].join("\n"),
);
// mtimes drive newest-first ranking; make them match the dates in the file names.
for (const dir of [projA, projB, projShort]) {
    for (const name of fs.readdirSync(dir)) {
        const at = new Date(name.slice(0, 10));
        fs.utimesSync(path.join(dir, name), at, at);
    }
}

// Everything below goes through the only public seams: the registered tool and the before_agent_start hook.
let tool;
let beforeAgentStart;
await piArchive({
    registerTool: (t) => (tool = t),
    on: (event, handler) => {
        if (event === "before_agent_start") beforeAgentStart = handler;
    },
});
const archiveCtx = (entries = [], { dir = projA, file = currentFile } = {}) => ({
    sessionManager: {
        getEntries: () => entries,
        getSessionDir: () => dir,
        getSessionFile: () => file,
    },
});
const search = async (params, ctx = archiveCtx(), signal) => {
    const r = await tool.execute("id", params, signal, undefined, ctx);
    return { text: r.content[0].text, details: r.details };
};
const hitLines = (text) => text.split("\n").filter((l) => l.startsWith("- "));
const hits = async (params) => hitLines((await search(params)).text);

// Ranking: current session first, then this project; compaction summaries and tool results are searchable.
const jwt = await search({ query: "jwt" });
assert.equal(jwt.details.matchCount, 4);
assert.match(jwt.text, /\[this session \| 2026-09-03\]/);
assert.match(jwt.text, /\[other session in this project \| 2026-09-01\]/);
assert.deepEqual(hitLines(jwt.text), [
    "- user: jwt again but this session is the live one",
    "- summary: Fixed jwt refresh; expiry 5->30 min",
    "- user: fix the jwt auth refresh bug",
    "- toolResult: Error EACCES: jwt key file unreadable",
]);
assert.equal(jwt.text.split(currentFile).length - 1, 1);
assert.equal(jwt.text.split(aaaa).length - 1, 1);

// Thinking blocks are excluded from message text.
assert.deepEqual(await hits({ query: "token" }), ["- assistant: the token expiry was 5 minutes, raised to 30"]);

// All terms must appear in one entry.
assert.match((await search({ query: "jwt renderer" })).text, /No matches for "jwt renderer"/);

// Dialogue is preferred over tool hits: two user messages plus one tool result.
assert.deepEqual(await hits({ query: "signal" }), [
    "- user: signal intent 1",
    "- user: signal intent 0",
    "- toolResult: signal noise 4",
]);
assert.deepEqual(await hits({ query: "signal", perSession: 1 }), ["- user: signal intent 1"]);

// Project labels come from encoded dir names: the last two segments, or all of them when short.
const renderer = await search({ query: "renderer", session: "projB" });
assert.match(renderer.text, /\[git\/projB \| 2026-09-02\]/);
assert.deepEqual(hitLines(renderer.text), ["- user: unrelated work on the renderer"]);
assert.equal(renderer.details.truncated, false);
const zephyr = await search({ query: "zephyr" });
assert.match(zephyr.text, /\[home\/user \| 2026-09-07\]/);
assert.deepEqual(hitLines(zephyr.text), ["- user: zephyr works in short projects"]);

// Excerpts keep 150 chars either side of the first hit, with ellipses when trimmed.
const [needle] = await hits({ query: "needle" });
assert.ok(needle.startsWith("- user: …" + "x".repeat(150) + "needle"), "150 chars before the hit");
assert.ok(needle.endsWith("needle" + "y".repeat(144) + "…"), "150 chars after the hit start");

// search_archive results, system messages, and non-message entries never match.
for (const term of ["selfskip", "systemskip", "modelskip"]) {
    assert.match((await search({ query: term })).text, /No matches/, `${term} entries must not match`);
}

// LF-only scanning: literal U+2028/U+2029 inside a JSON string do not split the line.
assert.deepEqual(await hits({ query: "literal" }), ["- user: literal and separators plain string"]);

// Oversized records are skipped, not dropped, and mark the scan incomplete.
const large = await search({ query: "largeentry" });
assert.deepEqual(hitLines(large.text), ["- assistant: largeentry survives"]);
assert.match(large.text, /\[other session in this project \| 2026-09-05\]/);
assert.equal(large.details.truncated, true);
assert.match(large.text, /Search incomplete/);

// The limit stops the scan before the oversized file, so only the limit note appears.
const limited = await search({ query: "jwt", limit: 1 });
assert.deepEqual(hitLines(limited.text), ["- user: jwt again but this session is the live one"]);
assert.equal(limited.details.truncated, true);
assert.match(limited.text, /Result limit reached/);
assert.doesNotMatch(limited.text, /Search incomplete/);

// Options are validated before anything is scanned.
for (const limit of [0, -1, 1.5, Infinity, 101]) {
    await assert.rejects(search({ query: "jwt", limit }), /limit must be an integer/);
}
await assert.rejects(search({ query: "", limit: 0 }), /limit must be an integer/);
for (const perSession of [0, -1, 1.5, Infinity, 1001]) {
    await assert.rejects(search({ query: "", perSession }), /perSession must be an integer/);
}
for (const offset of [-1, 1.5, Infinity, 10001]) {
    await assert.rejects(search({ query: "", offset }), /offset must be an integer/);
}

// perSession keeps the newest hits per file; offset pages across ranked hits.
const capped = await search({ query: "capmark" });
assert.deepEqual(
    hitLines(capped.text),
    [5, 4, 3].map((i) => `- user: capmark hit number ${i}`),
);
assert.match(capped.text, /at most 3 per session file/);
assert.equal(capped.text.split(ffff).length - 1, 1);
assert.deepEqual(await hits({ query: "capmark", perSession: 6, limit: 2 }), [
    "- user: capmark hit number 5",
    "- user: capmark hit number 4",
]);
const page2 = await search({ query: "capmark", perSession: 6, limit: 2, offset: 2 });
assert.deepEqual(hitLines(page2.text), ["- user: capmark hit number 3", "- user: capmark hit number 2"]);
assert.match(page2.text, /at offset 2 — at most 6 per session file/);
assert.match((await search({ query: "capmark", perSession: 6, offset: 6 })).text, /No matches.*after offset 6/);
assert.match(
    (await search({ query: "jwt", offset: 1, limit: 1 })).text,
    /\[other session in this project \| 2026-09-01\]/,
);

// A missing archive is a clean miss.
const missing = await search({ query: "jwt" }, archiveCtx([], { dir: path.join(root, "no-such-root", "sess") }));
assert.match(missing.text, /No matches for "jwt" in 0 scanned session files\.$/);
assert.deepEqual(missing.details, { matchCount: 0, filesScanned: 0, truncated: false });

const deny = (code) => Object.assign(new Error(`${code}: denied`), { code });
const realReaddir = fs.promises.readdir;
// Permission errors on the archive root must not look like clean misses.
fs.promises.readdir = async (dir, opts) => {
    if (dir === root) throw deny("EACCES");
    return realReaddir(dir, opts);
};
try {
    await assert.rejects(search({ query: "jwt" }), { code: "EACCES" });
} finally {
    fs.promises.readdir = realReaddir;
}
// An unreadable project dir makes the search incomplete but keeps its matches.
fs.promises.readdir = async (dir, opts) => {
    if (dir === projB) throw deny("EACCES");
    return realReaddir(dir, opts);
};
try {
    const partial = await search({ query: "jwt" });
    assert.ok(partial.details.matchCount > 0);
    assert.equal(partial.details.truncated, true);
    assert.match(partial.text, /Search incomplete/);
} finally {
    fs.promises.readdir = realReaddir;
}

// An aborted signal yields zero matches and an incomplete scan.
const ac = new AbortController();
ac.abort();
const aborted = await search({ query: "jwt" }, archiveCtx(), ac.signal);
assert.equal(aborted.details.matchCount, 0);
assert.equal(aborted.details.truncated, true);
assert.match(aborted.text, /Search incomplete/);

// Vanished files are skipped; unreadable files make the search incomplete.
const realStat = fs.promises.stat;
for (const code of ["ENOENT", "EACCES"]) {
    fs.promises.stat = async () => {
        throw deny(code);
    };
    try {
        const result = await search({ query: "jwt" });
        assert.equal(result.details.matchCount, 0);
        assert.equal(result.details.truncated, code === "EACCES");
        assert.match(
            result.text,
            code === "EACCES" ? /Search incomplete/ : /No matches for "jwt" in 0 scanned session files\.$/,
        );
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
    const failed = await search({ query: "missing", session: "projA" });
    assert.match(failed.text, /No matches for "missing"/);
    assert.match(failed.text, /Search incomplete/);
} finally {
    fs.createReadStream = realStream;
}

// The hint lists recent sessions newest-first, titled with their first user message.
assert.equal(await beforeAgentStart({}, archiveCtx([{ type: "message" }])), undefined);
assert.equal(
    await beforeAgentStart({}, archiveCtx([{ type: "custom_message", customType: "archive-memory" }])),
    undefined,
);
const hint = (await beforeAgentStart({}, archiveCtx([])))?.message?.content;
assert.match(hint ?? "", /^Recent sessions in this project/);
assert.match(
    hint,
    /- 2026-09-08: \(no user message\)\n- 2026-09-05: late title\n- 2026-09-01: fix the jwt auth refresh bug/,
);
assert.ok(
    (await beforeAgentStart({}, archiveCtx([], { file: path.join(projA, "new-session.jsonl") })))?.message,
    "new sessions receive their own titles",
);

// The retrieval rule lives in both the system guidelines and the tool schema (used with custom SYSTEM.md).
assert.match(tool.promptGuidelines?.join("\n") ?? "", /compaction.*search_archive/is);
assert.match(tool.description, /compaction.*search_archive/is);

fs.rmSync(root, { recursive: true, force: true });
console.log("pi-archive: all checks passed");

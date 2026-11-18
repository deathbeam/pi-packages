import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import { aaaa, archiveCtx, currentFile, ffff, hitLines, hits, removeArchive, root, search } from "./helpers.ts";

afterAll(removeArchive);

describe("ranking", () => {
    it("puts the current session first, then this project, and searches summaries and tool results", async () => {
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
        // One header per session file.
        assert.equal(jwt.text.split(currentFile).length - 1, 1);
        assert.equal(jwt.text.split(aaaa).length - 1, 1);
    });

    it("excludes thinking blocks from message text", async () => {
        assert.deepEqual(await hits({ query: "token" }), ["- assistant: the token expiry was 5 minutes, raised to 30"]);
    });

    it("requires all terms to appear in one entry", async () => {
        assert.match((await search({ query: "jwt renderer" })).text, /No matches for "jwt renderer"/);
    });

    it("prefers dialogue over tool hits", async () => {
        assert.deepEqual(await hits({ query: "signal" }), [
            "- user: signal intent 1",
            "- user: signal intent 0",
            "- toolResult: signal noise 4",
        ]);
        // One slot is reserved for tools whatever perSession is, so the tool hit survives perSession 2.
        assert.deepEqual(await hits({ query: "signal", perSession: 2 }), [
            "- user: signal intent 1",
            "- toolResult: signal noise 4",
        ]);
        assert.deepEqual(await hits({ query: "signal", perSession: 1 }), ["- user: signal intent 1"]);
    });
});

describe("project labels", () => {
    it.each([
        {
            shape: "deep",
            query: "renderer",
            label: "[git/projB | 2026-09-02]",
            hit: "- user: unrelated work on the renderer",
        },
        {
            shape: "short",
            query: "zephyr",
            label: "[home/user | 2026-09-07]",
            hit: "- user: zephyr works in short projects",
        },
    ])("labels a $shape project dir with its last two segments", async ({ query, label, hit }) => {
        const text = (await search({ query })).text;
        assert.ok(text.includes(label), `hit header ${label}`);
        assert.deepEqual(hitLines(text), [hit]);
    });
});

describe("session filter", () => {
    it("matches the encoded project dir name", async () => {
        const renderer = await search({ query: "renderer", session: "projB" });
        assert.deepEqual(hitLines(renderer.text), ["- user: unrelated work on the renderer"]);
        assert.equal(renderer.details.truncated, false);
    });

    it('drops the literal "null" that strict models send', async () => {
        assert.equal((await search({ query: "jwt", session: "null" })).details.matchCount, 4);
    });
});

describe("excerpts", () => {
    it("keeps 150 chars either side of the first hit, with ellipses when trimmed", async () => {
        const [needle] = await hits({ query: "needle" });
        assert.ok(needle.startsWith("- user: …" + "x".repeat(150) + "needle"), "150 chars before the hit");
        assert.ok(needle.endsWith("needle" + "y".repeat(144) + "…"), "150 chars after the hit start");
    });
});

describe("excluded entries", () => {
    it.each(["selfskip", "systemskip", "modelskip"])("never matches %s", async (term) => {
        assert.match((await search({ query: term })).text, /No matches/, `${term} entries must not match`);
    });
});

describe("scanning", () => {
    it("scans LF only, so literal U+2028/U+2029 inside a JSON string do not split the line", async () => {
        assert.deepEqual(await hits({ query: "literal" }), ["- user: literal and separators plain string"]);
    });

    it("skips oversized records instead of dropping them and marks the scan incomplete", async () => {
        const large = await search({ query: "largeentry" });
        assert.deepEqual(hitLines(large.text), ["- assistant: largeentry survives"]);
        assert.match(large.text, /\[other session in this project \| 2026-09-05\]/);
        assert.equal(large.details.truncated, true);
        assert.match(large.text, /Search incomplete/);
    });

    it("stops the scan at the limit and reports only the limit note", async () => {
        const limited = await search({ query: "jwt", limit: 1 });
        assert.deepEqual(hitLines(limited.text), ["- user: jwt again but this session is the live one"]);
        assert.equal(limited.details.truncated, true);
        assert.match(limited.text, /Result limit reached/);
        assert.doesNotMatch(limited.text, /Search incomplete/);
    });
});

describe("option validation", () => {
    it.each([
        { name: "limit", values: [0, -1, 1.5, Infinity, 101] },
        { name: "perSession", values: [0, -1, 1.5, Infinity, 1001] },
        { name: "offset", values: [-1, 1.5, Infinity, 10001] },
    ])("rejects out-of-range $name before scanning", async ({ name, values }) => {
        // An empty query would otherwise return "no matches" instead of throwing.
        for (const value of values) {
            await assert.rejects(search({ query: "", [name]: value }), new RegExp(`${name} must be an integer`));
        }
    });
});

describe("paging", () => {
    it("keeps the newest hits per session file", async () => {
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
    });

    it("pages across ranked hits with offset", async () => {
        const page2 = await search({ query: "capmark", perSession: 6, limit: 2, offset: 2 });
        assert.deepEqual(hitLines(page2.text), ["- user: capmark hit number 3", "- user: capmark hit number 2"]);
        assert.match(page2.text, /at offset 2 — at most 6 per session file/);
        assert.match((await search({ query: "capmark", perSession: 6, offset: 6 })).text, /No matches.*after offset 6/);
        // Offset applies to the global ranking, not per file.
        assert.match(
            (await search({ query: "jwt", offset: 1, limit: 1 })).text,
            /\[other session in this project \| 2026-09-01\]/,
        );
    });
});

describe("missing archive", () => {
    it("is a clean miss", async () => {
        const missing = await search(
            { query: "jwt" },
            archiveCtx([], { dir: path.join(root, "no-such-root", "sess") }),
        );
        assert.deepEqual(missing.details, {
            matches: [],
            matchCount: 0,
            filesScanned: 0,
            truncated: false,
            limitReached: false,
            scanIncomplete: false,
        });
        assert.match(missing.text, /No matches for "jwt" in 0 scanned session files\.$/);
    });
});

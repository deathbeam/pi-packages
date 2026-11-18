import assert from "node:assert/strict";
import fs from "node:fs";
import { Readable } from "node:stream";
import { afterAll, afterEach, describe, it } from "vitest";
import { archiveCtx, deny, projB, removeArchive, root, search } from "./helpers.ts";

afterAll(removeArchive);

// fs stubs replace overloaded signatures, so patch through a loose alias.
const promises = fs.promises as any;
const realFs = { readdir: promises.readdir, stat: promises.stat, createReadStream: fs.createReadStream };
afterEach(() => {
    promises.readdir = realFs.readdir;
    promises.stat = realFs.stat;
    fs.createReadStream = realFs.createReadStream;
});

describe("archive access errors", () => {
    it("propagates permission errors on the archive root instead of reporting a clean miss", async () => {
        promises.readdir = async (dir: any, opts: any) => {
            if (dir === root) throw deny("EACCES");
            return realFs.readdir(dir, opts);
        };
        await assert.rejects(search({ query: "jwt" }), { code: "EACCES" });
    });

    it("keeps matches from readable projects when one project dir is unreadable", async () => {
        promises.readdir = async (dir: any, opts: any) => {
            if (dir === projB) throw deny("EACCES");
            return realFs.readdir(dir, opts);
        };
        const partial = await search({ query: "jwt" });
        assert.ok(partial.details.matchCount > 0);
        assert.equal(partial.details.truncated, true);
        assert.match(partial.text, /Search incomplete/);
    });
});

describe("aborted signal", () => {
    it("yields zero matches and an incomplete scan", async () => {
        const ac = new AbortController();
        ac.abort();
        const aborted = await search({ query: "jwt" }, archiveCtx(), ac.signal);
        assert.equal(aborted.details.matchCount, 0);
        assert.equal(aborted.details.truncated, true);
        assert.match(aborted.text, /Search incomplete/);
    });
});

describe("file stat errors", () => {
    it.each([
        { code: "ENOENT", outcome: "a skipped file", truncated: false, text: /No matches for "jwt" in 0 scanned/ },
        { code: "EACCES", outcome: "an incomplete scan", truncated: true, text: /Search incomplete/ },
    ])("treats $code as $outcome", async ({ code, truncated, text }) => {
        promises.stat = async () => {
            throw deny(code);
        };
        const result = await search({ query: "jwt" });
        assert.equal(result.details.matchCount, 0);
        assert.equal(result.details.truncated, truncated);
        assert.match(result.text, text);
    });
});

describe("read errors", () => {
    it("reports an incomplete scan rather than a definitive miss", async () => {
        fs.createReadStream = (() =>
            Readable.from(
                (async function* () {
                    throw new Error("read failed");
                })(),
            )) as any;
        const failed = await search({ query: "missing", session: "projA" });
        assert.match(failed.text, /No matches for "missing"/);
        assert.match(failed.text, /Search incomplete/);
    });
});

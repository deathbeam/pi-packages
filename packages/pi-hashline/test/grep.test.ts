import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createHarness, needleLines, oversizedMatch, wideLines, type Harness } from "./helpers.ts";

let h: Harness;

beforeAll(() => {
    h = createHarness();
});

afterAll(() => h.close());

/** A tree with a hidden file, git metadata and an ignored file, all matching "needle". */
function writeHiddenTree(): string {
    const root = join(h.dir, "hidden");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "needle metadata\n");
    writeFileSync(join(root, ".hidden-grep.txt"), needleLines(200));
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(root, "ignored.txt"), needleLines(1));
    return root;
}

describe("grep", () => {
    it("prints 3-char anchors", async () => {
        const file = h.write("grep-smoke.ts", "const y = 2;\n");
        const result = await h.grep({ pattern: "const y", path: file });
        assert.match(result.content[0].text, /#[A-Z]{3}:const y = 2;/);
    });

    it("keeps a match on a line too large to anchor", async () => {
        const result = await h.grep({ pattern: "oversized", path: h.write("long-match.txt", oversizedMatch()) });
        assert.match(result.content[0].text, /Line 1 cannot fit.*\(match\)/);
        assert.match(result.content[0].text, /^2#[A-Z]{3}:oversized short$/m);
        assert.equal(result.details.truncated, true);
        assert.ok(result.details.noticeCount);
    });

    it("keeps later matches when a line exceeds the remaining byte budget", async () => {
        const file = h.write(
            "budget-match.txt",
            `budget ${"a".repeat(26 * 1024)}\nbudget ${"b".repeat(26 * 1024)}\nbudget short\n`,
        );
        const result = await h.grep({ pattern: "budget", path: file });
        assert.match(result.content[0].text, /^1#[A-Z]{3}:budget a/m);
        assert.match(result.content[0].text, /Line 2 cannot fit/);
        assert.match(result.content[0].text, /^3#[A-Z]{3}:budget short$/m);
        assert.equal(result.details.truncated, true);
    });

    it("has no five-line ceiling on context", async () => {
        const file = h.write("wide.txt", wideLines(2201));
        assert.equal(h.byName.grep.parameters.properties.context.maximum, undefined);
        const result = await h.grep({ pattern: "wide_100 =", path: file, context: 6 });
        const shown = [...result.content[0].text.matchAll(/^\s*(\d+)#[A-Z]{3}:/gm)].map((match) => Number(match[1]));
        assert.deepEqual(
            shown,
            Array.from({ length: 13 }, (_, i) => 95 + i),
        );
    });

    it("caps a huge context at the output budget", async () => {
        const file = h.write("wide-context.txt", wideLines(2201));
        const result = await h.grep({ pattern: "wide_100 =", path: file, context: 100000 });
        const lines = result.content[0].text.split("\n");
        const body = lines.slice(0, -result.details.noticeCount - 2);
        assert.equal(result.details.truncated, true);
        assert.match(result.content[0].text, /Truncated/);
        assert.ok(result.details.noticeCount);
        assert.ok(body.length <= 2000);
        assert.ok(Buffer.byteLength(body.join("\n"), "utf8") <= 50 * 1024);
    });

    it("reports the match limit when the line cap hits before the byte cap", async () => {
        for (let i = 0; i < 3; i++) {
            writeFileSync(join(h.dir, `line-cap-${i}.txt`), `cap-hit\n${"x\n".repeat(2100)}`);
        }
        const result = await h.grep({
            pattern: "cap-hit",
            path: h.dir,
            glob: "line-cap-*.txt",
            limit: 2,
            context: 3000,
        });
        const text = result.content[0].text;
        assert.match(text, /after 2 selected matches \(stopped at match limit 2\)/);
        assert.match(text, /selected before output cap/);
        assert.equal(result.details.truncated, true);
        assert.ok(result.details.noticeCount);
        assert.ok(text.split("\n").length - result.details.noticeCount - 2 <= 2000);
        assert.ok(text.split("\n").length > 2000);
    });

    it("shows hidden files but not git metadata or ignored files", async () => {
        const root = writeHiddenTree();
        const text = (await h.grep({ pattern: "needle", path: root, limit: 200 })).content[0].text;
        assert.match(text, /\.hidden-grep\.txt/);
        assert.doesNotMatch(text, /ignored\.txt/);
        assert.doesNotMatch(text, /\.git\/HEAD/);
    });

    it("caps long output with whole anchor lines and aligned highlights", async () => {
        const result = await h.grep({ pattern: "needle", path: writeHiddenTree(), limit: 200 });
        const lines = result.content[0].text.split("\n");
        const body = lines.slice(0, -result.details.noticeCount - 2);
        assert.match(result.content[0].text, /Truncated/);
        assert.ok(result.details.noticeCount);
        assert.ok(body.length <= 2000);
        assert.ok(Buffer.byteLength(body.join("\n"), "utf8") <= 50 * 1024);
        for (const line of body.filter((line: string) => /^\s*\d+#/.test(line))) {
            assert.match(line, /^\s*\d+#[A-Z]{3}:needle x{300} \d+$/);
        }
        for (const entry of result.details.highlights ?? []) {
            assert.ok(entry.line < body.length);
            const stripped = lines[entry.line].replace(/^\s*\d+#[A-Z]{3}:/, "");
            for (const [start, end] of entry.ranges) {
                assert.equal(stripped.slice(start, end), "needle");
            }
        }
    });

    it("errors when ripgrep fails", async () => {
        await assert.rejects(h.grep({ pattern: "needle", path: join(h.dir, "does-not-exist") }), /ripgrep error/);
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
        "keeps matches and flags truncation when ripgrep fails partway",
        async () => {
            h.write("open-hit.ts", "needle open\n");
            const lockedDir = join(h.dir, "locked");
            mkdirSync(lockedDir);
            writeFileSync(join(lockedDir, "secret.ts"), "needle secret\n");
            chmodSync(lockedDir, 0o000);
            let result;
            try {
                result = await h.grep({ pattern: "needle", path: h.dir, glob: "*.ts" });
            } finally {
                chmodSync(lockedDir, 0o700);
            }
            assert.match(result.content[0].text, /needle open/);
            assert.match(result.content[0].text, /Partial ripgrep results/);
            assert.equal(result.details.truncated, true);
        },
    );

    it('treats the pattern "null" as a real pattern', async () => {
        const result = await h.grep({ pattern: "null", path: h.write("null-pattern.txt", "null here\nother\n") });
        assert.match(result.content[0].text, /#[A-Z]{3}:null here/);
    });
});

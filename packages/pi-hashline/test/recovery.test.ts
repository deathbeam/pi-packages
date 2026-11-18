import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { anchorAt, createHarness, type Harness } from "./helpers.ts";

let h: Harness;

beforeAll(() => {
    h = createHarness();
});

afterAll(() => h.close());

const fileText = (path: string) => readFileSync(path, "utf8");

describe("stale-anchor recovery", () => {
    it("merges a unique search window onto live content", async () => {
        const file = h.write("shift.ts", "const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\n");
        const pos = anchorAt(await h.readText(file), 2);
        // an external prepend shifts every line; the hunk's window stays unique
        h.write("shift.ts", "const zero = 0;\nconst one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\n");
        const result = await h.edit({ path: file, edits: [{ op: "replace", pos, lines: ["const two = 22;"] }] });
        assert.match(result.content[0].text, /Recovered stale anchors/);
        assert.equal(
            fileText(file),
            "const zero = 0;\nconst one = 1;\nconst two = 22;\nconst three = 3;\nconst four = 4;\n",
        );
    });

    it("refuses an ambiguous search window and writes nothing", async () => {
        const block = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
        const file = h.write("dup.ts", block.repeat(2) + "const a = 1;\n");
        const pos = anchorAt(await h.readText(file), 1);
        // external prepend (the anchor's context hash no longer matches, so recovery runs)
        // plus a repeated block: the hunk window [a,b,c,a] now matches three times
        const changed = "const zero = 0;\n" + block.repeat(3) + "const a = 1;\n";
        h.write("dup.ts", changed);
        await assert.rejects(
            h.edit({ path: file, edits: [{ op: "replace", pos, lines: ["const a = 111;"] }] }),
            (error: Error) => {
                assert.match(error.message, /E_STALE_ANCHOR/);
                assert.match(error.message, /Recovery attempted/);
                return true;
            },
        );
        assert.equal(fileText(file), changed);
    });

    it("keeps read snapshots recoverable across a broad grep", async () => {
        const file = h.write("evict-target.ts", "const one = 1;\nconst two = 2;\nconst three = 3;\n");
        const pos = anchorAt(await h.readText(file), 2);
        const many = join(h.dir, "many");
        mkdirSync(many);
        for (let i = 0; i < 10; i++) writeFileSync(join(many, `f${i}.ts`), `needle ${i}\n`);
        await h.grep({ pattern: "needle", path: many });
        h.write("evict-target.ts", "const zero = 0;\nconst one = 1;\nconst two = 2;\nconst three = 3;\n");
        const result = await h.edit({ path: file, edits: [{ op: "replace", pos, lines: ["const two = 22;"] }] });
        assert.match(result.content[0].text, /Recovered stale anchors/);
    });

    it("merges onto the live file and keeps its frame", async () => {
        const rows = Array.from({ length: 12 }, (_, i) => `r${i + 1}`);
        const file = h.write("recovery-note.ts", rows.join("\n") + "\n");
        const pos = anchorAt(await h.readText(file), 3);
        // the change sits far from EOF, so the anchor window does not reach it
        h.write("recovery-note.ts", "zero\n" + rows.join("\n") + "\n");
        const result = await h.edit({ path: file, edits: [{ op: "replace", pos, lines: ["R3a", "R3b"] }] });
        assert.match(result.content[0].text, /Recovered stale anchors/);
        const lines = fileText(file).split("\n");
        assert.deepEqual(lines.slice(0, 5), ["zero", "r1", "r2", "R3a", "R3b"]);
        assert.equal(lines.length, 15);
    });

    it("does not downgrade a read path when it is grepped", async () => {
        const file = h.write("keep-read.ts", "const keep = 1;\nconst two = 2;\n");
        await h.read({ path: h.write("filler.ts", "filler\n") });
        const pos = anchorAt(await h.readText(file), 2);
        await h.grep({ pattern: "keep", path: file });
        for (let i = 0; i < 7; i++) {
            await h.read({ path: h.write(`other-${i}.ts`, `other ${i}\n`) });
        }
        h.write("keep-read.ts", "const zero = 0;\nconst keep = 1;\nconst two = 2;\n");
        const result = await h.edit({ path: file, edits: [{ op: "replace", pos, lines: ["const two = 22;"] }] });
        assert.match(result.content[0].text, /Recovered stale anchors/);
    });
});

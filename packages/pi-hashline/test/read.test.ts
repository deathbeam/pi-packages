import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { anchorAt, createHarness, wideLines, type Harness } from "./helpers.ts";

let h: Harness;

beforeAll(() => {
    h = createHarness();
});

afterAll(() => h.close());

const sample = "const x = 1;\nconst y = 2;\nconst z = 3;\n";

describe("registration", () => {
    it("registers read, edit and grep", () => {
        assert.deepEqual(h.registered.map((tool) => tool.name).sort(), ["edit", "grep", "read"]);
    });

    it("requests strict json_schema constrained sampling on read and edit", () => {
        for (const name of ["read", "edit"]) {
            assert.deepEqual(h.byName[name].constrainedSampling, { type: "json_schema", strict: "prefer" });
        }
    });
});

describe("read", () => {
    it("prints lines as LINE#HASH:content with 3-char hashes", async () => {
        const text = await h.readText(h.write("sample.ts", sample));
        assert.match(text, /^\s*1#[A-Z]{3}:const x = 1;$/m);
        assert.match(text, /^\s*3#[A-Z]{3}:const z = 3;$/m);
    });

    it("treats null offset and limit as omitted", async () => {
        const file = h.write("null-params.ts", sample);
        const head = await h.read({ path: file, offset: null, limit: null });
        assert.match(head.content[0].text, /^\s*1#[A-Z]{3}:const x = 1;$/m);
        assert.equal(head.details.nextOffset, undefined);
        const limited = await h.read({ path: file, offset: null, limit: 2 });
        assert.match(limited.content[0].text, /\[Showing lines 1-2 of 3\. Use offset=3 to continue\.\]/);
    });
});

describe("path resolution", () => {
    it("resolves Pi-style @/Unicode-space paths and file URLs across read, edit and grep", async () => {
        const file = h.write("space name.ts", "const path = 1;\n");
        const ref = `@${file.replace(" ", "\u202f")}`;
        const pos = anchorAt((await h.read({ path: ref })).content[0].text, 1);
        await h.edit({ path: ref, edits: [{ op: "replace", pos, lines: ["const path = 2;"] }] });
        const grepped = await h.grep({ pattern: "const path = 2;", path: ref, literal: true });
        assert.match(grepped.content[0].text, /#[A-Z]{3}:const path = 2;/);
        const fromUrl = await h.read({ path: pathToFileURL(file).href });
        assert.match(fromUrl.content[0].text, /#[A-Z]{3}:const path = 2;/);
    });

    it('treats grep path "null" as omitted', async () => {
        h.write("null-path.ts", sample);
        const grepped = await h.grep({ pattern: "const x = 1;", path: "null" });
        assert.match(grepped.content[0].text, /#[A-Z]{3}:const x = 1;/);
    });
});

describe("read caps", () => {
    it("reads a huge single line raw without an inverted range", async () => {
        const result = await h.read({ path: h.write("big.txt", "x".repeat(60 * 1024)), raw: true });
        assert.doesNotMatch(result.content[0].text, /lines 1-0/);
        assert.equal(result.details.nextOffset, undefined);
    });

    it("uses the full 50KB content budget", async () => {
        const result = await h.read({ path: h.write("near-cap.txt", "x".repeat(50 * 1024 - 500)) });
        assert.match(result.content[0].text, /^1#[A-Z]{3}:x/m);
        assert.ok(!result.details.truncation?.firstLineExceedsLimit);
    });

    it("caps a wide read with a continuation offset that still anchors", async () => {
        const file = h.write("wide.txt", wideLines(2201));
        const first = await h.read({ path: file, limit: 100000 });
        const text = first.content[0].text;
        const notice = text.match(/Use offset=(\d+) to continue/);
        assert.ok(notice);
        assert.equal(first.details.nextOffset, Number(notice[1]));
        assert.ok(text.split("\n").filter((line: string) => /^\s*\d+#[A-Z]{3}:/.test(line)).length <= 2000);
        assert.ok(Buffer.byteLength(text.split("\n\n[Showing lines ")[0], "utf8") <= 50 * 1024);

        const nextOffset = first.details.nextOffset;
        const page = await h.read({ path: file, offset: nextOffset });
        await h.edit({
            path: file,
            edits: [
                { op: "replace", pos: anchorAt(page.content[0].text, nextOffset), lines: ["const continued = true;"] },
            ],
        });
        const continued = await h.readText(file, { offset: nextOffset, limit: 1 });
        assert.match(continued, new RegExp(`^\\s*${nextOffset}#[A-Z]{3}:const continued = true;$`, "m"));
    });
});

describe("abort", () => {
    it.each(["read", "edit", "grep"])("aborts %s when the signal is already aborted", async (name) => {
        const file = h.write(`${name}-abort.ts`, sample);
        const call = h.byName[name].execute("id", { path: file }, AbortSignal.abort(), () => {}, h.ctx);
        await assert.rejects(call, /Operation aborted/);
    });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, it } from "vitest";
import { anchorAt, createHarness, type Harness } from "./helpers.ts";

let h: Harness;

beforeAll(() => {
    h = createHarness();
});

afterAll(() => h.close());

const sample = "const x = 1;\nconst y = 2;\nconst z = 3;\n";

const fileText = (path: string) => readFileSync(path, "utf8");

describe("edit", () => {
    it("replaces a line using the anchor from read output", async () => {
        const file = h.write("sample.ts", sample);
        await h.edit({
            path: file,
            edits: [{ op: "replace", pos: anchorAt(await h.readText(file), 2), lines: ["const y = 20;"] }],
        });
        assert.equal(fileText(file), "const x = 1;\nconst y = 20;\nconst z = 3;\n");
    });

    it("applies a shared-boundary append after the whole replacement", async () => {
        const file = h.write("order.ts", "a\nb\nc\n");
        const pos = anchorAt(await h.readText(file), 2);
        await h.edit({
            path: file,
            edits: [
                { op: "replace", pos, lines: ["X", "Y"] },
                { op: "append", pos, lines: ["Z"] },
            ],
        });
        assert.equal(fileText(file), "a\nX\nY\nZ\nc\n");
    });

    it("accepts the whole LINE#HASH:content line read prints as the anchor", async () => {
        const file = h.write("hinted.ts", sample);
        const printed = (await h.readText(file))
            .split("\n")
            .find((line: string) => line.includes("const y = 2;"))!
            .trim();
        const result = await h.edit({
            path: file,
            edits: [{ op: "replace", pos: printed, lines: ["const y = 222;"] }],
        });
        assert.doesNotMatch(result.content[0].text, /E_STALE_ANCHOR/);
        assert.equal(fileText(file), "const x = 1;\nconst y = 222;\nconst z = 3;\n");
    });

    it("does not claim a line-ending rewrite on a no-op", async () => {
        const file = h.write("endings-noop.txt", "alpha\r\nbeta\n");
        const result = await h.edit({
            path: file,
            edits: [{ op: "replace", pos: anchorAt(await h.readText(file), 1), lines: ["alpha"] }],
        });
        assert.ok(result.details.warnings.some((warning: string) => warning.startsWith("No changes made to ")));
        assert.ok(!result.details.warnings.some((warning: string) => /rewrote/.test(warning)));
        assert.doesNotMatch(result.content[0].text, /Classification: noop/);
        assert.equal(fileText(file), "alpha\r\nbeta\n");
    });

    it("warns that mixed line endings were rewritten on a real write", async () => {
        const file = h.write("endings-write.txt", "alpha\r\nbeta\n");
        const result = await h.edit({
            path: file,
            edits: [{ op: "replace", pos: anchorAt(await h.readText(file), 1), lines: ["ALPHA"] }],
        });
        assert.ok(result.details.warnings.some((warning: string) => /rewrote it uniformly as CRLF/.test(warning)));
        assert.equal(fileText(file), "ALPHA\r\nbeta\r\n");
    });

    it("rejects top-level oldText in prepareArguments, like pi's agent loop", () => {
        const file = h.write("oldtext.ts", sample);
        assert.throws(
            () => h.byName.edit.prepareArguments({ path: file, oldText: "a", newText: "b" }),
            /Text-replace edits are not supported/,
        );
    });

    it("drops null pos/end in pi validation and rejects null lines", () => {
        const file = h.write("null-edit.ts", sample);
        const validated = validateToolArguments(
            { name: "edit", parameters: h.byName.edit.parameters } as any,
            {
                name: "edit",
                arguments: h.byName.edit.prepareArguments({
                    path: file,
                    edits: [
                        { op: "append", pos: null, lines: ["tail"] },
                        { op: "replace", pos: "1#AAA", end: null, lines: ["x"] },
                    ],
                }),
            } as any,
        );
        assert.equal(validated.edits[0].pos, undefined);
        assert.equal(validated.edits[1].end, undefined);
        assert.throws(
            () => h.byName.edit.prepareArguments({ path: file, edits: [{ op: "replace", pos: "1#AAA", lines: null }] }),
            /"lines" is null/,
        );
    });

    it("treats end:null as one line and pos:null as EOF on the model path", async () => {
        const file = h.write("null-e2e.ts", sample);
        await h.agentLoopRun(h.byName.edit, {
            path: file,
            edits: [{ op: "replace", pos: anchorAt(await h.readText(file), 1), end: null, lines: ["const x = 11;"] }],
        });
        assert.equal(fileText(file), "const x = 11;\nconst y = 2;\nconst z = 3;\n");
        await h.agentLoopRun(h.byName.edit, {
            path: file,
            edits: [{ op: "append", pos: null, lines: ["const w = 4;"] }],
        });
        assert.equal(fileText(file), "const x = 11;\nconst y = 2;\nconst z = 3;\nconst w = 4;\n");
    });

    it("rejects an edit item that is not an object", async () => {
        const file = h.write("non-record.ts", sample);
        await assert.rejects(h.edit({ path: file, edits: [null] }), /Edit 0 must be an object/);
    });

    it("reaches its teaching errors for op misuse through the flat item schema", async () => {
        const file = h.write("op-misuse.ts", sample);
        await assert.rejects(
            h.agentLoopRun(h.byName.edit, {
                path: file,
                edits: [{ op: "append", pos: "1#AAA", end: "2#BBB", lines: ["x"] }],
            }),
            /does not support "end"/,
        );
        await assert.rejects(
            h.agentLoopRun(h.byName.edit, { path: file, edits: [{ op: "replace", lines: ["x"] }] }),
            /requires a "pos" anchor/,
        );
    });

    it("accepts lowercase anchors", async () => {
        const file = h.write("lower.ts", "const lower = 1;\nconst second = 2;\n");
        const pos = anchorAt(await h.readText(file), 1).toLowerCase();
        await h.edit({ path: file, edits: [{ op: "replace", pos, lines: ["const lower = 42;"] }] });
        assert.equal(fileText(file), "const lower = 42;\nconst second = 2;\n");
    });

    it("refuses to edit a binary file", async () => {
        const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
        const file = h.write("binary.dat", bytes);
        await assert.rejects(h.edit({ path: file, edits: [{ op: "append", lines: ["text"] }] }), /binary file/);
        assert.deepEqual(readFileSync(file), bytes);
    });

    it("rejects a numbered display prefix smuggled into a replacement", async () => {
        const file = h.write("prefix.ts", "const first = 1;\nconst second = 2;\n");
        const pos = anchorAt(await h.readText(file), 2);
        await assert.rejects(
            h.edit({
                path: file,
                edits: [{ op: "replace", pos, lines: [`${pos.toLowerCase()}: const smuggled = 1;`] }],
            }),
            /E_INVALID_PATCH/,
        );
        assert.doesNotMatch(fileText(file), /smuggled/);
    });

    it("accepts literal lines that look like anchors", async () => {
        const file = h.write("literals.ts", "a\nb\n");
        const literals = ["# npm: install", "# TSX: notes", "- 12    indented"];
        await h.edit({
            path: file,
            edits: [{ op: "append", pos: anchorAt(await h.readText(file), 1), lines: literals }],
        });
        for (const literal of literals) {
            assert.ok(fileText(file).includes(literal), `literal rejected: ${JSON.stringify(literal)}`);
        }
    });

    it("rejects a repeated edit of the same anchors", async () => {
        const file = h.write("duplicate.ts", sample);
        const edits = [{ op: "replace", pos: anchorAt(await h.readText(file), 2), lines: ["const y = 24;"] }];
        await h.edit({ path: file, edits });
        await assert.rejects(h.edit({ path: file, edits }), /E_DUPLICATE_EDIT/);
    });

    it("keeps the duplicate guard after a partial read", async () => {
        const file = h.write("partial-read.ts", sample);
        const edits = [{ op: "append", lines: ["const tail = 4;"] }];
        await h.edit({ path: file, edits });
        // The paginated read never showed the appended line, so it cannot excuse a retry.
        await h.read({ path: file, limit: 1 });
        await assert.rejects(h.edit({ path: file, edits }), /E_DUPLICATE_EDIT/);
    });

    it("drops the duplicate guard after a full read", async () => {
        const file = h.write("full-read.ts", sample);
        const edits = [{ op: "append", lines: ["const tail = 4;"] }];
        await h.edit({ path: file, edits });
        await h.read({ path: file });
        await h.edit({ path: file, edits });
        assert.match(fileText(file), /const tail = 4;\n[\s\S]*const tail = 4;/);
    });
});

describe("file shapes", () => {
    it.each([
        {
            title: "keeps CRLF endings",
            name: "crlf.txt",
            before: "alpha\r\nbeta\r\ngamma\r\n",
            after: "alpha\r\nBETA\r\ngamma\r\n",
            lines: ["BETA"],
        },
        {
            title: "preserves a BOM",
            name: "bom.ts",
            before: "\uFEFFconst a = 1;\nconst b = 2;\n",
            after: "\uFEFFconst a = 1;\nconst b = 22;\n",
            lines: ["const b = 22;"],
        },
        {
            title: "keeps a missing trailing newline",
            name: "no-eol.txt",
            before: "one\ntwo",
            after: "one\nTWO",
            lines: ["TWO"],
        },
        {
            title: "strips a stray CR from a payload",
            name: "cr-payload.txt",
            before: "one\ntwo\n",
            after: "one\nTWO\n",
            lines: ["TWO\r"],
        },
        {
            title: "strips a payload CR before CRLF endings",
            name: "crlf-payload.txt",
            before: "one\r\ntwo\r\n",
            after: "one\r\nTWO\r\n",
            lines: ["TWO\r"],
        },
    ])("$title", async ({ name, before, after, lines }) => {
        const file = h.write(name, before);
        await h.edit({ path: file, edits: [{ op: "replace", pos: anchorAt(await h.readText(file), 2), lines }] });
        assert.equal(fileText(file), after);
    });

    it("appends to and prepends in an empty file", async () => {
        const file = h.write("empty.txt", "");
        await h.edit({ path: file, edits: [{ op: "append", lines: ["first"] }] });
        assert.equal(fileText(file), "first");
        await h.edit({
            path: file,
            edits: [{ op: "prepend", pos: anchorAt(await h.readText(file), 1), lines: ["zero"] }],
        });
        assert.equal(fileText(file), "zero\nfirst");
    });

    it("returns anchors around the deletion point after deleting a range", async () => {
        const file = h.write("pure-del.txt", Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
        const read = await h.readText(file);
        const result = await h.edit({
            path: file,
            edits: [{ op: "replace", pos: anchorAt(read, 1), end: anchorAt(read, 10), lines: [] }],
        });
        assert.match(result.content[0].text, /^--- Anchors 1-3 ---$/m);
        assert.match(result.content[0].text, /^1#[A-Z]{3}:line 11$/m);
        assert.equal(fileText(file).split("\n")[0], "line 11");
    });
});

describe("edits around a replaced range", () => {
    it("allows a prepend at the start of a replaced range", async () => {
        const file = h.write("prepend-start.txt", "a\nb\nc\n");
        const read = await h.readText(file);
        await h.edit({
            path: file,
            edits: [
                { op: "replace", pos: anchorAt(read, 1), end: anchorAt(read, 2), lines: ["X", "Y"] },
                { op: "prepend", pos: anchorAt(read, 1), lines: ["P"] },
            ],
        });
        assert.equal(fileText(file), "P\nX\nY\nc\n");
    });

    it("rejects a prepend inside a replaced range", async () => {
        const file = h.write("prepend-inside.txt", "a\nb\nc\n");
        const read = await h.readText(file);
        await assert.rejects(
            h.edit({
                path: file,
                edits: [
                    { op: "replace", pos: anchorAt(read, 1), end: anchorAt(read, 2), lines: ["X"] },
                    { op: "prepend", pos: anchorAt(read, 2), lines: ["Z"] },
                ],
            }),
            /E_EDIT_CONFLICT/,
        );
        assert.equal(fileText(file), "a\nb\nc\n");
    });
});

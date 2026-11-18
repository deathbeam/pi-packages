import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { anchorAt, createHarness, needleLines, oversizedMatch, stripAnsi, wideLines, type Harness } from "./helpers.ts";

let h: Harness;

beforeAll(() => {
    h = createHarness();
});

afterAll(() => h.close());

const writeTsFile = () =>
    h.write("render-check.ts", "const value = 1;\n\t// a comment\nexport function hi() { return value; }\n");

describe("renderer wiring", () => {
    it("uses pi's built-in edit call renderer and custom result renderers", () => {
        assert.equal(h.byName.edit.renderCall, undefined);
        assert.equal(typeof h.byName.edit.renderResult, "function");
        assert.equal(typeof h.byName.read.renderResult, "function");
    });
});

describe("edit result renderer", () => {
    it("renders the diff and warnings headerless, with no leading blank line", async () => {
        const file = h.write("warn.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
        // appending the lines that already follow line 1 raises the duplicate-insert warning
        const result = await h.edit({
            path: file,
            edits: [
                { op: "append", pos: anchorAt(await h.readText(file), 1), lines: ["const b = 2;", "const c = 3;"] },
            ],
        });
        assert.ok(result.details.warnings.length);
        const text = h.renderEdit(result, { path: file });
        assert.match(text, /«warning»Potential duplicate insert/);
        assert.doesNotMatch(text, /Warnings:/);
        assert.ok(!text.startsWith("\n"), "call Box already pads the result");
        assert.match(text, /const c = 3;/);
    });

    it("renders the model-facing error text", () => {
        const result = {
            content: [{ type: "text", text: "[E_STALE_ANCHOR] boom" }],
            details: { diff: "", warnings: [] },
        };
        assert.match(h.renderEdit(result, { path: "x.ts" }, { isError: true }), /E_STALE_ANCHOR/);
    });

    it("styles a no-op edit as a warning", async () => {
        const file = h.write("noop.txt", "alpha\r\nbeta\n");
        const result = await h.edit({
            path: file,
            edits: [{ op: "replace", pos: anchorAt(await h.readText(file), 1), lines: ["alpha"] }],
        });
        assert.match(h.renderEdit(result, { path: file }, { expanded: true }), /«warning»No changes made/);
    });

    it("caps a collapsed diff and shows every line when expanded", () => {
        const diff = Array.from({ length: 30 }, (_, i) => `+${i + 1} const v${i} = ${i};`).join("\n");
        const result = { content: [{ type: "text", text: "anchors" }], details: { diff, warnings: [] } };
        const collapsed = h.renderEdit(result, { path: "x.ts" }, { expanded: false });
        const expanded = h.renderEdit(result, { path: "x.ts" }, { expanded: true });
        assert.match(collapsed, /more diff lines/);
        assert.match(collapsed, /to expand/);
        assert.ok(collapsed.split("\n").length < expanded.split("\n").length);
        assert.doesNotMatch(collapsed, /const v29/);
        assert.match(expanded, /const v29/);
    });

    it("sanitizes raw ANSI escapes from file content", async () => {
        const file = h.write("escape.ts", "const a = 1;\nconst b = 2;\n");
        const result = await h.edit({
            path: file,
            edits: [
                { op: "replace", pos: anchorAt(await h.readText(file), 2), lines: ["const b = \u001b[2J\u001b[31m2;"] },
            ],
        });
        const raw = h.renderEdit(result, { path: file }, { expanded: true, strip: false });
        assert.ok(!raw.includes("\u001b[2J"));
        assert.ok(!raw.includes("\u001b[31m"));
        assert.match(stripAnsi(raw), /const b = .*2;/);
    });

    it("sanitizes unsafe control characters in warnings", () => {
        const result = {
            content: [{ type: "text", text: "anchors" }],
            details: { diff: "+1 const safe = true;", warnings: ["danger \u001b[31mred\ufff9"] },
        };
        const raw = h.renderEdit(result, { path: "x.ts" }, { expanded: true, strip: false });
        assert.ok(!raw.includes("\u001b[31m"));
        assert.ok(!raw.includes("\ufff9"));
    });
});

describe("read result renderer", () => {
    it("strips anchor prefixes and expands tabs for display only", async () => {
        const file = writeTsFile();
        const result = await h.read({ path: file });
        const text = h.renderRead(result, { path: file });
        assert.match(text, /value/);
        assert.doesNotMatch(text, /^\s*\d+#[A-Z]{3}:/m);
        assert.match(result.content[0].text, /\t\/\/ a comment/);
        assert.ok(!text.includes("\t"));
    });

    it("styles pagination and truncation notices", async () => {
        const file = writeTsFile();
        const limited = await h.read({ path: file, limit: 2 });
        assert.match(h.renderRead(limited, { path: file, limit: 2 }), /«muted»\[Showing lines 1-2 of 3/);
        const wide = h.write("wide.txt", wideLines(2201));
        const capped = await h.read({ path: wide, limit: 100000 });
        assert.match(h.renderRead(capped, { path: wide }), /«warning»\[Showing lines /);
    });

    it("keeps a notice lookalike in the body while styling the real trailing notice", async () => {
        const file = h.write(
            "lookalike.ts",
            "const a = 1;\n[Showing lines 9-9 of 99. Use offset=100 to continue.]\nconst c = 3;\n",
        );
        const result = await h.read({ path: file, limit: 2 });
        const text = h.renderRead(result, { path: file, limit: 2 });
        assert.match(text, /\[Showing lines 9-9 of 99/);
        assert.doesNotMatch(text, /«(muted|warning)»\[Showing lines 9-9/);
        assert.match(text, /«muted»\[Showing lines 1-2 of 3/);
    });

    it("warns for an empty file and an out-of-range offset", async () => {
        const empty = h.write("empty.ts", "");
        assert.match(h.renderRead(await h.read({ path: empty }), { path: empty }), /«warning»File is empty\./);
        const file = writeTsFile();
        const beyond = await h.read({ path: file, offset: 99 });
        assert.match(h.renderRead(beyond, { path: file, offset: 99 }), /«warning»Offset 99 is beyond end/);
    });

    it("warns for non-UTF-8 bytes, paginated or not", async () => {
        const file = h.write(
            "bad-utf8.ts",
            Buffer.concat([Buffer.from("const a = "), Buffer.from([0xff]), Buffer.from(";\nconst b = 2;\n")]),
        );
        const whole = await h.read({ path: file });
        assert.match(h.renderRead(whole, { path: file }), /«warning»\[Non-UTF-8 bytes/);
        const page = await h.read({ path: file, limit: 1 });
        const pageText = h.renderRead(page, { path: file, limit: 1 });
        assert.match(pageText, /«muted»\[Showing lines 1-1 of 2/);
        assert.match(pageText, /«warning»\[Non-UTF-8 bytes/);
    });

    it("warns when the first line cannot fit", async () => {
        const file = h.write("big.txt", "x".repeat(60 * 1024));
        const result = await h.read({ path: file, raw: true });
        assert.match(h.renderRead(result, { path: file }), /«warning»\[Line 1 cannot fit/);
    });

    it("keeps literal anchor-like content in raw mode", async () => {
        const file = h.write("literal-anchor.ts", "1#TPK:literal file content\n");
        const result = await h.read({ path: file, raw: true });
        assert.match(h.renderRead(result, { path: file, raw: true }), /1#TPK:literal file content/);
    });
});

describe("grep result renderer", () => {
    it("strips anchor prefixes and keeps content", async () => {
        const file = h.write("grep-render.ts", "const value = 1;\nconst other = 2;\n");
        const text = h.renderGrep(await h.grep({ pattern: "const ", path: file }));
        assert.doesNotMatch(text, /^\s*\d+#[A-Z]{3}:/m);
        assert.match(text, /«accent»const /);
        assert.match(text, /value = 1;/);
    });

    it("warns about truncated output and placeholder lines", async () => {
        const file = h.write("many-needle.txt", needleLines(200));
        const capped = await h.grep({ pattern: "needle", path: file, limit: 200 });
        const cappedText = h.renderGrep(capped);
        assert.match(cappedText, /«warning»\[Truncated/);
        assert.match(cappedText, /«accent»needle/);

        const oversized = await h.grep({ pattern: "oversized", path: h.write("long-match.txt", oversizedMatch()) });
        const oversizedText = h.renderGrep(oversized, { expanded: true });
        assert.match(oversizedText, /«warning»\[Line 1 cannot fit/);
        assert.match(oversizedText, /«warning»\[1 line\(s\) shown as placeholders/);
    });

    it("highlights matches by character offsets without resetting the background", async () => {
        const file = h.write(
            "hl.ts",
            'const emoji = "\u{1F3AF}\u{1F3AF}"; const \ufff9target = 1;\nconst plain = 2;\nconst target2 = 3;\n',
        );
        const result = await h.grep({ pattern: "target", path: file });
        const lines = result.content[0].text.split("\n");
        const highlights = result.details.highlights ?? [];
        assert.equal(highlights.length, 2, JSON.stringify(highlights));
        for (const entry of highlights) {
            const stripped = lines[entry.line].replace(/^\s*\d+#[^:]{1,4}:/, "");
            for (const [start, end] of entry.ranges) {
                assert.equal(stripped.slice(start, end), "target");
            }
        }

        // Real SGR codes: a default-background reset (\u001b[49m) in the highlight would
        // erase the tool panel background for the rest of the line.
        const hlTheme = {
            fg: (name: string, text: string) => `\u001b[38;5;250m«${name}»${text}\u001b[39m`,
            bg: (_name: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
            bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
        };
        const raw = h.renderGrep(result, { expanded: true, theme: hlTheme, strip: false });
        assert.ok(!raw.includes("\u001b[49m"));
        const rendered = stripAnsi(raw).split("\n");
        assert.ok(rendered.some((line) => line.includes("«accent»target")));
        assert.doesNotMatch(rendered.join("\n"), /^\s*\d+#[^:]{1,4}:/m);

        // Context lines stay unstyled, so grep with context to render the middle line too.
        const context = await h.grep({ pattern: "target", path: file, context: 1 });
        const contextText = h.renderGrep(context, { expanded: true, theme: hlTheme });
        const plainLine = contextText.split("\n").find((line) => line.includes("const plain = 2;"));
        assert.ok(plainLine);
        assert.ok(!plainLine.includes("«accent»"));
    });

    it("keeps raw grep output and highlights literal anchor-like lines", async () => {
        const file = h.write("raw-grep.txt", "1#TPK:literal anchor-like line\nneedle plain line\n");
        const result = await h.grep({ pattern: "literal|needle", path: file, raw: true });
        assert.match(result.content[0].text, /^needle plain line$/m);
        assert.match(result.content[0].text, /1#TPK:literal anchor-like line/);
        assert.match(h.renderGrep(result, { expanded: true, args: { raw: true } }), /1#TPK:«accent»literal/);
    });
});

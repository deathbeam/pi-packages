import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, describe, it } from "vitest";
import { cleanupTempDirs, tempDir, writeSettings } from "./helpers.ts";
import index from "../index.ts";

const project = tempDir("pi-images-project-");
const tools: Record<string, any> = {};
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const longPrompt = ["START", ...Array(10).fill("a very detailed prompt"), "END"].join("\n");

index({ on: () => {}, registerTool: (tool: any) => (tools[tool.name] = tool) } as any);
writeSettings(project, { generate: "inferhub/cb/gemini-3.0-pro-image" });

function render(prompt: string, { expanded = false, width = 80 } = {}): string[] {
    const context = { expanded, cwd: project, keyHint: (_key: string, hint: string) => `ctrl+o ${hint}` };
    return tools.image_generate.renderCall({ prompt }, theme, context).render(width).map(stripVTControlCharacters);
}

afterAll(cleanupTempDirs);

describe("image_generate renderCall", () => {
    it("shows the configured model and a truncated prompt preview", () => {
        const rows = render(longPrompt, { width: 40 });
        assert.match(rows[0], /^image_generate inferhub/);
        assert.ok(
            rows.every((row) => visibleWidth(row) <= 40),
            "collapsed call overflows the width",
        );
        assert.match(rows.join("\n"), /START/);
        assert.doesNotMatch(rows.join("\n"), /END/, "collapsed prompt must be truncated");
        assert.match(rows.join("\n"), /7 more lines/);
    });

    it("shows the whole prompt when expanded", () => {
        const rendered = render(longPrompt, { expanded: true }).join("\n");
        assert.match(rendered, /^image_generate inferhub\/cb\/gemini-3\.0-pro-image/m);
        assert.match(rendered, /END/);
        assert.doesNotMatch(rendered, /more lines/);
    });

    it("shows only the title for a blank prompt", () => {
        const rows = render("   ");
        assert.equal(rows.length, 1);
        assert.match(rows[0].trim(), /^image_generate inferhub/);
    });
});

import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { afterAll, describe, it } from "vitest";
import { removeArchive, search, tool } from "./helpers.ts";

afterAll(removeArchive);

const plainTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const renderContext = () => ({ keyHint: (_binding: string, description: string) => `ctrl+o ${description}` });

function renderLines(component: any): string {
    return component
        .render(200)
        .map((l: string) => l.trimEnd())
        .join("\n");
}

function callLine(args: any): string {
    return renderLines(tool.renderCall(args, plainTheme, renderContext()));
}

function resultView(result: any): any {
    return tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, renderContext());
}

describe("renderResult", () => {
    it("groups hits and shows the match and session count", async () => {
        const { text, details } = await search({ query: "jwt" });
        const view = renderLines(resultView({ content: [{ type: "text", text }], details }));
        assert.match(view, /4 match\(es\) in \d session\(s\)/);
        assert.match(view, /2026-09-01 other session in this project/);
    });

    it("collapses hits over the limit to the built-in expand hint", () => {
        const matches = Array.from({ length: 12 }, (_, i) => ({
            file: "f",
            date: "2026-09-01",
            role: "user",
            excerpt: `hit ${i}`,
            sameProject: true,
            project: "p",
        }));
        const view = renderLines(
            resultView({ content: [{ type: "text", text: "many" }], details: { matches, filesScanned: 1 } }),
        );
        assert.match(view, /\.\.\. \(3 more lines, ctrl\+o to expand\)/);
    });

    it("warns about a capped scan in the built-in truncation style", async () => {
        const { text, details } = await search({ query: "jwt", limit: 1 });
        assert.match(
            renderLines(resultView({ content: [{ type: "text", text }], details })),
            /\[Truncated: limit reached\]/,
        );
    });

    it("falls back to plain text for old or partial details", () => {
        const view = renderLines(
            resultView({ content: [{ type: "text", text: "old text" }], details: { matchCount: 1 } }),
        );
        assert.match(view, /old text/);
    });
});

describe("renderCall", () => {
    it("mirrors grep: title, quoted query, then toolOutput options", () => {
        assert.equal(callLine({ query: "jwt" }), 'search_archive "jwt"');
        assert.equal(
            callLine({ query: "jwt", session: "projA", limit: 3, perSession: 2, offset: 4 }),
            'search_archive "jwt" in projA limit 3 per session 2 offset 4',
        );
    });

    it('treats null and the literal "null" optionals as absent', () => {
        assert.equal(
            callLine({ query: "jwt", session: "null", limit: null, perSession: "null", offset: null }),
            'search_archive "jwt"',
        );
    });

    it("reuses the component pi hands back", () => {
        const reusable = new Text("", 0, 0);
        assert.equal(
            tool.renderCall({ query: "jwt" }, plainTheme, { ...renderContext(), lastComponent: reusable }),
            reusable,
        );
    });
});

import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import {
    capDiff,
    jobLine,
    limitOutput,
    outputPreview,
    piDiff,
    reportText,
    resultPreview,
    SPINNER_INTERVAL_MS,
    STATUS_COLORS,
    statusText,
    toolCallDetail,
    usageStats,
    widgetJobs,
} from "../src/format.ts";
import { cleanup } from "./helpers.ts";

afterAll(cleanup);

describe("statusText", () => {
    it("knows exactly the five job statuses", () => {
        assert.deepEqual(Object.keys(STATUS_COLORS).sort(), ["cancelled", "done", "failed", "interrupted", "running"]);
    });

    const bare = { fg: (_color: string, text: string) => text } as any;

    // One vocabulary: every status renders through statusText; only running spins with the clock.
    it("spins only the running status", () => {
        assert.notEqual(statusText(bare, "running", 0), statusText(bare, "running", SPINNER_INTERVAL_MS));
        for (const status of ["done", "failed", "cancelled", "interrupted"])
            assert.equal(
                statusText(bare, status as any, 0),
                statusText(bare, status as any, SPINNER_INTERVAL_MS),
                `${status} icon spins`,
            );
    });
});

describe("outputPreview", () => {
    it("shows the requested lines and counts the rest", () => {
        assert.deepEqual(outputPreview("a\nb", 5), { shown: ["a", "b"], hidden: 0 });
        assert.deepEqual(outputPreview("a\nb\nc", 2), { shown: ["a", "b"], hidden: 1 });
    });

    it("closes a code fence it cuts open", () => {
        assert.deepEqual(outputPreview("```\ncode\nmore", 2), { shown: ["```", "code", "```"], hidden: 1 });
        assert.deepEqual(outputPreview("```\na\n```\nb", 3), { shown: ["```", "a", "```"], hidden: 1 });
    });
});

describe("piDiff", () => {
    // A git unified diff must convert to pi's `+-<padded num> content` format before renderDiff colors it.
    const unified = [
        "diff --git a/x.ts b/x.ts",
        "index 111..222 100644",
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,4 +1,5 @@",
        " line1",
        "-old2",
        "+new2",
        "+new2b",
        " line3",
        "\\ No newline at end of file",
    ].join("\n");
    const converted = piDiff(unified).split("\n");

    it("rewrites a unified diff into pi's line format", () => {
        assert.deepEqual(converted, ["x.ts", " 1 line1", "-2 old2", "+2 new2", "+3 new2b", " 4 line3"]);
        for (const line of converted.slice(1)) assert.match(line, /^([-+ ]) *\d+ /);
    });

    it("renders added and removed lines unlike context", () => {
        const codes = renderDiff(piDiff(unified))
            .split("\n")
            .map((line) => /^\u001b\[([0-9;]+)m/.exec(line)?.[1]);
        assert.ok(codes[2] !== codes[1] && codes[3] !== codes[1], "added/removed lines must not render as context");
    });

    // One line-number width for the whole diff, so a later hunk with wider numbers stays aligned.
    it("pads the line numbers of every hunk to one width", () => {
        const multiHunk = [
            "diff --git a/y.ts b/y.ts",
            "--- a/y.ts",
            "+++ b/y.ts",
            "@@ -1,2 +1,2 @@",
            "-a",
            "+b",
            " c",
            "@@ -98,2 +98,2 @@",
            "-d",
            "+e",
            " f",
        ].join("\n");
        assert.deepEqual(piDiff(multiHunk).split("\n"), [
            "y.ts",
            "- 1 a",
            "+ 1 b",
            "  2 c",
            "    ...",
            "-98 d",
            "+98 e",
            " 99 f",
        ]);
    });
});

describe("usageStats", () => {
    it("formats tokens and elapsed time", () => {
        assert.equal(usageStats({}, 0), "0s");
        assert.equal(usageStats({ contextTokens: 900 }, 42000), "900 · 42s");
        assert.equal(usageStats({ contextTokens: 1234 }, 0), "1.2k · 0s");
        assert.equal(usageStats({ contextTokens: 200000 }, 0), "200k · 0s");
        assert.equal(usageStats({ contextTokens: 2400 }, 1000), "2.4k · 1s");
        assert.equal(
            usageStats({ toolCalls: 3, contextTokens: 2400, contextWindow: 200000 } as any, 42000),
            "2.4k/200k · 42s",
        );
        assert.equal(usageStats({}, 65000), "1m 05s");
        assert.equal(usageStats({}, 3720000), "1h 02m");
    });
});

describe("toolCallDetail", () => {
    it("names the interesting argument of each tool", () => {
        assert.equal(toolCallDetail("bash", { command: "npm test\nsecond" }), "npm test");
        assert.equal(toolCallDetail("read", { path: "src/a.ts" }), "src/a.ts");
        assert.equal(toolCallDetail("edit", { path: "src/a.ts" }), "src/a.ts");
        assert.equal(toolCallDetail("grep", { pattern: "foo", path: "src" }), "/foo/ in src");
        assert.equal(toolCallDetail("ls", {}), ".");
        assert.equal(toolCallDetail("bash", undefined), "");
    });
});

describe("resultPreview", () => {
    it("previews text, skips images and truncates long output", () => {
        assert.equal(resultPreview({ content: [{ type: "text", text: "\n  12 passing\n" }] }), "12 passing");
        assert.equal(resultPreview({ content: [{ type: "image", data: "x" }] }), undefined);
        assert.equal(resultPreview({ content: [{ type: "text", text: "x".repeat(200) }] })!.length, 120);
    });
});

describe("reportText", () => {
    it("reports a finished job with its stats and output", () => {
        assert.equal(
            reportText({
                id: "a1b2c3d4",
                agent: "explore",
                description: "find callers",
                toolCalls: 2,
                contextTokens: 2400,
                contextWindow: 200000,
                elapsedMs: 65000,
                output: "done",
            }),
            'Delegate "explore" (job a1b2c3d4, 2.4k/200k · 1m 05s) finished.\n\ndone',
        );
    });

    it("reports a job without output or stats", () => {
        assert.equal(
            reportText({ id: "a1b2c3d4", agent: "explore", description: "x", toolCalls: 0, elapsedMs: 1000 }),
            'Delegate "explore" (job a1b2c3d4, 1s) finished.',
        );
    });

    it("reports a failure with the revive hint", () => {
        assert.equal(
            reportText({
                id: "a1b2c3d4",
                agent: "explore",
                description: "x",
                toolCalls: 1,
                elapsedMs: 1000,
                error: "boom",
            }),
            'Delegate "explore" (job a1b2c3d4, 1s) failed: boom\nTo continue this job, call delegate_steer with id a1b2c3d4 and a message.',
        );
    });
});

describe("jobLine", () => {
    it("joins description, tokens and elapsed time", () => {
        assert.equal(jobLine({ description: "find callers" }, 42000), "find callers · 42s");
        assert.equal(jobLine({}, 0), "0s");
        assert.equal(jobLine({ description: "x", toolCalls: 3, contextTokens: 2400 } as any, 42000), "x · 2.4k · 42s");
    });
});

describe("widgetJobs", () => {
    it("shows the newest five jobs", () => {
        assert.deepEqual(widgetJobs([1, 2, 3, 4, 5]), { shown: [1, 2, 3, 4, 5], hidden: 0 });
        assert.deepEqual(widgetJobs([1, 2, 3, 4, 5, 6, 7, 8, 9]), { shown: [5, 6, 7, 8, 9], hidden: 4 });
    });
});

describe("limitOutput", () => {
    it("leaves short output alone", () => {
        assert.equal(limitOutput("ok"), "ok");
    });

    it("truncates at the byte cap and says how much it dropped", () => {
        assert.equal(
            limitOutput("x".repeat(2000), 1000),
            "x".repeat(1000) + "\n\n[Output truncated: 1000 bytes omitted.]",
        );
    });

    // A cut inside a multi-byte character backs off to the boundary instead of emitting U+FFFD.
    it("backs off to a UTF-8 boundary", () => {
        const longCjk = limitOutput("あ".repeat(40000), 1000).split("\n\n")[0]!;
        assert.ok(/^あ+$/.test(longCjk));
        assert.equal(Buffer.byteLength(longCjk, "utf8"), 999);
    });

    // A 4-byte astral character must not be cut into a lone surrogate.
    it("never emits a lone surrogate", () => {
        const longEmoji = limitOutput("🙂".repeat(1000), 1000).split("\n\n")[0]!;
        assert.ok(/^[\u{1F642}]+$/u.test(longEmoji));
        assert.equal(Array.from(longEmoji).length, 250);
    });
});

describe("capDiff", () => {
    // The 50 KiB cap keeps the truncation marker out of the patch a diff renderer parses.
    it("caps a huge patch and reports it outside the diff", () => {
        const bigPatch = `diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -1,1 +1,2 @@\n a\n+${"x".repeat(60 * 1024)}\n`;
        const cappedDiff = capDiff(bigPatch);
        assert.ok(cappedDiff.diff.length < bigPatch.length);
        assert.doesNotMatch(cappedDiff.diff, /Output truncated/);
        assert.match(cappedDiff.note!, /Output truncated/);
        assert.doesNotMatch(piDiff(cappedDiff.diff), /Output truncated/);
    });
});

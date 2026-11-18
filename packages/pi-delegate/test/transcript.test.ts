import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { sessionMessages } from "../src/child.ts";
import { History, Transcript } from "../src/inspector.ts";
import { cleanup, jobEntry, sessionDir, themeStub } from "./helpers.ts";

const { theme, colored, backgrounds } = themeStub();

beforeAll(() => mkdirSync(sessionDir, { recursive: true }));
afterAll(cleanup);

describe("History", () => {
    // The inspector windows the transcript: a warm cache never renders an offscreen row again.
    it("measures every row once and renders only the window", () => {
        const history = new History();
        const rendered: number[] = [];
        const row = (index: number) => ({
            render: () => {
                rendered.push(index);
                return [`row ${index}`];
            },
            invalidate() {},
        });
        for (let i = 0; i < 100; i++) history.add(row(i));
        const firstFrame = history.window(80, undefined, 10);
        assert.equal(firstFrame.total, 100);
        assert.deepEqual(
            firstFrame.lines,
            Array.from({ length: 10 }, (_, i) => `row ${90 + i}`),
        );
        assert.equal(rendered.length, 100, "the first frame must measure every row once");
        rendered.length = 0;
        const scrolled = history.window(80, 40, 10);
        assert.deepEqual(
            scrolled.lines,
            Array.from({ length: 10 }, (_, i) => `row ${40 + i}`),
        );
        assert.deepEqual(rendered, [], "a warm cache must not render offscreen rows");
        // A new row only renders itself.
        history.add(row(100));
        assert.deepEqual(history.window(80, undefined, 10).lines, [
            ...Array.from({ length: 9 }, (_, i) => `row ${91 + i}`),
            "row 100",
        ]);
        assert.deepEqual(rendered, [100]);
        // A width change re-renders rows once, lazily.
        rendered.length = 0;
        history.window(40, undefined, 10);
        assert.equal(rendered.length, 101);
    });
});

describe("Transcript", () => {
    // A restored compacted transcript explains itself instead of starting mid-conversation.
    it("shows compaction summaries and hides display: false messages", () => {
        const transcript = new Transcript(theme);
        const restoredJob = jobEntry("compacted1", "done");
        restoredJob.messages.push({
            role: "compactionSummary",
            summary: "Earlier work summarized.",
            tokensBefore: 1,
            timestamp: 1,
        });
        restoredJob.messages.push({
            role: "custom",
            customType: "archive-memory",
            content: "Recent sessions in this project",
            display: false,
            timestamp: 2,
        });
        transcript.sync(restoredJob.messages as any);
        const restoredText = transcript.window(80, undefined, 20).lines.join("\n");
        assert.match(restoredText, /Earlier work summarized\./);
        assert.doesNotMatch(restoredText, /Recent sessions/, "display: false messages stay hidden like in pi's chat");
    });

    // pi's chat components prefix their first and last lines with OSC 133 prompt markers. After the sidebar the
    // terminal would read one as a new shell prompt, so the history cache strips them.
    it("strips OSC 133 prompt markers", () => {
        const marked = new Transcript(theme);
        marked.sync([
            { role: "user", content: "hello there", timestamp: 1 },
            { role: "assistant", content: [{ type: "text", text: "hi back" }], timestamp: 2 },
        ] as any);
        const markedLines = marked.window(80, undefined, 20).lines;
        assert.ok(
            markedLines.some((line) => line.includes("hello there")),
            "user message missing from the transcript",
        );
        assert.ok(
            markedLines.some((line) => line.includes("hi back")),
            "assistant message missing from the transcript",
        );
        assert.doesNotMatch(markedLines.join("\n"), /\x1b\]133;/, "OSC 133 prompt markers reached the overlay");
    });

    // A finished job swaps its live message array for the session file's. The transcript rebuilds from the new
    // array instead of appending to the old count, so the reloaded transcript replaces the live one.
    it("replaces the live transcript with the reloaded session", () => {
        writeFileSync(
            join(sessionDir, "2026-01-01T00-00-00-000Z_delegate-swap1.jsonl"),
            `${JSON.stringify({ type: "session", id: "delegate-swap1" })}\n${JSON.stringify({
                type: "message",
                message: { role: "user", content: "live task" },
            })}\n${JSON.stringify({
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: "live answer" }] },
            })}\n${JSON.stringify({
                type: "message",
                message: { role: "user", content: "steer after" },
            })}\n`,
        );
        const liveMessages = [
            { role: "user", content: "live task", timestamp: 1 },
            { role: "assistant", content: [{ type: "text", text: "live answer" }], timestamp: 2 },
            { role: "assistant", content: [{ type: "text", text: "live tail" }], timestamp: 3 },
        ];
        const swapped = new Transcript(theme);
        swapped.sync(liveMessages as any);
        assert.match(swapped.window(80, undefined, 20).lines.join("\n"), /live tail/);
        const reloaded = sessionMessages(sessionDir, "swap1");
        assert.equal(reloaded.length, 3, "the seeded session file did not reload its messages");
        swapped.sync(reloaded);
        const swappedText = swapped.window(80, undefined, 20).lines.join("\n");
        assert.match(swappedText, /steer after/, "the reloaded transcript kept the stale live messages");
        assert.doesNotMatch(swappedText, /live tail/, "the reloaded transcript kept the stale live messages");
        assert.equal(swappedText.match(/live answer/g)?.length, 1, "the reloaded transcript duplicated its messages");
        assert.equal(swappedText.match(/live task/g)?.length, 1, "the reloaded transcript duplicated its messages");
    });

    // A warm scroll step renders no component, however long the transcript is.
    it("renders nothing on a warm scroll step", () => {
        const assistantRenders: number[] = [];
        const renderAssistant = AssistantMessageComponent.prototype.render;
        AssistantMessageComponent.prototype.render = function (this: any, width: number) {
            assistantRenders.push(width);
            return renderAssistant.call(this, width);
        };
        try {
            for (const count of [4, 400]) {
                const long = new Transcript(theme);
                long.sync(
                    Array.from({ length: count }, (_, i) => ({
                        role: "assistant",
                        content: [{ type: "text", text: `message ${i}` }],
                        timestamp: i,
                    })) as any,
                );
                long.window(80, undefined, 10);
                assistantRenders.length = 0;
                for (let i = 0; i < 5; i++) long.window(80, count + i, 10);
                assert.deepEqual(
                    assistantRenders,
                    [],
                    `a warm scroll step rendered ${assistantRenders.length} of ${count} messages`,
                );
            }
        } finally {
            AssistantMessageComponent.prototype.render = renderAssistant;
        }
    });
});

describe("tool call rows", () => {
    // Tool calls render as compact pi-style boxes: a call row and a result row, never JSON args.
    const toolCall: any = {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/foo.ts" } }],
        timestamp: 1,
    };
    const toolResult = (text: string, isError = false): any => ({
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        content: [{ type: "text", text }],
        isError,
        timestamp: 2,
    });

    it("renders a compact call and result row", () => {
        const toolTranscript = new Transcript(theme);
        toolTranscript.sync([toolCall, toolResult("const a = 1;\nsecond line")]);
        backgrounds.length = 0;
        const [spacer, ...toolRows] = toolTranscript.window(60, undefined, 20).lines;
        assert.equal(spacer, "", "a tool box is spaced from the previous row like pi's");
        assert.equal(toolRows.length, 4, "a tool box pads a call row and a result row like pi's");
        assert.match(toolRows[1], /^ read src\/foo\.ts\s*$/);
        assert.match(toolRows[2], /↳ const a = 1;\s*$/);
        assert.doesNotMatch(toolRows.join("\n"), /second line|"path"/, "tool rows must not dump args or output");
        assert.ok(
            toolRows.every((line) => visibleWidth(line) === 60),
            "tool rows must fill the pane width",
        );
        assert.deepEqual(
            [...new Set(backgrounds)],
            ["toolSuccessBg"],
            "a finished tool call uses pi's success background",
        );
    });

    // A finished tool with empty output still counts as finished: the result arrived, its preview is empty.
    it("treats an empty result as finished", () => {
        const silent = new Transcript(theme);
        silent.sync([toolCall, toolResult("")]);
        backgrounds.length = 0;
        silent.window(60, undefined, 20);
        assert.deepEqual([...new Set(backgrounds)], ["toolSuccessBg"], "a finished tool with no output stayed pending");
    });

    // A result still pending keeps pi's pending background, and a failure turns the box red.
    it("marks pending and failed tool calls", () => {
        const pending = new Transcript(theme);
        pending.sync([toolCall]);
        backgrounds.length = 0;
        pending.window(60, undefined, 20);
        assert.deepEqual(
            [...new Set(backgrounds)],
            ["toolPendingBg"],
            "a running tool call uses pi's pending background",
        );
        const failed = new Transcript(theme);
        failed.sync([toolCall, toolResult("boom", true)]);
        backgrounds.length = 0;
        colored.length = 0;
        failed.window(60, undefined, 20);
        assert.deepEqual([...new Set(backgrounds)], ["toolErrorBg"], "a failed tool call uses pi's error background");
        assert.ok(
            colored.some(([color, text]) => color === "error" && text === "boom"),
            "a failed result must render in the error color",
        );
    });
});

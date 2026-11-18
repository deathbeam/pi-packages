import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { runChild, sessionMessages } from "../src/child.ts";
import { cleanup, fakeChild } from "./helpers.ts";

const seedDir = mkdtempSync(join(tmpdir(), "pi-delegate-seed-"));

afterAll(() => {
    rmSync(seedDir, { recursive: true, force: true });
    cleanup();
});

describe("runChild", () => {
    // The protocol test uses a fake child: stdout splits a UTF-8 code point and steer returns a failed ack.
    it("collects messages and tool call counts", async () => {
        const fake = fakeChild();
        fake.stdin.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().trim().split("\n")) {
                if (!line) continue;
                const command = JSON.parse(line);
                if (command.type === "prompt") {
                    fake.stdout.write(
                        `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n`,
                    );
                    const bytes = Buffer.from(
                        `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "é" } })}\n`,
                    );
                    const split = bytes.indexOf(0xc3) + 1;
                    fake.stdout.write(bytes.subarray(0, split));
                    fake.stdout.write(bytes.subarray(split));
                } else if (command.type === "steer") {
                    fake.stdout.write(
                        `${JSON.stringify({ type: "response", id: command.id, command: "steer", success: false, error: "steer rejected" })}\n`,
                    );
                }
            }
        });
        const messages: any[] = [];
        const toolCalls: number[] = [];
        const run = runChild(fake, "task", undefined, (update: any) => {
            if (update.message) messages.push(update.message);
            if (update.toolCalls !== undefined) toolCalls.push(update.toolCalls);
        });
        assert.equal(fake.stdout.readableEncoding, "utf8");
        await assert.rejects(run.steer("steer"), /steer rejected/);
        assert.deepEqual(messages, [] as any[], "rejected steering should not add a message");
        fake.stdout.write(
            `${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } })}\n`,
        );
        fake.stdout.write(
            `${JSON.stringify({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "file loaded\nmore" }] } })}\n`,
        );
        fake.stdout.write(
            `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "é" }] } })}\n`,
        );
        // Consumed user messages preserve prose, ignore images, and never replace the final assistant output.
        const guidance = "Parent guidance\n\nKeep both paragraphs.";
        fake.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "user", content: guidance } })}\n`);
        fake.stdout.write(
            `${JSON.stringify({
                type: "message_end",
                message: {
                    role: "user",
                    content: [
                        { type: "text", text: "block one\n" },
                        { type: "image", data: "x", mimeType: "image/png" },
                        { type: "text", text: "block two" },
                    ],
                },
            })}\n`,
        );
        fake.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
        assert.equal(await run.done, "é");
        assert.deepEqual(toolCalls, [1]);
        assert.deepEqual(
            messages.map((message) => message.role),
            ["assistant", "user", "user"],
        );
        assert.equal(messages[0].content[0].text, "é");
        assert.equal(messages[1].content, guidance);
        assert.equal(
            messages[2].content
                .filter((part: any) => part.type === "text")
                .map((part: any) => part.text)
                .join(""),
            "block one\nblock two",
        );
    });

    // Inspectable assistant text must not be cut at the old 8 KiB ceiling.
    it("keeps long assistant text whole", async () => {
        const longText = "é" + "x".repeat(9000);
        const longMessage = fakeChild();
        let captured: string | undefined;
        longMessage.stdin.on("data", (chunk: Buffer) => {
            const command = JSON.parse(chunk.toString());
            if (command.type !== "prompt") return;
            longMessage.stdout.write(
                `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n`,
            );
            longMessage.stdout.write(
                `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: longText }] } })}\n`,
            );
            longMessage.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
        });
        const longRun = runChild(longMessage, "task", undefined, (update: any) => {
            if (update.message?.role === "assistant") captured = update.message.content[0].text;
        });
        assert.equal(await longRun.done, longText);
        assert.equal(captured, longText);
    });

    it("fails the run and kills the child when the prompt is rejected", async () => {
        const rejected = fakeChild();
        let killed = false;
        rejected.kill = () => (killed = true);
        rejected.stdin.on("data", (chunk: Buffer) => {
            const command = JSON.parse(chunk.toString());
            rejected.stdout.write(
                `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: false, error: "prompt rejected" })}\n`,
            );
        });
        await assert.rejects(runChild(rejected, "bad task", undefined).done, /prompt rejected/);
        assert.equal(killed, true);
        assert.equal(rejected.stdin.writableEnded, true);
    });

    // A revive whose get_state fails must fail the run, not prompt into an unverifiable transcript.
    it("fails a revive whose get_state fails", async () => {
        const unverifiable = fakeChild();
        unverifiable.stdin.on("data", (chunk: Buffer) => {
            const command = JSON.parse(chunk.toString());
            unverifiable.stdout.write(
                `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: false, error: "state unavailable" })}\n`,
            );
        });
        await assert.rejects(runChild(unverifiable, "task", undefined, undefined, true).done, /state unavailable/);
    });

    // A live model swap speaks set_model, and set_thinking_level only for an explicit level.
    it("speaks set_model and an explicit thinking level", async () => {
        const swapping = fakeChild();
        const spoken: any[] = [];
        swapping.stdin.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().trim().split("\n")) {
                if (!line) continue;
                const command = JSON.parse(line);
                spoken.push(command);
                swapping.stdout.write(
                    `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true })}\n`,
                );
            }
        });
        const swappingRun = runChild(swapping, "task", undefined);
        await swappingRun.swapModel("anthropic", "flash");
        await swappingRun.swapModel("google", "gemini", "high");
        assert.deepEqual(
            spoken
                .filter((command) => command.type !== "prompt")
                .map((command) => [command.type, command.provider ?? command.level, command.modelId]),
            [
                ["set_model", "anthropic", "flash"],
                ["set_model", "google", "gemini"],
                ["set_thinking_level", "high", undefined],
            ],
        );
    });

    // A rejected set_model must surface the child's error instead of passing silently.
    it("surfaces a rejected model swap", async () => {
        const refusing = fakeChild();
        refusing.stdin.on("data", (chunk: Buffer) => {
            const command = JSON.parse(chunk.toString());
            refusing.stdout.write(
                `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: command.type !== "set_model", error: command.type === "set_model" ? "Model not found: nope/x" : undefined })}\n`,
            );
        });
        const refusingRun = runChild(refusing, "task", undefined);
        await assert.rejects(refusingRun.swapModel("nope", "x"), /Model not found/);
    });

    // A set_thinking_level failure must not hide the already-applied swap: the ack callback still ran.
    it("keeps the applied swap when the level is rejected", async () => {
        const halfSwapped = fakeChild();
        let applied = false;
        halfSwapped.stdin.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().trim().split("\n")) {
                if (!line) continue;
                const command = JSON.parse(line);
                halfSwapped.stdout.write(
                    `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: command.type !== "set_thinking_level", error: command.type === "set_thinking_level" ? "level rejected" : undefined })}\n`,
                );
            }
        });
        const halfRun = runChild(halfSwapped, "task", undefined);
        await assert.rejects(
            halfRun.swapModel("anthropic", "flash", "high", () => (applied = true)),
            /level rejected/,
        );
        assert.equal(applied, true);
    });

    it("fails a run aborted before it starts", async () => {
        const signal = new AbortController();
        signal.abort();
        const cancelled = fakeChild();
        await assert.rejects(runChild(cancelled, "task", signal.signal).done, /aborted/);
        assert.equal(cancelled.stdin.writableEnded, true);
    });

    it("sends abort to a running child", async () => {
        const controller = new AbortController();
        const stopping = fakeChild();
        let abortRequested = false;
        stopping.stdin.on("data", (chunk: Buffer) => {
            const command = JSON.parse(chunk.toString());
            if (command.type === "prompt") {
                stopping.stdout.write(
                    `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n`,
                );
            } else if (command.type === "abort") {
                abortRequested = true;
                stopping.stdout.write(
                    `${JSON.stringify({ type: "response", id: command.id, command: "abort", success: true })}\n`,
                );
                stopping.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
            }
        });
        const active = runChild(stopping, "task", controller.signal);
        controller.abort();
        await assert.rejects(active.done, /aborted/);
        assert.equal(abortRequested, true);
        assert.equal(stopping.stdin.writableEnded, true);
    });

    // A run aborted by the child itself (an extension's abort or compaction) must not report as done.
    it("fails a run the child aborted itself", async () => {
        const selfAborted = fakeChild();
        selfAborted.stdin.on("data", (chunk: Buffer) => {
            const command = JSON.parse(chunk.toString());
            if (command.type !== "prompt") return;
            selfAborted.stdout.write(
                `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n`,
            );
            selfAborted.stdout.write(
                `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "half done" } })}\n`,
            );
            selfAborted.stdout.write(`${JSON.stringify({ type: "agent_settled", aborted: true })}\n`);
        });
        await assert.rejects(runChild(selfAborted, "task", undefined).done, /aborted before it finished/);
        assert.equal(selfAborted.stdin.writableEnded, true);
    });
});

describe("sessionMessages", () => {
    // A job without in-memory messages reads its transcript from the child's persisted session.
    it("seeds messages from the persisted session", () => {
        writeFileSync(
            join(seedDir, "2026-01-01T00-00-00-000Z_delegate-seed1.jsonl"),
            [
                JSON.stringify({
                    type: "session",
                    version: 3,
                    id: "delegate-seed1",
                    timestamp: "2026-01-01T00:00:00.000Z",
                    cwd: "/tmp",
                }),
                JSON.stringify({
                    type: "message",
                    id: "m1",
                    parentId: null,
                    timestamp: "2026-01-01T00:00:01.000Z",
                    message: { role: "user", content: "trace it", timestamp: 1 },
                }),
                JSON.stringify({
                    type: "message",
                    id: "m2",
                    parentId: "m1",
                    timestamp: "2026-01-01T00:00:02.000Z",
                    message: {
                        role: "assistant",
                        content: [
                            { type: "text", text: "Reading files." },
                            { type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts" } },
                        ],
                        timestamp: 2,
                    },
                }),
                JSON.stringify({
                    type: "message",
                    id: "m3",
                    parentId: "m2",
                    timestamp: "2026-01-01T00:00:03.000Z",
                    message: {
                        role: "toolResult",
                        toolCallId: "t1",
                        toolName: "read",
                        content: [{ type: "text", text: "const a = 1;" }],
                        isError: false,
                        timestamp: 3,
                    },
                }),
                "{not json",
            ].join("\n") + "\n",
        );
        const seeded: any[] = sessionMessages(seedDir, "seed1");
        assert.deepEqual(
            seeded.map((message: any) => message.role),
            ["user", "assistant", "toolResult"],
        );
        assert.equal(seeded[0].content, "trace it");
        assert.equal(seeded[1].content[1].name, "read");
        assert.equal(seeded[2].content[0].text, "const a = 1;");
    });

    it("seeds nothing for an unknown session id or a missing directory", () => {
        assert.deepEqual(sessionMessages(seedDir, "nope"), [], "unknown session id must seed nothing");
        assert.deepEqual(
            sessionMessages(join(seedDir, "missing"), "seed1"),
            [],
            "missing session dir must seed nothing",
        );
    });
});

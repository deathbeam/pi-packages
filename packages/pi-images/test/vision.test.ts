import assert from "node:assert/strict";
import { afterAll, beforeEach, describe, it } from "vitest";
import { cleanupTempDirs, tempDir, writeSettings } from "./helpers.ts";
import index from "../index.ts";

const project = tempDir("pi-images-project-");
const handlers: Record<string, any> = {};
const tools: Record<string, any> = {};
const notifications: { message: string; type?: string }[] = [];
const described: { model: any; context: any }[] = [];

index({
    on: (event: string, handler: unknown) => (handlers[event] = handler),
    registerTool: (tool: any) => (tools[tool.name] = tool),
} as any);
const context = handlers.context;

function image(data: string) {
    return { type: "image", data, mimeType: "image/png" };
}

// The read tool's "will be omitted" note is what the handoff strips once a description replaces the image.
const omittedNote = "[Current model does not support images. The image will be omitted from this request.]";

function transcript(data = "aGk=") {
    return [
        { role: "system", content: "sys" },
        { role: "user", content: "plain text" },
        { role: "user", content: [{ type: "text", text: "see" }, image(data)] },
        {
            role: "toolResult",
            content: [{ type: "text", text: `Read image file [image/png]\n${omittedNote}` }, image(data)],
        },
    ];
}

type VisionOptions = {
    input?: string[];
    find?: (provider: string, id: string) => any;
    reply?: (model: any, request: any) => Promise<any>;
};

function visionCtx({ input = ["text"], find, reply }: VisionOptions = {}) {
    return {
        cwd: project,
        model: { id: "current", input },
        signal: undefined,
        ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
        modelRegistry: {
            find: find ?? ((provider: string, id: string) => ({ provider, id, input: ["text", "image"] })),
            // The extension streams simply so that a virtual model such as combo/cheap gets routed.
            streamSimple: (model: any, request: any) => ({
                result: async () =>
                    (
                        reply ??
                        (async (answered: any, asked: any) => {
                            described.push({ model: answered, context: asked });
                            return { content: [{ type: "text", text: `desc-${asked.messages[0].content[0].data}` }] };
                        })
                    )(model, request),
            }),
        },
    };
}

function blindVision() {
    return visionCtx({ find: (provider, id) => ({ provider, id, input: ["text"] }) });
}

function failingVision() {
    return visionCtx({
        reply: async () => {
            throw new Error("boom");
        },
    });
}

beforeEach(() => {
    notifications.length = 0;
    described.length = 0;
});

afterAll(cleanupTempDirs);

describe("registration", () => {
    it("registers the context hook and the image_generate tool", () => {
        assert.equal(typeof context, "function");
        assert.equal(typeof tools.image_generate.execute, "function");
    });
});

// Tests use distinct image data because the description cache is process-wide and cannot be reset.
describe("vision handoff", () => {
    it("passes messages through untouched for a vision-capable model", async () => {
        writeSettings(project, { vision: "anthropic/v" });
        assert.equal(
            await context({ messages: transcript("dmlzaW9u") }, visionCtx({ input: ["text", "image"] })),
            undefined,
        );
        assert.equal(described.length, 0);
    });

    it("replaces every image block with its description", async () => {
        writeSettings(project, { vision: "anthropic/v" });
        const replaced = await context({ messages: transcript("aGk=") }, visionCtx());
        assert.deepEqual(replaced, {
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: "plain text" },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "see" },
                        { type: "text", text: "[Image description: desc-aGk=]" },
                    ],
                },
                {
                    role: "toolResult",
                    content: [
                        { type: "text", text: "Read image file [image/png]" },
                        { type: "text", text: "[Image description: desc-aGk=]" },
                    ],
                },
            ],
        });
        // Both blocks share the same image data: one vision call.
        assert.equal(described.length, 1);
        assert.deepEqual(described[0].model, { provider: "anthropic", id: "v", input: ["text", "image"] });
        assert.ok(described[0].context.systemPrompt.includes("exhaustively"));
        assert.deepEqual(described[0].context.messages[0].content, [image("aGk=")]);
    });

    it("describes each image only once", async () => {
        writeSettings(project, { vision: "anthropic/v" });
        const cached = () => transcript("Y2FjaGU=");
        const first = await context({ messages: cached() }, visionCtx());
        const second = await context({ messages: cached() }, visionCtx());
        assert.equal(described.length, 1);
        assert.deepEqual(second, first);
    });

    it("warns and leaves images alone for an unresolvable vision model", async () => {
        writeSettings(project, { vision: "unknown/m" });
        const find = () => undefined;
        assert.equal(await context({ messages: transcript("dW5rbm93bg==") }, visionCtx({ find })), undefined);
        assert.deepEqual(notifications, [
            {
                message: 'images.vision "unknown/m" does not resolve to a known model; images pass through undescribed',
                type: "warning",
            },
        ]);
    });

    it("does not warn when the transcript has no images", async () => {
        writeSettings(project, { vision: "unknown/m" });
        const find = () => undefined;
        assert.equal(
            await context({ messages: [{ role: "user", content: "text only" }] }, visionCtx({ find })),
            undefined,
        );
        assert.deepEqual(notifications, []);
    });

    it("warns once and passes images through when the vision model cannot see images", async () => {
        writeSettings(project, { vision: "anthropic/blind" });
        assert.equal(await context({ messages: transcript("YmxpbmQ=") }, blindVision()), undefined);
        assert.deepEqual(notifications, [
            {
                message: 'images.vision "anthropic/blind" cannot see images; images pass through undescribed',
                type: "warning",
            },
        ]);
        await context({ messages: transcript("YmxpbmQ=") }, blindVision());
        assert.equal(notifications.length, 1);
    });

    it("warns again after a new session starts", async () => {
        writeSettings(project, { vision: "anthropic/blind" });
        handlers.session_start({}, visionCtx());
        await context({ messages: transcript("c2Vzc2lvbg==") }, blindVision());
        assert.equal(notifications.length, 1);
        handlers.session_start({}, visionCtx());
        await context({ messages: transcript("c2Vzc2lvbg==") }, blindVision());
        assert.equal(notifications.length, 2);
    });

    it("reports a failed description and retries it on the next request", async () => {
        writeSettings(project, { vision: "anthropic/v" });
        const messages = [{ role: "user", content: [image("ZmFpbA==")] }];
        const failed = await context({ messages }, failingVision());
        assert.deepEqual(failed.messages[0].content, [{ type: "text", text: "[Image description: unavailable]" }]);
        assert.deepEqual(notifications, [
            { message: "Describing an image with anthropic/v failed: boom", type: "error" },
        ]);
        await context({ messages }, failingVision());
        assert.equal(notifications.length, 2);
    });

    it("describes the images of a request in parallel", async () => {
        writeSettings(project, { vision: "anthropic/v" });
        const started: string[] = [];
        let release = () => {};
        const blocked = new Promise<void>((resolve) => (release = resolve));
        const ctx = visionCtx({
            reply: async (_model, request) => {
                const data = request.messages[0].content[0].data;
                started.push(data);
                await blocked;
                return { content: [{ type: "text", text: `desc-${data}` }] };
            },
        });
        const messages = [
            { role: "user", content: [image("cGFyMQ==")] },
            { role: "user", content: [image("cGFyMg==")] },
        ];
        const pending = context({ messages }, ctx);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(started.sort(), ["cGFyMQ==", "cGFyMg=="]);
        release();
        const describedMessages = (await pending).messages.map((message: any) => message.content[0].text);
        assert.deepEqual(describedMessages, [
            "[Image description: desc-cGFyMQ==]",
            "[Image description: desc-cGFyMg==]",
        ]);
    });

    it("reports an empty description as a failure", async () => {
        writeSettings(project, { vision: "anthropic/v" });
        const emptyVision = visionCtx({ reply: async () => ({ content: [{ type: "text", text: "   " }] }) });
        const result = await context({ messages: [{ role: "user", content: [image("ZW1wdHk=")] }] }, emptyVision);
        assert.deepEqual(result.messages[0].content, [{ type: "text", text: "[Image description: unavailable]" }]);
        assert.deepEqual(notifications, [
            {
                message: "Describing an image with anthropic/v failed: the vision model returned no description",
                type: "error",
            },
        ]);
    });
});

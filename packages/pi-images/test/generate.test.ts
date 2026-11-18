import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, it } from "vitest";
import { cleanupTempDirs, tempDir, writeSettings } from "./helpers.ts";
import index from "../index.ts";
import { saveImages } from "../src/generate.ts";

const project = tempDir("pi-images-project-");
const tools: Record<string, any> = {};
const realFetch = globalThis.fetch;
let requests: { url: string; init: any }[] = [];

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngB64 = png.toString("base64");

const openaiModel = {
    provider: "inferhub",
    id: "glm",
    api: "openai-completions",
    baseUrl: "https://api.inferhub.dev/v1",
};
const googleModel = {
    provider: "google",
    id: "gemini-3.5-flash",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
};
const openrouterModel = {
    provider: "openrouter",
    id: "anthropic/claude-haiku-4.5",
    api: "anthropic-messages",
    baseUrl: "https://openrouter.ai/api",
};

const openaiSettings = { generate: "inferhub/cb/gemini-3.0-pro-image", outputDir: "out" };
const googleSettings = { generate: "google/gemini-3.0-pro-image", outputDir: "out" };
const openrouterSettings = { generate: "openrouter/google/gemini-2.5-flash-image", outputDir: "out" };

function modelRegistry(model: any, headers: Record<string, string> = {}) {
    return {
        getAll: () => [model],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers }),
        getRegisteredProviderConfig: () => undefined,
    };
}

function context(model: any = openaiModel, registry: any = modelRegistry(model)) {
    return { cwd: project, ui: { notify: () => {} }, modelRegistry: registry };
}

/** Stubs fetch with a queue of responses; a function is called and its Response returned as-is. */
function stubFetch(...responses: any[]) {
    requests = [];
    globalThis.fetch = (async (url: string, init: any) => {
        requests.push({ url: String(url), init });
        const response = responses.shift();
        if (typeof response === "function") return response();
        return new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as any;
}

async function generate(params: any, responses: any[] = [], ctx: any = context(), signal?: AbortSignal) {
    stubFetch(...responses);
    return tools.image_generate.execute("tool-1", params, signal, undefined, ctx);
}

function lastRequest() {
    return requests.at(-1)!;
}

index({ on: () => {}, registerTool: (tool: any) => (tools[tool.name] = tool) } as any);

beforeEach(() => writeSettings(project, openaiSettings));

afterEach(() => {
    globalThis.fetch = realFetch;
});

afterAll(cleanupTempDirs);

describe("image_generate", () => {
    it("sends the configured model, prompt, size and headers", async () => {
        const ctx = context(openaiModel, modelRegistry(openaiModel, { "x-extra": "yes" }));
        const result = await generate({ prompt: "a cat", size: "1024x1024" }, [{ data: [{ b64_json: pngB64 }] }], ctx);
        assert.equal(lastRequest().url, "https://api.inferhub.dev/v1/images/generations");
        assert.equal(lastRequest().init.headers.Authorization, "Bearer secret");
        assert.equal(lastRequest().init.headers["x-extra"], "yes");
        assert.deepEqual(JSON.parse(lastRequest().init.body), {
            model: "cb/gemini-3.0-pro-image",
            prompt: "a cat",
            n: 1,
            size: "1024x1024",
        });
        const saved = result.details.paths[0];
        assert.match(saved, /^out\/image-\d+-1\.png$/);
        assert.deepEqual(readFileSync(join(project, saved)), png);
        assert.deepEqual(result.content, [
            { type: "text", text: `![generated image](${saved})` },
            { type: "image", data: pngB64, mimeType: "image/png" },
        ]);
    });

    it("prefers the registered provider config over the provider's first model", async () => {
        const registry = {
            getAll: () => [
                { provider: "inferhub", id: "ag", api: "anthropic-messages", baseUrl: "https://api.inferhub.dev" },
            ],
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers: {} }),
            getRegisteredProviderConfig: () => ({ api: "openai-completions", baseUrl: "https://api.inferhub.dev/v1" }),
        };
        await generate({ prompt: "a cat" }, [{ data: [{ b64_json: pngB64 }] }], context(openaiModel, registry));
        assert.equal(lastRequest().url, "https://api.inferhub.dev/v1/images/generations");
        assert.equal(JSON.parse(lastRequest().init.body).model, "cb/gemini-3.0-pro-image");
    });

    it("downloads a URL result and keeps the response content type", async () => {
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
        const result = await generate({ prompt: "a cat" }, [
            { data: [{ url: "https://cdn.example/img" }] },
            () => new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }),
        ]);
        assert.equal(lastRequest().url, "https://cdn.example/img");
        assert.match(result.details.paths[0], /^out\/image-\d+-1\.jpg$/);
        assert.deepEqual(readFileSync(join(project, result.details.paths[0])), jpeg);
    });

    it("posts input images to the edits endpoint as multipart fields", async () => {
        writeFileSync(join(project, "in.png"), png);
        await generate({ prompt: "make it red", image: ["in.png"] }, [{ data: [{ b64_json: pngB64 }] }]);
        const body = lastRequest().init.body;
        assert.equal(lastRequest().url, "https://api.inferhub.dev/v1/images/edits");
        assert.ok(body instanceof FormData);
        assert.equal(body.get("model"), "cb/gemini-3.0-pro-image");
        assert.equal(body.get("prompt"), "make it red");
        const uploaded = body.get("image");
        assert.ok(uploaded instanceof File);
        assert.equal(uploaded.size, png.length);
    });

    it("forwards the abort signal to the provider", async () => {
        const controller = new AbortController();
        await generate({ prompt: "a cat" }, [{ data: [{ b64_json: pngB64 }] }], context(), controller.signal);
        assert.equal(lastRequest().init.signal, controller.signal);
    });

    it("propagates provider error bodies", async () => {
        await assert.rejects(
            generate({ prompt: "x" }, [() => new Response('{"error":"bad model"}', { status: 400 })]),
            /400.*bad model/s,
        );
    });

    it("surfaces provider auth failures", async () => {
        const registry = {
            getAll: () => [openaiModel],
            getApiKeyAndHeaders: async () => ({ ok: false, error: "no credential for inferhub" }),
            getRegisteredProviderConfig: () => undefined,
        };
        await assert.rejects(generate({ prompt: "x" }, [], context(openaiModel, registry)), /no credential/);
    });

    it("fails for a provider pi does not know", async () => {
        await assert.rejects(
            generate({ prompt: "x" }, [], context({ provider: "other", id: "m", api: "a", baseUrl: "b" })),
            /not known to pi/,
        );
    });

    it("asks for images.generate when it is unset", async () => {
        writeSettings(project, {});
        await assert.rejects(generate({ prompt: "x" }), /images\.generate/);
    });

    it("fills the Google generateContent request with x-goog-api-key", async () => {
        writeSettings(project, googleSettings);
        writeFileSync(join(project, "in.png"), png);
        await generate(
            { prompt: "a cat", image: ["in.png"] },
            [{ candidates: [{ content: { parts: [{ inlineData: { data: pngB64, mimeType: "image/png" } }] } }] }],
            context(googleModel),
        );
        assert.equal(
            lastRequest().url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-pro-image:generateContent",
        );
        assert.equal(lastRequest().init.headers["x-goog-api-key"], "secret");
        assert.equal(lastRequest().init.headers.Authorization, undefined);
        assert.deepEqual(JSON.parse(lastRequest().init.body), {
            contents: [
                {
                    role: "user",
                    parts: [{ inline_data: { mime_type: "image/png", data: pngB64 } }, { text: "a cat" }],
                },
            ],
            generationConfig: { responseModalities: ["IMAGE"] },
        });
    });

    it("reads Google's snake_case inline_data response", async () => {
        writeSettings(project, googleSettings);
        const result = await generate(
            { prompt: "a cat" },
            [{ candidates: [{ content: { parts: [{ inline_data: { data: pngB64, mime_type: "image/png" } }] } }] }],
            context(googleModel),
        );
        assert.deepEqual(result.content[1], { type: "image", data: pngB64, mimeType: "image/png" });
    });

    it("posts OpenRouter requests to chat completions with modalities", async () => {
        writeSettings(project, openrouterSettings);
        writeFileSync(join(project, "in.png"), png);
        await generate(
            { prompt: "a cat", image: ["in.png"] },
            [{ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${pngB64}` } }] } }] }],
            context(openrouterModel),
        );
        assert.equal(lastRequest().url, "https://openrouter.ai/api/v1/chat/completions");
        assert.equal(lastRequest().init.headers.Authorization, "Bearer secret");
        assert.deepEqual(JSON.parse(lastRequest().init.body), {
            model: "google/gemini-2.5-flash-image",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "image_url", image_url: { url: `data:image/png;base64,${pngB64}` } },
                        { type: "text", text: "a cat" },
                    ],
                },
            ],
            modalities: ["image", "text"],
        });
    });

    it("fails when the provider returns no image data", async () => {
        await assert.rejects(generate({ prompt: "x" }, [{ data: [] }]), /no images/);
        writeSettings(project, googleSettings);
        await assert.rejects(generate({ prompt: "x" }, [{ candidates: [] }], context(googleModel)), /no image data/);
    });

    it('drops null and "null" optional params', async () => {
        await generate({ prompt: "a cat", image: null, size: null }, [{ data: [{ b64_json: pngB64 }] }]);
        assert.deepEqual(JSON.parse(lastRequest().init.body), {
            model: "cb/gemini-3.0-pro-image",
            prompt: "a cat",
            n: 1,
        });
        await generate({ prompt: "a cat", image: "null", size: "null" }, [{ data: [{ b64_json: pngB64 }] }]);
        assert.deepEqual(JSON.parse(lastRequest().init.body), {
            model: "cb/gemini-3.0-pro-image",
            prompt: "a cat",
            n: 1,
        });
    });
});

describe("input image trust boundary", () => {
    it("refuses paths outside the working directory", async () => {
        const outside = join(tmpdir(), `pi-images-outside-${Date.now()}.png`);
        writeFileSync(outside, png);
        await assert.rejects(generate({ prompt: "x", image: [outside] }), /inside the working directory/);
        rmSync(outside);
    });

    it("refuses missing and non-image files", async () => {
        await assert.rejects(generate({ prompt: "x", image: ["missing.png"] }), /not found/);
        writeFileSync(join(project, "notes.txt"), "text");
        await assert.rejects(generate({ prompt: "x", image: ["notes.txt"] }), /must be a png/);
    });

    it("refuses images over 20 MB before reading them", async () => {
        writeFileSync(join(project, "big.png"), Buffer.alloc(20 * 1024 * 1024 + 1));
        await assert.rejects(generate({ prompt: "x", image: ["big.png"] }), /larger than 20 MB/);
    });
});

describe("saveImages", () => {
    it("uses the default output dir and unique file names", () => {
        const saved = saveImages(project, ".pi/images", [
            { data: pngB64, mimeType: "image/png" },
            { data: pngB64, mimeType: "image/jpeg" },
        ]);
        assert.equal(saved.length, 2);
        assert.notEqual(saved[0], saved[1]);
        assert.match(saved[0], /^\.pi\/images\/image-\d+-1\.png$/);
        assert.match(saved[1], /^\.pi\/images\/image-\d+-2\.jpg$/);
    });
});

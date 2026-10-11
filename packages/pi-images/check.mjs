// Run: node check.mjs (Node >=22.19 supports TypeScript type stripping).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";

// An isolated HOME keeps the global-settings half of the merge deterministic.
const home = mkdtempSync(join(tmpdir(), "pi-images-home-"));
process.env.HOME = home;

const { default: extension, mergeImagesSettings, readImagesSettings } = await import("./index.ts");
const { splitModel, readInputImage, saveImages } = await import("./generate.ts");

// Model strings split at the FIRST "/", so ids may themselves contain slashes.
assert.deepEqual(splitModel("inferhub/cb/gemini-3.0-pro-image"), {
    provider: "inferhub",
    id: "cb/gemini-3.0-pro-image",
});
assert.deepEqual(splitModel("anthropic/claude-haiku-4-5"), { provider: "anthropic", id: "claude-haiku-4-5" });
assert.throws(() => splitModel("no-provider"), /must be/);
assert.throws(() => splitModel("/leading"), /must be/);
assert.throws(() => splitModel("trailing/"), /must be/);

// Project settings override global ones; non-string values never leak through.
assert.deepEqual(mergeImagesSettings({ vision: "a/b", outputDir: "g" }, { vision: "c/d" }), {
    vision: "c/d",
    outputDir: "g",
});
assert.deepEqual(mergeImagesSettings({ generate: "x/y" }, {}), { generate: "x/y" });

const project = mkdtempSync(join(tmpdir(), "pi-images-project-"));
const projectSettings = (images) => {
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ images }));
    return readImagesSettings(project);
};
assert.deepEqual(projectSettings({ vision: "anthropic/v", generate: "inferhub/g", outputDir: "out" }), {
    vision: "anthropic/v",
    generate: "inferhub/g",
    outputDir: "out",
});
assert.deepEqual(projectSettings({ vision: 1, generate: null, outputDir: "" }), {});
assert.deepEqual(projectSettings({}), {});

// ---------------------------------------------------------------------------
// Vision handoff: image blocks in LLM-bound messages become text descriptions.
const handlers = {};
const tools = {};
extension({
    on: (event, handler) => (handlers[event] = handler),
    registerTool: (tool) => (tools[tool.name] = tool),
});
assert.equal(typeof handlers.context, "function");
assert.equal(typeof tools.image_generate.execute, "function");

const notifications = [];
const described = [];
const visionCtx = (input) => ({
    cwd: project,
    model: { id: "m", input },
    signal: undefined,
    ui: { notify: (message, type) => notifications.push({ message, type }) },
    modelRegistry: {
        find: (provider, id) => (provider === "anthropic" ? { provider, id, input: ["text", "image"] } : undefined),
        complete: async (model, context) => {
            described.push({ model, context });
            return { content: [{ type: "text", text: `desc-${context.messages[0].content[0].data}` }] };
        },
    },
});

const image = (data) => ({ type: "image", data, mimeType: "image/png" });
const visionMessages = () => [
    { role: "system", content: "sys" },
    { role: "user", content: "plain text" },
    { role: "user", content: [{ type: "text", text: "see" }, image("aGk=")] },
    {
        role: "toolResult",
        content: [
            {
                type: "text",
                text: `Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]`,
            },
            image("aGk="),
        ],
    },
];

// A vision-capable model needs no handoff.
assert.equal(await handlers.context({ messages: visionMessages() }, visionCtx(["text", "image"])), undefined);
assert.equal(described.length, 0);

projectSettings({ vision: "anthropic/v" });
const replaced = await handlers.context({ messages: visionMessages() }, visionCtx(["text"]));
// Untouched messages keep their identity; only image-bearing messages are rebuilt.
assert.equal(replaced.messages[0].role, "system");
assert.equal(replaced.messages[1].content, "plain text");
assert.equal(replaced.messages[2].content[0].text, "see");
assert.equal(replaced.messages[2].content[1].type, "text");
assert.equal(replaced.messages[2].content[1].text, "[Image description: desc-aGk=]");
// The read tool's "will be omitted" note is now wrong, so it is stripped.
assert.equal(replaced.messages[3].content[0].text, "Read image file [image/png]");
assert.equal(replaced.messages[3].content[1].text, "[Image description: desc-aGk=]");
// Both blocks share the same image data: one vision call, and the description is cached across requests.
assert.equal(described.length, 1);
assert.equal(described[0].model.id, "v");
assert.ok(described[0].context.systemPrompt.includes("exhaustively"));
assert.equal(described[0].context.messages[0].content[0].type, "image");
await handlers.context({ messages: visionMessages() }, visionCtx(["text"]));
assert.equal(described.length, 1);

// An unresolvable vision model warns and leaves the images alone.
described.length = 0;
notifications.length = 0;
projectSettings({ vision: "unknown/m" });
const untouched = await handlers.context({ messages: visionMessages() }, visionCtx(["text"]));
assert.equal(untouched, undefined);
assert.equal(described.length, 0);
assert.equal(notifications.length, 1);
assert.match(notifications[0].message, /does not resolve/);
// Without images in the transcript there is nothing to warn about.
notifications.length = 0;
await handlers.context({ messages: [{ role: "user", content: "text only" }] }, visionCtx(["text"]));
assert.equal(notifications.length, 0);

// A vision model without image input warns once and passes images through.
const blindCtx = (input) => ({
    cwd: project,
    model: { id: "m", input: ["text"] },
    signal: undefined,
    ui: { notify: (message, type) => notifications.push({ message, type }) },
    modelRegistry: {
        find: (provider, id) => (provider === "anthropic" ? { provider, id, input } : undefined),
        complete: async () => {
            throw new Error("unused");
        },
    },
});
projectSettings({ vision: "anthropic/blind" });
assert.equal(await handlers.context({ messages: visionMessages() }, blindCtx(["text"])), undefined);
assert.equal(notifications.length, 1);
assert.match(notifications[0].message, /cannot see images/);
await handlers.context({ messages: visionMessages() }, blindCtx(["text"]));
assert.equal(notifications.length, 1);

// A failing vision model is reported once; the failure is cached for the process.
notifications.length = 0;
projectSettings({ vision: "anthropic/v" });
const failingCtx = {
    cwd: project,
    model: { id: "m", input: ["text"] },
    signal: undefined,
    ui: { notify: (message, type) => notifications.push({ message, type }) },
    modelRegistry: {
        find: (provider, id) => ({ provider, id, input: ["text", "image"] }),
        complete: async () => {
            throw new Error("boom");
        },
    },
};
const failingMessages = [{ role: "user", content: [image("ZmFpbA==")] }];
const failed1 = await handlers.context({ messages: failingMessages }, failingCtx);
assert.equal(failed1.messages[0].content[0].text, "[Image description: unavailable]");
assert.equal(notifications.length, 1);
assert.match(notifications[0].message, /boom/);
await handlers.context({ messages: failingMessages }, failingCtx);
assert.equal(notifications.length, 1);

// ---------------------------------------------------------------------------
// Image generation: per-API requests and responses, with stubbed fetch.
const realFetch = globalThis.fetch;
const calls = [];
const stubFetch = (...responses) => {
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        const response = responses.shift();
        if (typeof response === "function") return response(url, init);
        return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    };
};
const lastCall = () => calls.at(-1);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngB64 = png.toString("base64");
const registry = (model) => ({
    getAll: () => [model],
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers: { "x-extra": "yes" } }),
    getRegisteredProviderConfig: () => undefined,
});
const runTool = async (cwd, params, model, ...responses) => {
    stubFetch(...responses);
    return tools.image_generate.execute("1", params, undefined, undefined, {
        cwd,
        ui: { notify: (message) => notifications.push({ message }) },
        modelRegistry: registry(model),
    });
};
try {
    // Settings from the project file select the model and output dir.
    projectSettings({ generate: "inferhub/cb/gemini-3.0-pro-image", outputDir: "out" });
    const result = await runTool(
        project,
        { prompt: "a cat", size: "1024x1024" },
        { provider: "inferhub", id: "glm", api: "openai-completions", baseUrl: "https://api.inferhub.dev/v1" },
        { data: [{ b64_json: pngB64 }] },
    );
    assert.equal(lastCall().url, "https://api.inferhub.dev/v1/images/generations");
    assert.equal(lastCall().init.headers.Authorization, "Bearer secret");
    assert.equal(lastCall().init.headers["x-extra"], "yes");
    assert.deepEqual(JSON.parse(lastCall().init.body), {
        model: "cb/gemini-3.0-pro-image",
        prompt: "a cat",
        n: 1,
        size: "1024x1024",
    });
    const saved = result.details.paths[0];
    assert.match(saved, /^out\/image-\d+-1\.png$/);
    assert.deepEqual(readFileSync(join(project, saved)), png);
    assert.equal(result.content[0].text, `![generated image](${saved})`);
    assert.deepEqual(result.content[1], { type: "image", data: pngB64, mimeType: "image/png" });

    // Custom renderers: a compact call line, one line per saved image, errors in the error color.
    const colors = [];
    const theme = {
        fg: (color, text) => {
            colors.push([color, text]);
            return text;
        },
        bold: (text) => text,
    };
    const longPrompt = "START " + "a very detailed prompt ".repeat(60) + "END";
    const callCtx = { expanded: false, cwd: project };
    const collapsedRows = tools.image_generate
        .renderCall({ prompt: longPrompt }, theme, callCtx)
        .render(40)
        .map(stripVTControlCharacters);
    assert.match(collapsedRows[0], /^image_generate inferhub/);
    assert.ok(
        collapsedRows.every((row) => visibleWidth(row) <= 40),
        "collapsed call overflows the width",
    );
    assert.match(collapsedRows.join("\n"), /START/);
    assert.doesNotMatch(collapsedRows.join("\n"), /END/, "collapsed prompt must be truncated");
    assert.ok(
        tools.image_generate
            .renderCall({ prompt: longPrompt }, theme, { ...callCtx, expanded: true })
            .render(80)
            .join("\n")
            .includes("END"),
        "expanded call must show the full prompt",
    );
    colors.length = 0;
    const rendered = tools.image_generate
        .renderResult(result, { isPartial: false }, theme, { isError: false, cwd: project })
        .render(80);
    assert.ok(rendered.join("\n").includes(saved), "result must list the saved path");
    assert.ok(colors.some(([color, text]) => color === "toolOutput" && text.includes(saved)));
    colors.length = 0;
    tools.image_generate.renderResult(
        { content: [{ type: "text", text: "Specific failure" }], details: undefined },
        { isPartial: false },
        theme,
        { isError: true, cwd: project },
    );
    assert.ok(colors.some(([color, text]) => color === "error" && text.includes("Specific failure")));
    assert.ok(
        tools.image_generate
            .renderResult({ content: [], details: undefined }, { isPartial: true }, theme, {
                isError: false,
                cwd: project,
            })
            .render(80)
            .join("\n")
            .includes("generating…"),
        "partial result must show the generating line",
    );

    // The provider's first model may carry a divergent baseUrl/api; the registered provider config wins.
    projectSettings({ generate: "inferhub/cb/gemini-3.0-pro-image", outputDir: "out" });
    stubFetch({ data: [{ b64_json: pngB64 }] });
    await tools.image_generate.execute("1", { prompt: "a cat" }, undefined, undefined, {
        cwd: project,
        ui: { notify: () => {} },
        modelRegistry: {
            getAll: () => [
                { provider: "inferhub", id: "ag", api: "anthropic-messages", baseUrl: "https://api.inferhub.dev" },
            ],
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers: {} }),
            getRegisteredProviderConfig: () => ({ api: "openai-completions", baseUrl: "https://api.inferhub.dev/v1" }),
        },
    });
    assert.equal(lastCall().url, "https://api.inferhub.dev/v1/images/generations");
    assert.equal(JSON.parse(lastCall().init.body).model, "cb/gemini-3.0-pro-image");

    // A hosted result URL is downloaded with the response's content type.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const jpegB64 = jpeg.toString("base64");
    const urlResult = await runTool(
        project,
        { prompt: "a cat" },
        { provider: "inferhub", id: "glm", api: "openai-completions", baseUrl: "https://api.inferhub.dev/v1" },
        { data: [{ url: "https://cdn.example/img" }] },
        () => new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    assert.equal(lastCall().url, "https://cdn.example/img");
    assert.match(urlResult.details.paths[0], /^out\/image-\d+-1\.jpg$/);
    assert.deepEqual(readFileSync(join(project, urlResult.details.paths[0])), jpeg);

    // Input images switch to the edits endpoint as multipart form fields.
    writeFileSync(join(project, "in.png"), png);
    const edit = await runTool(
        project,
        { prompt: "make it red", image: ["in.png"] },
        { provider: "inferhub", id: "glm", api: "openai-completions", baseUrl: "https://api.inferhub.dev/v1" },
        { data: [{ b64_json: pngB64 }] },
    );
    assert.equal(lastCall().url, "https://api.inferhub.dev/v1/images/edits");
    assert.ok(lastCall().init.body instanceof FormData);
    assert.equal(lastCall().init.body.get("model"), "cb/gemini-3.0-pro-image");
    assert.equal(lastCall().init.body.get("prompt"), "make it red");
    assert.equal(lastCall().init.body.get("image").size, png.length);

    // Trust boundary: input paths must resolve inside the working directory.
    const outside = join(tmpdir(), `pi-images-outside-${Date.now()}.png`);
    writeFileSync(outside, png);
    await assert.rejects(
        runTool(
            project,
            { prompt: "x", image: [outside] },
            { provider: "inferhub", id: "g", api: "a", baseUrl: "b" },
            {},
        ),
        /inside the working directory/,
    );
    rmSync(outside);
    await assert.rejects(
        runTool(
            project,
            { prompt: "x", image: ["missing.png"] },
            { provider: "inferhub", id: "g", api: "a", baseUrl: "b" },
            {},
        ),
        /not found/,
    );
    writeFileSync(join(project, "notes.txt"), "text");
    await assert.rejects(
        runTool(
            project,
            { prompt: "x", image: ["notes.txt"] },
            { provider: "inferhub", id: "g", api: "a", baseUrl: "b" },
            { data: [] },
        ),
        /must be a png/,
    );

    // Input images over 20 MB are rejected before being read.
    writeFileSync(join(project, "big.png"), Buffer.alloc(20 * 1024 * 1024 + 1));
    await assert.rejects(
        runTool(
            project,
            { prompt: "x", image: ["big.png"] },
            { provider: "inferhub", id: "g", api: "a", baseUrl: "b" },
            {},
        ),
        /larger than 20 MB/,
    );

    // Unknown providers and missing settings fail clearly before any request.
    await assert.rejects(
        runTool(project, { prompt: "x" }, { provider: "other", id: "m", api: "a", baseUrl: "b" }, {}),
        /not known to pi/,
    );
    projectSettings({});
    await assert.rejects(
        runTool(project, { prompt: "x" }, { provider: "inferhub", id: "m", api: "a", baseUrl: "b" }, {}),
        /images\.generate/,
    );

    // HTTP error bodies propagate into the thrown error.
    projectSettings({ generate: "inferhub/g" });
    globalThis.fetch = async () => new Response('{"error":"bad model"}', { status: 400 });
    await assert.rejects(
        tools.image_generate.execute("1", { prompt: "x" }, undefined, undefined, {
            cwd: project,
            ui: { notify: () => {} },
            modelRegistry: registry({
                provider: "inferhub",
                id: "m",
                api: "openai-completions",
                baseUrl: "https://api.inferhub.dev/v1",
            }),
        }),
        /400.*bad model/s,
    );

    // Google dispatches to generateContent with x-goog-api-key and parses inlineData (and inline_data).
    projectSettings({ generate: "google/gemini-3.0-pro-image" });
    await runTool(
        project,
        { prompt: "a cat", image: ["in.png"] },
        {
            provider: "google",
            id: "gemini-3.5-flash",
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        },
        { candidates: [{ content: { parts: [{ inlineData: { data: pngB64, mimeType: "image/png" } }] } }] },
    );
    assert.equal(
        lastCall().url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-pro-image:generateContent",
    );
    assert.equal(lastCall().init.headers["x-goog-api-key"], "secret");
    assert.equal(lastCall().init.headers.Authorization, undefined);
    const googleBody = JSON.parse(lastCall().init.body);
    assert.deepEqual(googleBody.generationConfig, { responseModalities: ["IMAGE"] });
    assert.equal(googleBody.contents[0].parts[0].inline_data.mime_type, "image/png");
    assert.equal(googleBody.contents[0].parts[1].text, "a cat");
    await runTool(
        project,
        { prompt: "a cat" },
        {
            provider: "google",
            id: "gemini-3.5-flash",
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        },
        { candidates: [{ content: { parts: [{ inline_data: { data: pngB64, mime_type: "image/png" } }] } }] },
        // snake_case parsed too; a size hint is dropped, not mapped.
    );

    // OpenRouter dispatches by provider name (its catalog models carry anthropic APIs) to chat completions with modalities.
    projectSettings({ generate: "openrouter/google/gemini-2.5-flash-image" });
    await runTool(
        project,
        { prompt: "a cat", image: ["in.png"] },
        {
            provider: "openrouter",
            id: "anthropic/claude-haiku-4.5",
            api: "anthropic-messages",
            baseUrl: "https://openrouter.ai/api",
        },
        { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${pngB64}` } }] } }] },
    );
    assert.equal(lastCall().url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(lastCall().init.headers.Authorization, "Bearer secret");
    const routerBody = JSON.parse(lastCall().init.body);
    assert.equal(routerBody.model, "google/gemini-2.5-flash-image");
    assert.deepEqual(routerBody.modalities, ["image", "text"]);
    assert.equal(routerBody.messages[0].content[0].image_url.url, `data:image/png;base64,${pngB64}`);
    assert.equal(routerBody.messages[0].content[1].text, "a cat");

    // A generation with no image data is an error, whatever the API shape.
    projectSettings({ generate: "inferhub/g" });
    await assert.rejects(
        runTool(
            project,
            { prompt: "x" },
            { provider: "inferhub", id: "m", api: "openai-completions", baseUrl: "https://api.inferhub.dev/v1" },
            { data: [] },
        ),
        /no images/,
    );
    projectSettings({ generate: "google/g" });
    await assert.rejects(
        runTool(
            project,
            { prompt: "x" },
            {
                provider: "google",
                id: "g",
                api: "google-generative-ai",
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            },
            { candidates: [] },
        ),
        /no image data/,
    );

    // Strict models may inject literal "null" for omitted optional params; it must not disable the tool.
    projectSettings({ generate: "inferhub/g" });
    const nulled = await runTool(
        project,
        { prompt: "a cat", image: null, size: null },
        { provider: "inferhub", id: "m", api: "openai-completions", baseUrl: "https://api.inferhub.dev/v1" },
        { data: [{ b64_json: pngB64 }] },
    );
    assert.equal(nulled.details.paths.length, 1);

    // Direct unit checks: the output dir default and unique file names.
    const saved3 = saveImages(project, ".pi/images", [
        { data: pngB64, mimeType: "image/png" },
        { data: pngB64, mimeType: "image/jpeg" },
    ]);
    assert.equal(saved3.length, 2);
    assert.notEqual(saved3[0], saved3[1]);
    assert.match(saved3[0], /^\.pi\/images\/image-\d+-1\.png$/);
    assert.match(saved3[1], /^\.pi\/images\/image-\d+-2\.jpg$/);
} finally {
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
}

console.log("pi-images: all checks passed");

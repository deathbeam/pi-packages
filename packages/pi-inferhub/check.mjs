// Run: node check.mjs (Node >=22.19 supports TypeScript type stripping).
import assert from "node:assert/strict";
import extension from "./index.ts";

const realFetch = globalThis.fetch;
const calls = [];
const catalog = {
    data: [
        {
            id: "glm-5.3",
            owned_by: "zhipu",
            modality: "text+image",
            input_token_limit: 200000,
            max_output_tokens: 32000,
            reasoning_levels: ["low", "medium", "high"],
            upstream_label: "GLM 5.3",
            pricing: { min_ask_in: 0.3, min_ask_out: 1.2, official_in: 0.5, official_out: 2 },
        },
        {
            id: "zhipu/glm-5.3",
            owned_by: "zhipu",
            modality: "text",
            input_token_limit: 100000,
            max_output_tokens: 16000,
            reasoning_levels: ["medium", "high", "max"],
            pricing: { official_in: 0.2, official_out: 0.8 },
        },
        {
            id: "cc/claude-haiku-4-5",
            owned_by: "cc",
            modality: "text",
            input_token_limit: 200000,
            max_output_tokens: 32000,
        },
        { id: "cx/gpt-6.1-sol", owned_by: "cx", modality: "text", reasoning_levels: ["low", "medium", "high"] },
        { id: "alias/glm-5.3", owned_by: "alias" },
        { id: "plain", owned_by: "other", modality: "text" },
        { id: "image-out", output_modality: "image" },
        { owned_by: "no-id" },
    ],
};
const stub = (body, status = 200) =>
    (globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
    });
const noPublish = () => assert.fail("refresh must not publish without a network fetch");

let configured;
const install = () => extension({ registerProvider: (name, config) => (configured = { name, config }) });

process.env.INFERHUB_API_KEY = "startup-key";
try {
    stub(catalog);
    await install();

    const { config } = configured;
    assert.equal(configured.name, "inferhub");
    assert.equal(config.name, "InferHub");
    assert.equal(config.baseUrl, "https://api.inferhub.dev/v1");
    assert.equal(config.apiKey, "$INFERHUB_API_KEY");
    assert.equal(config.api, "openai-completions");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.inferhub.dev/v1/models");
    assert.equal(calls[0].init.headers.Authorization, "Bearer startup-key");

    const models = Object.fromEntries(config.models.map((model) => [model.id, model]));
    assert.deepEqual(Object.keys(models), [
        "glm-5.3",
        "zhipu/glm-5.3",
        "cc/claude-haiku-4-5",
        "cx/gpt-6.1-sol",
        "alias/glm-5.3",
        "plain",
    ]);

    // Claude and GPT models ride their native APIs; everything else inherits the provider default.
    assert.equal(models["cc/claude-haiku-4-5"].api, "anthropic-messages");
    assert.equal(models["cc/claude-haiku-4-5"].baseUrl, "https://api.inferhub.dev");
    assert.equal(models["cx/gpt-6.1-sol"].api, "openai-responses");
    assert.equal(models["cx/gpt-6.1-sol"].baseUrl, undefined);
    assert.equal(models["glm-5.3"].api, undefined);

    // A single entry maps its limits, cheapest prices, image input, and advertised thinking levels.
    assert.equal(models["glm-5.3"].name, "GLM 5.3");
    assert.deepEqual(models["glm-5.3"].input, ["text", "image"]);
    assert.deepEqual(models["glm-5.3"].cost, { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 });
    assert.equal(models["glm-5.3"].contextWindow, 200000);
    assert.equal(models["glm-5.3"].maxTokens, 32000);
    assert.deepEqual(models["glm-5.3"].thinkingLevelMap, {
        off: "none",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
    });

    // Without advertised levels every Pi level stays except xhigh and max; missing limits get defaults.
    assert.equal(models["plain"].name, "plain");
    assert.deepEqual(models["plain"].input, ["text"]);
    assert.deepEqual(models["plain"].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(models["plain"].contextWindow, 128000);
    assert.equal(models["plain"].maxTokens, 16384);
    assert.deepEqual(models["plain"].thinkingLevelMap, {
        off: "none",
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
    });

    // A namespaced duplicate is a model of its own, including an advertised max level.
    assert.equal(models["zhipu/glm-5.3"].name, "zhipu/glm-5.3");
    assert.equal(models["zhipu/glm-5.3"].thinkingLevelMap.max, "max");

    // An alias merges its same-named entries: common levels, narrowest limits, cheapest prices, text-only input.
    assert.equal(models["alias/glm-5.3"].name, "GLM 5.3");
    assert.deepEqual(models["alias/glm-5.3"].input, ["text"]);
    assert.deepEqual(models["alias/glm-5.3"].cost, { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 });
    assert.equal(models["alias/glm-5.3"].contextWindow, 100000);
    assert.equal(models["alias/glm-5.3"].maxTokens, 16000);
    assert.deepEqual(models["alias/glm-5.3"].thinkingLevelMap, {
        off: "none",
        minimal: null,
        low: null,
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
    });

    // Image-output entries and entries without an id never become models.
    assert.equal(config.models.length, 6);

    const signal = new AbortController().signal;
    const beforeRefresh = calls.length;

    // Cache-only refreshes work offline and never touch the network.
    assert.deepEqual(
        await config.refreshModels({
            allowNetwork: false,
            signal,
            stored: { models: [{ provider: "inferhub", id: "cached", name: "Cached" }] },
            publish: noPublish,
        }),
        [{ id: "cached", name: "Cached" }],
    );

    // Missing api-key credentials and aborted refreshes also stay on the known catalog.
    assert.equal(
        await config.refreshModels({ allowNetwork: true, signal, credential: { type: "oauth" }, publish: noPublish }),
        config.models,
    );
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(
        await config.refreshModels({
            allowNetwork: true,
            signal: aborted.signal,
            credential: { type: "api_key", key: "ignored" },
            publish: noPublish,
        }),
        config.models,
    );
    assert.equal(calls.length, beforeRefresh);

    // A keyed network refresh fetches, persists, and replaces the known catalog.
    stub({
        data: [
            { id: "fresh", owned_by: "x" },
            { id: "cc/claude-fresh", owned_by: "cc" },
        ],
    });
    const published = [];
    const refreshed = await config.refreshModels({
        allowNetwork: true,
        signal,
        credential: { type: "api_key", key: "secret" },
        publish: async (publication) => published.push(publication),
    });
    assert.deepEqual(
        refreshed.map((model) => model.id),
        ["fresh", "cc/claude-fresh"],
    );
    assert.equal(calls.at(-1).url, "https://api.inferhub.dev/v1/models");
    assert.equal(calls.at(-1).init.headers.Authorization, "Bearer secret");
    assert.equal(published.length, 1);
    // The persist keeps each model's native api and only defaults the provider api when missing.
    assert.deepEqual(
        published[0].persist.models.map(({ id, api, baseUrl }) => ({ id, api, baseUrl })),
        [
            { id: "fresh", api: "openai-completions", baseUrl: "https://api.inferhub.dev/v1" },
            { id: "cc/claude-fresh", api: "anthropic-messages", baseUrl: "https://api.inferhub.dev" },
        ],
    );
    assert.ok(published[0].persist.checkedAt <= Date.now());
    assert.deepEqual(
        (await config.refreshModels({ allowNetwork: false, signal, publish: noPublish })).map((model) => model.id),
        ["fresh", "cc/claude-fresh"],
    );

    // A broken catalog must not take down startup; the provider still registers with no models.
    stub({}, 500);
    await install();
    assert.deepEqual(configured.config.models, []);

    // PI_OFFLINE skips the startup fetch entirely.
    stub(catalog);
    const beforeOffline = calls.length;
    process.env.PI_OFFLINE = "1";
    await install();
    assert.deepEqual(configured.config.models, []);
    assert.equal(calls.length, beforeOffline);
} finally {
    globalThis.fetch = realFetch;
    delete process.env.INFERHUB_API_KEY;
    delete process.env.PI_OFFLINE;
}

console.log("pi-inferhub: all checks passed");

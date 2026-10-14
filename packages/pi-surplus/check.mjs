// Run: node check.mjs (Node >=22.19 supports TypeScript type stripping).
import assert from "node:assert/strict";
import extension from "./index.ts";

const realFetch = globalThis.fetch;
const calls = [];
const entry = (id, input, output, extra = {}) => ({
    id,
    name: id.toUpperCase(),
    context_length: 100000,
    architecture: { input_modalities: input, output_modalities: output },
    pricing: { prompt: "0.0000030000", completion: "0.0000150000", input_cache_read: "0.0000003000" },
    top_provider: { context_length: 200000, max_completion_tokens: 32000 },
    supported_parameters: ["max_tokens", "reasoning_effort"],
    supported_features: ["streaming", "tools", "vision", "reasoning"],
    ...extra,
});
const catalog = {
    data: [
        entry("vision-reasoner", ["text", "image"], ["text"]),
        entry("plain", ["text"], ["text"], {
            name: "",
            pricing: { prompt: "0", completion: "0" },
            top_provider: { context_length: 0, max_completion_tokens: null },
            context_length: 0,
            supported_parameters: [],
            supported_features: ["streaming"],
        }),
        entry("claude-x", ["text"], ["text"], { provider: "Anthropic" }),
        entry("gpt-6.1-sol", ["text"], ["text"], { provider: "OpenAI" }),
        entry("openai-gpt-oss-20b", ["text"], ["text"], { provider: "OpenAI" }),
        entry("image-gen", ["text"], ["image"]),
        entry("whisper", ["audio"], ["text"]),
        entry("embed", ["text"], ["embedding"]),
        { name: "no-id", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
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

process.env.SURPLUS_API_KEY = "startup-key";
try {
    stub(catalog);
    await install();

    const { config } = configured;
    assert.equal(configured.name, "surplus");
    assert.equal(config.name, "Surplus");
    assert.equal(config.baseUrl, "https://api.surplusintelligence.ai/v1");
    assert.equal(config.apiKey, "$SURPLUS_API_KEY");
    assert.equal(config.api, "openai-completions");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.surplusintelligence.ai/v1/models");
    assert.equal(calls[0].init.headers.Authorization, "Bearer startup-key");

    // Only text-in, text-out chat models become models.
    assert.deepEqual(
        config.models.map((model) => model.id),
        ["vision-reasoner", "plain", "claude-x", "gpt-6.1-sol", "openai-gpt-oss-20b"],
    );
    const [full, plain, claude, gpt, oss] = config.models;

    // Claude rides the Anthropic skin and GPT the Responses API; others inherit the provider default.
    assert.equal(claude.api, "anthropic-messages");
    assert.equal(claude.baseUrl, "https://api.surplusintelligence.ai/anthropic");
    assert.equal(gpt.api, "openai-responses");
    assert.equal(gpt.baseUrl, undefined);
    assert.equal(oss.api, undefined);
    assert.equal(full.api, undefined);

    // Per-token prices convert to per-million; limits prefer top_provider; capabilities follow the catalog.
    assert.equal(full.name, "VISION-REASONER");
    assert.equal(full.reasoning, true);
    assert.deepEqual(full.input, ["text", "image"]);
    assert.deepEqual(full.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
    assert.equal(full.contextWindow, 200000);
    assert.equal(full.maxTokens, 32000);
    assert.equal(full.compat.supportsReasoningEffort, true);

    // Missing names, prices and zero limits fall back to defaults.
    assert.equal(plain.name, "plain");
    assert.equal(plain.reasoning, false);
    assert.deepEqual(plain.input, ["text"]);
    assert.deepEqual(plain.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(plain.contextWindow, 128000);
    assert.equal(plain.maxTokens, 16384);
    assert.equal(plain.compat.supportsReasoningEffort, false);

    const signal = new AbortController().signal;
    const beforeRefresh = calls.length;

    // Cache-only refreshes work offline and never touch the network.
    assert.deepEqual(
        await config.refreshModels({
            allowNetwork: false,
            signal,
            stored: { models: [{ provider: "surplus", id: "cached", name: "Cached" }] },
            publish: noPublish,
        }),
        [{ id: "cached", name: "Cached" }],
    );

    // Aborted refreshes stay on the known catalog.
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(
        await config.refreshModels({ allowNetwork: true, signal: aborted.signal, publish: noPublish }),
        config.models,
    );
    assert.equal(calls.length, beforeRefresh);

    // A keyed network refresh fetches, persists, and replaces the known catalog.
    stub({
        data: [
            entry("fresh", ["text"], ["text"]),
            entry("claude-fresh", ["text"], ["text"], { provider: "Anthropic" }),
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
        ["fresh", "claude-fresh"],
    );
    assert.equal(calls.at(-1).init.headers.Authorization, "Bearer secret");
    assert.equal(published.length, 1);
    assert.deepEqual(
        published[0].persist.models.map(({ id, provider, api, baseUrl }) => ({ id, provider, api, baseUrl })),
        [
            {
                id: "fresh",
                provider: "surplus",
                api: "openai-completions",
                baseUrl: "https://api.surplusintelligence.ai/v1",
            },
            {
                id: "claude-fresh",
                provider: "surplus",
                api: "anthropic-messages",
                baseUrl: "https://api.surplusintelligence.ai/anthropic",
            },
        ],
    );
    assert.ok(published[0].persist.checkedAt <= Date.now());

    // The catalog is public, so a refresh without an api key still fetches, unauthenticated.
    await config.refreshModels({ allowNetwork: true, signal, credential: { type: "oauth" }, publish: async () => {} });
    assert.equal(calls.at(-1).init.headers.Authorization, undefined);

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
    delete process.env.SURPLUS_API_KEY;
    delete process.env.PI_OFFLINE;
}

console.log("pi-surplus: all checks passed");

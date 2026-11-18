import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import extension from "../index.ts";

const BASE_URL = "https://api.surplusintelligence.ai/v1";
const ANTHROPIC_BASE_URL = "https://api.surplusintelligence.ai/anthropic";
const CHAT_MODEL_IDS = ["vision-reasoner", "plain", "claude-x", "gpt-6.1-sol", "openai-gpt-oss-20b"];

const realFetch = globalThis.fetch;
const calls: { url: string; init: any }[] = [];

const entry = (id: string, input: string[], output: string[], extra: Record<string, unknown> = {}) => ({
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

// A catalog mixing chat, image, audio and embedding models with one entry that has no id.
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

const compat = (supportsReasoningEffort: boolean) => ({
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort,
    supportsUsageInStreaming: true,
    supportsStrictMode: false,
    maxTokensField: "max_tokens",
});

function stubFetch(body: unknown, status = 200) {
    globalThis.fetch = (async (url: string, init: any) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
}

const noPublish = () => assert.fail("refresh must not publish without a network fetch");

let configured: any;
async function install() {
    await extension({ registerProvider: (name: string, config: unknown) => (configured = { name, config }) } as any);
}

describe("pi-surplus", () => {
    let config: any;

    beforeAll(async () => {
        process.env.SURPLUS_API_KEY = "startup-key";
        stubFetch(catalog);
        await install();
        config = configured.config;
    });

    afterAll(() => {
        globalThis.fetch = realFetch;
        delete process.env.SURPLUS_API_KEY;
        delete process.env.PI_OFFLINE;
    });

    describe("registration", () => {
        it("registers the provider and loads the catalog with the startup key", () => {
            assert.deepEqual(
                { name: configured.name, api: config.api, baseUrl: config.baseUrl, apiKey: config.apiKey },
                { name: "surplus", api: "openai-completions", baseUrl: BASE_URL, apiKey: "$SURPLUS_API_KEY" },
            );
            assert.equal(config.name, "Surplus");
            assert.equal(calls[0].url, `${BASE_URL}/models`);
            assert.equal(calls[0].init.headers.Authorization, "Bearer startup-key");
        });

        it("keeps only text chat models and maps vendors to their api skin", () => {
            assert.deepEqual(
                config.models.map(({ id, api, baseUrl }: any) => ({ id, api, baseUrl })),
                [
                    { id: "vision-reasoner", api: undefined, baseUrl: undefined },
                    { id: "plain", api: undefined, baseUrl: undefined },
                    { id: "claude-x", api: "anthropic-messages", baseUrl: ANTHROPIC_BASE_URL },
                    { id: "gpt-6.1-sol", api: "openai-responses", baseUrl: undefined },
                    { id: "openai-gpt-oss-20b", api: undefined, baseUrl: undefined },
                ],
            );
        });

        it("converts prices per million, prefers top_provider limits and reads capabilities", () => {
            assert.deepEqual(config.models[0], {
                id: "vision-reasoner",
                name: "VISION-REASONER",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 32000,
                compat: compat(true),
            });
        });

        it("falls back to defaults for missing names, prices and zero limits", () => {
            assert.deepEqual(config.models[1], {
                id: "plain",
                name: "plain",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
                compat: compat(false),
            });
        });
    });

    // Each keyed refresh replaces the provider's registry, so these run in order.
    describe("refreshModels", () => {
        const signal = new AbortController().signal;

        it("serves cache-only refreshes without touching the network", async () => {
            assert.deepEqual(
                await config.refreshModels({
                    allowNetwork: false,
                    signal,
                    stored: { models: [{ provider: "surplus", id: "cached", name: "Cached" }] },
                    publish: noPublish,
                }),
                [{ id: "cached", name: "Cached" }],
            );
        });

        it("stays on the known catalog when aborted", async () => {
            const before = calls.length;
            const aborted = new AbortController();
            aborted.abort();
            const known = await config.refreshModels({
                allowNetwork: true,
                signal: aborted.signal,
                publish: noPublish,
            });
            assert.deepEqual(
                known.map(({ id }: any) => id),
                CHAT_MODEL_IDS,
            );
            assert.equal(calls.length, before);
        });

        it("fetches, persists and replaces the known catalog when keyed", async () => {
            stubFetch({
                data: [
                    entry("fresh", ["text"], ["text"]),
                    entry("claude-fresh", ["text"], ["text"], { provider: "Anthropic" }),
                ],
            });
            const published: any[] = [];
            const refreshed = await config.refreshModels({
                allowNetwork: true,
                signal,
                credential: { type: "api_key", key: "secret" },
                publish: async (publication: any) => published.push(publication),
            });
            assert.deepEqual(
                refreshed.map(({ id }: any) => id),
                ["fresh", "claude-fresh"],
            );
            assert.equal(calls.at(-1)!.init.headers.Authorization, "Bearer secret");
            assert.equal(published.length, 1);
            assert.deepEqual(
                published[0].persist.models.map(({ id, provider, api, baseUrl }: any) => ({
                    id,
                    provider,
                    api,
                    baseUrl,
                })),
                [
                    { id: "fresh", provider: "surplus", api: "openai-completions", baseUrl: BASE_URL },
                    { id: "claude-fresh", provider: "surplus", api: "anthropic-messages", baseUrl: ANTHROPIC_BASE_URL },
                ],
            );
            assert.ok(published[0].persist.checkedAt <= Date.now());
        });

        it("fetches unauthenticated when the credential is not an api key", async () => {
            await config.refreshModels({
                allowNetwork: true,
                signal,
                credential: { type: "oauth" },
                publish: async () => {},
            });
            assert.equal(calls.at(-1)!.init.headers.Authorization, undefined);
        });
    });

    describe("startup resilience", () => {
        it("still registers the provider with no models when the catalog breaks", async () => {
            stubFetch({}, 500);
            await install();
            assert.deepEqual(configured.config.models, []);
        });

        it("skips the startup fetch entirely under PI_OFFLINE", async () => {
            stubFetch(catalog);
            const before = calls.length;
            process.env.PI_OFFLINE = "1";
            await install();
            assert.deepEqual(configured.config.models, []);
            assert.equal(calls.length, before);
        });
    });
});

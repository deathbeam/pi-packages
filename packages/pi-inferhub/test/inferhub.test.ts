import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import extension from "../index.ts";

const BASE_URL = "https://api.inferhub.dev/v1";
const MODELS_URL = `${BASE_URL}/models`;
const COMBOS_URL = "https://inferhub.dev/api/combos";
const realFetch = globalThis.fetch;
const signal = new AbortController().signal;
const calls: { url: string; auth: string | undefined }[] = [];

// One entry per catalog rule: priced, namespaced, native api, alias, plain, image output, no id.
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
            pricing: { min_ask_in: 0, official_in: 0.2, official_out: 0.8 },
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
        { id: "plain", owned_by: "other", modality: "text", input_token_limit: 0, max_output_tokens: 0 },
        { id: "image-out", output_modality: "image" },
        { owned_by: "no-id" },
    ],
};

// A combo is not in /v1/models: it comes from the management API and lists its members by id or alias.
const comboFixture = [
    {
        slug: "fast",
        name: "Fast Combo",
        members: [
            { kind: "model", model: "zhipu/glm-5.3" },
            { kind: "alias", alias: "glm-5.3" },
            { kind: "model", model: "gone/removed" },
        ],
    },
    { name: "Combo without a slug" },
];

let combos: unknown[] = [];
let combosStatus = 200;

/** Replaces fetch with a stub that serves `body` for the catalog and the `combos` variable for combos. */
function stubFetch(body: unknown, status = 200): void {
    globalThis.fetch = async (url: any, init: any) => {
        calls.push({ url, auth: init?.headers?.Authorization });
        const isCombos = url === COMBOS_URL;
        return new Response(JSON.stringify(isCombos ? combos : body), { status: isCombos ? combosStatus : status });
    };
}

async function install(): Promise<{ name: string; config: any }> {
    let provider: any;
    await extension({ registerProvider: (name: string, config: any) => (provider = { name, config }) } as any);
    return provider;
}

function installWithCatalog(): Promise<{ name: string; config: any }> {
    stubFetch(catalog);
    return install();
}

const noPublish = () => assert.fail("refresh must not publish without a network fetch");

beforeAll(() => {
    process.env.INFERHUB_API_KEY = "startup-key";
});

beforeEach(() => {
    calls.length = 0;
    combos = [];
    combosStatus = 200;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

afterAll(() => {
    delete process.env.INFERHUB_API_KEY;
    delete process.env.PI_OFFLINE;
});

describe("registration", () => {
    it("registers the provider and fetches models and combos with the startup key", async () => {
        combos = comboFixture;
        const provider = await installWithCatalog();
        assert.equal(provider.name, "inferhub");
        assert.deepEqual(
            {
                name: provider.config.name,
                baseUrl: provider.config.baseUrl,
                apiKey: provider.config.apiKey,
                api: provider.config.api,
            },
            { name: "InferHub", baseUrl: BASE_URL, apiKey: "$INFERHUB_API_KEY", api: "openai-completions" },
        );
        assert.deepEqual(calls, [
            { url: MODELS_URL, auth: "Bearer startup-key" },
            { url: COMBOS_URL, auth: "Bearer startup-key" },
        ]);
    });

    it("registers with no models when the catalog call fails", async () => {
        stubFetch({}, 500);
        const { config } = await install();
        assert.deepEqual(config.models, []);
    });

    it("keeps the catalog when the combos call fails", async () => {
        combos = [{ slug: "dropped" }];
        combosStatus = 500;
        const { config } = await installWithCatalog();
        assert.deepEqual(
            config.models.filter((model: any) => model.id.startsWith("combo/")),
            [],
        );
        assert.equal(config.models.length, 6);
    });

    it("skips the startup fetch under PI_OFFLINE", async () => {
        process.env.PI_OFFLINE = "1";
        try {
            const { config } = await installWithCatalog();
            assert.deepEqual(config.models, []);
            assert.deepEqual(calls, []);
        } finally {
            delete process.env.PI_OFFLINE;
        }
    });
});

describe("model catalog", () => {
    let models: Record<string, any>;

    /** The mapped fields every catalog test pins, minus the api routing. */
    const shape = ({ name, input, cost, contextWindow, maxTokens, thinkingLevelMap }: any) => ({
        name,
        input,
        cost,
        contextWindow,
        maxTokens,
        thinkingLevelMap,
    });

    beforeAll(async () => {
        combos = comboFixture;
        const { config } = await installWithCatalog();
        models = Object.fromEntries(config.models.map((model: any) => [model.id, model]));
    });

    it("lists one model per usable entry and resolvable combo", () => {
        assert.deepEqual(Object.keys(models), [
            "glm-5.3",
            "zhipu/glm-5.3",
            "cc/claude-haiku-4-5",
            "cx/gpt-6.1-sol",
            "alias/glm-5.3",
            "plain",
            "combo/fast",
        ]);
    });

    it("maps limits, cheapest prices, modalities and advertised thinking levels", () => {
        assert.deepEqual(shape(models["glm-5.3"]), {
            name: "GLM 5.3",
            input: ["text", "image"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 32000,
            thinkingLevelMap: {
                off: "none",
                minimal: null,
                low: "low",
                medium: "medium",
                high: "high",
                xhigh: null,
                max: null,
            },
        });
    });

    it("defaults missing or zero limits and advertises the standard levels", () => {
        assert.deepEqual(shape(models["plain"]), {
            name: "plain",
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
            thinkingLevelMap: {
                off: "none",
                minimal: "minimal",
                low: "low",
                medium: "medium",
                high: "high",
                xhigh: null,
                max: null,
            },
        });
    });

    it("routes Claude and GPT models through their native APIs", () => {
        assert.deepEqual(
            ["cc/claude-haiku-4-5", "cx/gpt-6.1-sol", "glm-5.3"].map((id) => [models[id].api, models[id].baseUrl]),
            [
                ["anthropic-messages", "https://api.inferhub.dev"],
                ["openai-responses", undefined],
                [undefined, undefined],
            ],
        );
    });

    it("keeps a namespaced duplicate as a model of its own", () => {
        assert.deepEqual(
            [models["zhipu/glm-5.3"].name, models["zhipu/glm-5.3"].thinkingLevelMap.max],
            ["zhipu/glm-5.3", "max"],
        );
    });

    it("merges an alias or a combo from its resolvable sources", () => {
        const merged = {
            input: ["text"], // every source must accept images
            cost: { input: 0, output: 0.8, cacheRead: 0, cacheWrite: 0 }, // 0 is a real price
            contextWindow: 100000,
            maxTokens: 16000,
            thinkingLevelMap: {
                off: "none",
                minimal: null,
                low: null,
                medium: "medium",
                high: "high",
                xhigh: null,
                max: null,
            },
        };
        assert.deepEqual(shape(models["alias/glm-5.3"]), { name: "GLM 5.3", ...merged });
        assert.deepEqual(shape(models["combo/fast"]), { name: "Fast Combo", ...merged });
    });
});

describe("refreshModels", () => {
    const apiKey = { type: "api_key", key: "secret" };

    it("serves the stored models offline without touching the network", async () => {
        const { config } = await installWithCatalog();
        const before = calls.length;
        assert.deepEqual(
            await config.refreshModels({
                allowNetwork: false,
                signal,
                stored: { models: [{ provider: "inferhub", id: "cached", name: "Cached" }] },
                publish: noPublish,
            }),
            [{ id: "cached", name: "Cached" }],
        );
        assert.equal(calls.length, before);
    });

    it("keeps the known catalog without an api key", async () => {
        const { config } = await installWithCatalog();
        const before = calls.length;
        assert.deepEqual(
            await config.refreshModels({
                allowNetwork: true,
                signal,
                credential: { type: "oauth" },
                publish: noPublish,
            }),
            config.models,
        );
        assert.equal(calls.length, before);
    });

    it("keeps the known catalog when the signal is already aborted", async () => {
        const { config } = await installWithCatalog();
        const before = calls.length;
        const aborted = new AbortController();
        aborted.abort();
        assert.deepEqual(
            await config.refreshModels({
                allowNetwork: true,
                signal: aborted.signal,
                credential: apiKey,
                publish: noPublish,
            }),
            config.models,
        );
        assert.equal(calls.length, before);
    });

    it("fetches, persists and replaces the catalog with a keyed refresh", async () => {
        const { config } = await installWithCatalog();
        stubFetch({
            data: [
                { id: "fresh", owned_by: "x" },
                { id: "cc/claude-fresh", owned_by: "cc" },
            ],
        });
        const published: any[] = [];
        const refreshed = await config.refreshModels({
            allowNetwork: true,
            signal,
            credential: apiKey,
            publish: async (publication: any) => published.push(publication),
        });

        assert.deepEqual(
            refreshed.map((model: any) => model.id),
            ["fresh", "cc/claude-fresh"],
        );
        assert.deepEqual(
            calls.map((call) => [call.url, call.auth]),
            [
                [MODELS_URL, "Bearer startup-key"],
                [COMBOS_URL, "Bearer startup-key"],
                [MODELS_URL, "Bearer secret"],
                [COMBOS_URL, "Bearer secret"],
            ],
        );
        // The persist keeps each model's native api and only defaults the provider api and base url.
        assert.deepEqual(
            published[0].persist.models.map(({ id, api, baseUrl, provider }: any) => ({ id, api, baseUrl, provider })),
            [
                { id: "fresh", api: "openai-completions", baseUrl: BASE_URL, provider: "inferhub" },
                {
                    id: "cc/claude-fresh",
                    api: "anthropic-messages",
                    baseUrl: "https://api.inferhub.dev",
                    provider: "inferhub",
                },
            ],
        );
        assert.ok(published[0].persist.checkedAt <= Date.now());
        assert.deepEqual(
            (await config.refreshModels({ allowNetwork: false, signal, publish: noPublish })).map(
                (model: any) => model.id,
            ),
            ["fresh", "cc/claude-fresh"],
        );
    });
});

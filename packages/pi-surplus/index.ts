import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type CatalogEntry = {
    id?: unknown;
    name?: unknown;
    context_length?: unknown;
    architecture?: { input_modalities?: unknown; output_modalities?: unknown };
    pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown; input_cache_write?: unknown };
    top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
    supported_parameters?: unknown;
    supported_features?: unknown;
    provider?: unknown;
};

const BASE_URL = "https://api.surplusintelligence.ai/v1";
// The Anthropic SDK appends /v1/messages itself; the skin lives under /anthropic, not /v1/messages.
const ANTHROPIC_BASE_URL = "https://api.surplusintelligence.ai/anthropic";
const API = "openai-completions";

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

// Prices arrive as USD-per-token strings; Pi wants USD per million tokens.
const perMillion = (value: unknown): number => {
    const price = Number(value) * 1e6;
    return Number.isFinite(price) && price > 0 ? Math.round(price * 1e6) / 1e6 : 0;
};

// A 0 or missing limit is missing data, unlike a 0 price, so it falls back to the default.
const limit = (value: unknown, fallback: number): number => (typeof value === "number" && value > 0 ? value : fallback);

function toPiModel(entry: CatalogEntry): ProviderModelConfig | undefined {
    const output = strings(entry.architecture?.output_modalities);
    const input = strings(entry.architecture?.input_modalities);
    // The catalog also lists image, video, music, audio and embedding models; only text-out chat models apply.
    if (typeof entry.id !== "string" || !entry.id || output.join() !== "text" || !input.includes("text")) {
        return undefined;
    }

    const price = entry.pricing ?? {};
    return {
        ...(entry.provider === "Anthropic" ? { api: "anthropic-messages", baseUrl: ANTHROPIC_BASE_URL } : {}),
        ...(/^gpt-\d/.test(entry.id) ? { api: "openai-responses" } : {}),
        id: entry.id,
        name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
        reasoning: strings(entry.supported_features).includes("reasoning"),
        input: input.includes("image") ? ["text", "image"] : ["text"],
        cost: {
            input: perMillion(price.prompt),
            output: perMillion(price.completion),
            cacheRead: perMillion(price.input_cache_read),
            cacheWrite: perMillion(price.input_cache_write),
        },
        contextWindow: limit(entry.top_provider?.context_length ?? entry.context_length, 128000),
        maxTokens: limit(entry.top_provider?.max_completion_tokens, 16384),
        compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: strings(entry.supported_parameters).includes("reasoning_effort"),
            supportsUsageInStreaming: true,
            supportsStrictMode: false,
            maxTokensField: "max_tokens",
        },
    };
}

// The catalog is public; a key is sent only when one is known.
async function fetchCatalog(apiKey: string | undefined, signal: AbortSignal): Promise<ProviderModelConfig[]> {
    const response = await fetch(`${BASE_URL}/models`, {
        headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal,
    });
    if (!response.ok) {
        throw new Error(`Surplus model catalog failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { data?: CatalogEntry[] };
    if (!Array.isArray(payload.data)) throw new Error("Surplus model catalog has no data array");
    return payload.data.map(toPiModel).filter((model): model is ProviderModelConfig => model !== undefined);
}

export default async function (pi: ExtensionAPI) {
    const envKey = process.env.SURPLUS_API_KEY;
    let registry: ProviderModelConfig[] = process.env.PI_OFFLINE
        ? []
        : await fetchCatalog(envKey, AbortSignal.timeout(5000)).catch(() => []);

    pi.registerProvider("surplus", {
        name: "Surplus",
        baseUrl: BASE_URL,
        apiKey: "$SURPLUS_API_KEY",
        api: API,
        models: registry,
        refreshModels: async (context) => {
            const cached = context.stored?.models.map(({ provider: _provider, ...model }) => model) ?? [];
            const known = cached.length > 0 ? cached : registry;
            if (!context.allowNetwork || context.signal.aborted) return known;

            const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
            registry = await fetchCatalog(apiKey, context.signal);
            await context.publish({
                persist: {
                    models: registry.map((model) => ({
                        ...model,
                        provider: "surplus",
                        api: model.api ?? API,
                        baseUrl: model.baseUrl ?? BASE_URL,
                    })),
                    checkedAt: Date.now(),
                },
            });
            return registry;
        },
    });
}

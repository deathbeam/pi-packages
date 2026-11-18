import fs from "node:fs";
import path from "node:path";
import type {
    Api,
    AssistantMessageEvent,
    AssistantMessageEventStream,
    Model,
    SimpleStreamOptions,
    TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

const PROVIDER = "combo";
const COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 30 * 60_000;

function settingsCombos(file: string): Record<string, unknown> {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"))?.combos ?? {};
    } catch {
        return {};
    }
}

/** Project combos replace global ones of the same name. */
function readCombos(cwd: string): Map<string, string[]> {
    const combos = {
        ...settingsCombos(path.join(getAgentDir(), "settings.json")),
        ...settingsCombos(path.join(cwd, CONFIG_DIR_NAME, "settings.json")),
    };
    return new Map(
        Object.entries(combos).map(([name, refs]) => [
            name,
            Array.isArray(refs) ? refs.filter((ref) => typeof ref === "string") : [],
        ]),
    );
}

function resolveMembers(refs: string[], registry: ModelRegistry): Model<Api>[] {
    return refs.flatMap((ref) => {
        const slash = ref.indexOf("/");
        const provider = ref.slice(0, slash);
        const model = slash > 0 && provider !== PROVIDER ? registry.find(provider, ref.slice(slash + 1)) : undefined;
        return model ? [model] : [];
    });
}

/** Limits every member can meet. */
function comboModel(name: string, members: Model<Api>[]): ProviderModelConfig {
    return {
        id: name,
        name,
        input: members[0].input.filter((input) => members.every((member) => member.input.includes(input))),
        cost: members[0].cost,
        reasoning: members.some((member) => member.reasoning),
        contextWindow: Math.min(...members.map((member) => member.contextWindow)),
        maxTokens: Math.min(...members.map((member) => member.maxTokens)),
    };
}

function pendingModel(name: string): ProviderModelConfig {
    return {
        id: name,
        name,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 16384,
    };
}

type Cooldown = { failures: number; until: number };

/**
 * Tries members in order; a member that fails before any output hands over to the next one and
 * moves to the back of the list, for twice as long on each failure in a row.
 */
async function pipe(
    out: AssistantMessageEventStream,
    members: Model<Api>[],
    cooldowns: Map<string, Cooldown>,
    registry: ModelRegistry,
    context: TranscriptContext,
    options: SimpleStreamOptions,
): Promise<void> {
    const key = (model: Model<Api>) => `${model.provider}/${model.id}`;
    const cooling = (model: Model<Api>) => (cooldowns.get(key(model))?.until ?? 0) > Date.now();
    const ordered = [...members.filter((member) => !cooling(member)), ...members.filter(cooling)];
    let failure: AssistantMessageEvent | undefined;
    for (const member of ordered) {
        let start: AssistantMessageEvent | undefined;
        let started = false;
        for await (const event of registry.streamSimple(member, context, options)) {
            if (!started) {
                if (event.type === "start") {
                    start = event;
                    continue;
                }
                if (event.type === "error" && event.reason !== "aborted") {
                    failure = event;
                    const failures = (cooldowns.get(key(member))?.failures ?? 0) + 1;
                    const wait = Math.min(COOLDOWN_MS * 2 ** (failures - 1), MAX_COOLDOWN_MS);
                    cooldowns.set(key(member), { failures, until: Date.now() + wait });
                    break;
                }
                started = true;
                cooldowns.delete(key(member));
                // pi ignores updates that arrive before start.
                if (start) out.push(start);
            }
            out.push(event);
            if (event.type === "done") return out.end(event.message);
            if (event.type === "error") return out.end(event.error);
        }
        if (started) return out.end();
    }
    if (failure) out.push(failure);
    out.end();
}

export default function (pi: ExtensionAPI) {
    let combos = new Map<string, Model<Api>[]>();
    const cooldowns = new Map<string, Cooldown>();
    let registry: ModelRegistry | undefined;

    function register(models: ProviderModelConfig[]): void {
        pi.registerProvider(PROVIDER, {
            name: "Combos",
            // pi requires these, but each member uses its own endpoint and key.
            baseUrl: PROVIDER,
            api: PROVIDER,
            apiKey: PROVIDER,
            models,
            streamSimple: (model, context, options) => {
                const members = combos.get(model.id);
                if (!registry || !members) throw new Error(`Combo ${model.id} has no known models`);
                // Drop the combo's own credentials so each member resolves its own.
                const { apiKey: _apiKey, headers: _headers, env: _env, ...rest } = options ?? {};
                const out = createAssistantMessageEventStream();
                void pipe(out, members, cooldowns, registry, context, rest);
                return out;
            },
        });
    }

    // pi restores a resumed session's model before session_start, so the ids must exist at load time.
    const names = [...readCombos(process.cwd()).keys()];
    if (names.length > 0) register(names.map(pendingModel));

    pi.on("session_start", (_event, ctx) => {
        registry = ctx.modelRegistry;
        combos = new Map();
        const unknown: string[] = [];
        for (const [name, refs] of readCombos(ctx.cwd)) {
            const members = resolveMembers(refs, registry);
            if (members.length > 0) combos.set(name, members);
            else unknown.push(name);
        }

        if (combos.size > 0) register([...combos].map(([name, members]) => comboModel(name, members)));
        else pi.unregisterProvider(PROVIDER);
        if (unknown.length > 0 && ctx.hasUI) {
            ctx.ui.notify(`Combo ${unknown.join(", ")}: no known models, skipped`, "warning");
        }
    });
}

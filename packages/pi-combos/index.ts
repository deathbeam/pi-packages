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
import { createAssistantMessageEventStream, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

type Cooldown = { failures: number; until: number };
type ErrorEvent = Extract<AssistantMessageEvent, { type: "error" }>;

const PROVIDER = "combo";
// pi only offers these levels when the model maps them; members map them for real.
const EXTENDED_LEVELS = ["xhigh", "max"] as const;
const COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 30 * 60_000;

/** Undefined when the file exists but does not parse. */
function settingsCombos(file: string): Record<string, unknown> | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"))?.combos ?? {};
    } catch {
        return fs.existsSync(file) ? undefined : {};
    }
}

/** Project combos replace global ones of the same name, and only a trusted project contributes them. */
function readCombos(cwd: string, trusted: boolean): { combos: Map<string, string[]>; invalid?: string } {
    const files = [path.join(getAgentDir(), "settings.json")];
    if (trusted) files.push(path.join(cwd, CONFIG_DIR_NAME, "settings.json"));
    const combos = new Map<string, string[]>();
    let invalid: string | undefined;
    for (const file of files) {
        const parsed = settingsCombos(file);
        if (parsed === undefined) {
            invalid ??= file;
            continue;
        }
        for (const [name, refs] of Object.entries(parsed)) {
            combos.set(name, Array.isArray(refs) ? refs.filter((ref) => typeof ref === "string") : []);
        }
    }
    return { combos, invalid };
}

function findModel(ref: string, registry: ModelRegistry): Model<Api> | undefined {
    const slash = ref.indexOf("/");
    const provider = ref.slice(0, slash);
    return slash > 0 && provider !== PROVIDER ? registry.find(provider, ref.slice(slash + 1)) : undefined;
}

function memberKey(model: Model<Api>): string {
    return `${model.provider}/${model.id}`;
}

/** Limits every member can meet; thinking levels any member can use, since each clamps its own. */
function comboModel(name: string, members: Model<Api>[]): ProviderModelConfig {
    const levels = new Set(members.flatMap(getSupportedThinkingLevels));
    return {
        id: name,
        name,
        input: members[0].input.filter((input) => members.every((member) => member.input.includes(input))),
        cost: members[0].cost,
        reasoning: members.some((member) => member.reasoning),
        thinkingLevelMap: Object.fromEntries(
            EXTENDED_LEVELS.filter((level) => levels.has(level)).map((level) => [level, level]),
        ),
        contextWindow: Math.min(...members.map((member) => member.contextWindow)),
        maxTokens: Math.min(...members.map((member) => member.maxTokens)),
    };
}

/** Stands in while no member resolves; anything stricter would clamp a restored thinking level. */
function pendingModel(name: string): ProviderModelConfig {
    return {
        id: name,
        name,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: true,
        thinkingLevelMap: Object.fromEntries(EXTENDED_LEVELS.map((level) => [level, level])),
        contextWindow: 128000,
        maxTokens: 16384,
    };
}

/** For a member that throws instead of streaming an error. */
function failedEvent(model: Model<Api>, error: unknown, reason: "error" | "aborted"): ErrorEvent {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    return {
        type: "error",
        reason,
        error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: reason,
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
        },
    };
}

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
    const cooling = (model: Model<Api>) => (cooldowns.get(memberKey(model))?.until ?? 0) > Date.now();
    const reasons: string[] = [];
    const failed = (model: Model<Api>, event: ErrorEvent) => {
        reasons.push(`${memberKey(model)}: ${event.error.errorMessage ?? event.reason}`);
        const failures = (cooldowns.get(memberKey(model))?.failures ?? 0) + 1;
        cooldowns.set(memberKey(model), {
            failures,
            until: Date.now() + Math.min(COOLDOWN_MS * 2 ** (failures - 1), MAX_COOLDOWN_MS),
        });
    };
    let failure: ErrorEvent | undefined;
    const ordered = [...members.filter((member) => !cooling(member)), ...members.filter(cooling)];
    for (const member of ordered) {
        let start: AssistantMessageEvent | undefined;
        let started = false;
        try {
            for await (const event of registry.streamSimple(member, context, options)) {
                if (!started) {
                    if (event.type === "start") {
                        start = event;
                        continue;
                    }
                    if (event.type === "error" && event.reason !== "aborted") {
                        failure = event;
                        failed(member, event);
                        break;
                    }
                    started = true;
                    // An abort is not output, so a cooling member keeps its backoff.
                    if (event.type !== "error") cooldowns.delete(memberKey(member));
                    // pi ignores updates that arrive before start.
                    if (start) out.push(start);
                }
                out.push(event);
                if (event.type === "done") return out.end(event.message);
                if (event.type === "error") return out.end(event.error);
            }
        } catch (error) {
            const event = failedEvent(member, error, options.signal?.aborted ? "aborted" : "error");
            // Output already reached pi, or the user aborted: nothing to fall back from.
            if (started || event.reason === "aborted") {
                out.push(event);
                return out.end(event.error);
            }
            failure = event;
            failed(member, event);
        }
    }
    // shortcut: every member stream ends with done or error, so a silent one ends this stream without a result.
    if (failure) {
        // A member on cooldown is tried last, so its known error would hide the one that failed fresh.
        if (reasons.length > 1)
            failure = {
                ...failure,
                error: { ...failure.error, errorMessage: `All members failed: ${reasons.join("; ")}` },
            };
        out.push(failure);
    }
    out.end(failure?.error);
}

export default function (pi: ExtensionAPI) {
    let combos = new Map<string, string[]>();
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
                // Resolved per request: pi-inferhub and similar providers register their models after session_start.
                const members = combos.get(model.id)?.flatMap((ref) => (registry && findModel(ref, registry)) || []);
                if (!registry || !members?.length) throw new Error(`Combo ${model.id} has no known models`);
                // Drop the combo's own credentials so each member resolves its own.
                const { apiKey: _apiKey, headers: _headers, env: _env, ...rest } = options ?? {};
                const out = createAssistantMessageEventStream();
                void pipe(out, members, cooldowns, registry, context, rest);
                return out;
            },
        });
    }

    // pi restores a resumed session's model before session_start, so every configured id exists before trust is known.
    const names = [...readCombos(process.cwd(), true).combos.keys()];
    if (names.length > 0) register(names.map(pendingModel));

    pi.on("session_start", async (_event, ctx) => {
        const current = ctx.modelRegistry;
        registry = current;
        combos = new Map();
        const unknown: string[] = [];
        const known: ProviderModelConfig[] = [];
        const { combos: configured, invalid } = readCombos(ctx.cwd, ctx.isProjectTrusted());
        for (const [name, refs] of configured) {
            combos.set(name, refs);
            const members = refs.flatMap((ref) => {
                const model = findModel(ref, current);
                if (!model) unknown.push(ref);
                return model ? [model] : [];
            });
            known.push(members.length > 0 ? comboModel(name, members) : pendingModel(name));
        }

        if (known.length > 0) register(known);
        // A resumed session restores the model of the last response, which names the member that
        // answered; the combo the branch selected is only in its last model_change.
        const branch = ctx.sessionManager.getBranch();
        const change = branch.findLast((entry) => entry.type === "model_change");
        const answered = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
        const restored =
            answered?.type === "message" &&
            answered.message.role === "assistant" &&
            answered.message.provider === ctx.model?.provider &&
            answered.message.model === ctx.model.id;
        // --model is applied before session_start too, so only a restored transcript names the member.
        const selected = restored && change?.provider === PROVIDER ? current.find(PROVIDER, change.modelId) : undefined;
        if (selected) await pi.setModel(selected);
        if (unknown.length > 0 && ctx.hasUI)
            ctx.ui.notify(`Combos cannot find models yet: ${unknown.join(", ")}`, "warning");
        if (invalid && ctx.hasUI) ctx.ui.notify(`Combos ignore invalid JSON in ${invalid}`, "warning");
    });
}

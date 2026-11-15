/**
 * Superseded read/edit pruning: replaces tool results a later call made stale
 * with a one-line placeholder. New ids are only pruned while the prompt cache
 * is cold, so a live cached prefix never changes under the provider.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveToCwd } from "./path-utils";

const FALLBACK_TTL_SECONDS = { short: 300, long: 24 * 60 * 60 };

const TOOL_NAMES = new Set(["read", "edit", "write"]);

type Candidate = {
    index: number;
    toolCallId: string;
    /** The path as the model wrote it, for the placeholder. */
    path: string;
    /** Absolute path the supersede rules compare. */
    key: string;
    kind: "read" | "edit" | "write";
    /** A no-op edit changed nothing, so it supersedes nothing. */
    noop: boolean;
    /** Reads with identical arguments return identical text. */
    readKey?: string;
};

export function placeholder(path: string): string {
    return `[superseded: ${path} changed or was re-read later; read again if needed]`;
}

/**
 * Tool results a later successful call made stale, excluding the most recent
 * assistant turn: the model still needs what it just asked for.
 */
export function superseded(messages: readonly unknown[], cwd: string): Array<{ toolCallId: string; path: string }> {
    const calls = new Map<string, { name: string; args?: Record<string, unknown> }>();
    const candidates: Candidate[] = [];
    let lastAssistant = -1;

    messages.forEach((raw, index) => {
        const message = raw as {
            role?: string;
            toolCallId?: string;
            isError?: boolean;
            details?: { noop?: boolean };
            content?: Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>;
        };
        if (message.role === "assistant") {
            lastAssistant = index;
            for (const block of message.content ?? []) {
                if (block.type === "toolCall" && block.id) {
                    calls.set(block.id, { name: block.name ?? "", args: block.arguments as Record<string, unknown> });
                }
            }
            return;
        }
        if (message.role !== "toolResult" || message.isError || !message.toolCallId) return;
        const call = calls.get(message.toolCallId);
        const path = call?.args?.path;
        if (!call || typeof path !== "string" || !TOOL_NAMES.has(call.name)) return;
        const args = call.args ?? {};
        candidates.push({
            index,
            toolCallId: message.toolCallId,
            path,
            key: resolveToCwd(path, cwd),
            kind: call.name as Candidate["kind"],
            noop: message.details?.noop === true,
            readKey: call.name === "read" ? `${args.offset ?? 1}/${args.limit ?? ""}/${args.raw === true}` : undefined,
        });
    });

    const stale = (candidate: Candidate): boolean =>
        candidates.some(
            (other) =>
                other.index > candidate.index &&
                other.key === candidate.key &&
                ((other.kind !== "read" && !other.noop) ||
                    (candidate.kind === "read" && other.kind === "read" && other.readKey === candidate.readKey)),
        );

    // A write result carries no anchors, so there is nothing to drop.
    return candidates
        .filter((candidate) => candidate.index < lastAssistant && candidate.kind !== "write" && stale(candidate))
        .map(({ toolCallId, path }) => ({ toolCallId, path }));
}

/** The cache lifetime pi uses for warming, from the model's retention tier. */
function cacheTtlMs(model: ExtensionContext["model"]): number {
    const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
    return (model?.promptCache?.[retention] ?? FALLBACK_TTL_SECONDS[retention]) * 1000;
}

function modelKey(model: ExtensionContext["model"]): string {
    return model ? `${model.provider}/${model.id}` : "";
}

export function registerPrune(pi: ExtensionAPI): void {
    // Sticky: an id pruned once stays pruned, so the prefix is stable across requests.
    const pruned = new Map<string, string>();
    let lastRequestAt = 0;
    let lastModelKey = "";
    let cacheInvalidated = false;

    // A new or switched session has no cache to protect, so start cold.
    const reset = () => {
        pruned.clear();
        lastRequestAt = 0;
        lastModelKey = "";
        cacheInvalidated = false;
    };

    pi.on("session_start", reset);
    pi.on("session_tree", reset);
    pi.on("session_compact", () => {
        cacheInvalidated = true;
    });
    pi.on("before_provider_request", (_event, ctx) => {
        lastRequestAt = Date.now();
        lastModelKey = modelKey(ctx.model);
        cacheInvalidated = false;
    });
    pi.on("cache_warming_decision", (event) => {
        if (event.action === "warm") lastRequestAt = Date.now();
    });

    pi.on("context", (event, ctx) => {
        const cold =
            cacheInvalidated ||
            modelKey(ctx.model) !== lastModelKey ||
            Date.now() - lastRequestAt >= cacheTtlMs(ctx.model);
        if (cold) {
            for (const item of superseded(event.messages, ctx.cwd)) {
                if (!pruned.has(item.toolCallId)) pruned.set(item.toolCallId, item.path);
            }
        }
        if (pruned.size === 0) return;

        let replaced = false;
        const messages = event.messages.map((message) => {
            const path = message.role === "toolResult" ? pruned.get(message.toolCallId) : undefined;
            if (path === undefined) return message;
            replaced = true;
            return { ...message, content: [{ type: "text" as const, text: placeholder(path) }] };
        });
        return replaced ? { messages } : undefined;
    });
}

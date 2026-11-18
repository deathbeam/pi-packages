/**
 * Superseded tool-result pruning: replaces tool results a later call made stale
 * with a one-line placeholder. New ids are only pruned while the prompt cache
 * is cold, so a live cached prefix never changes under the provider.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Gain } from "./gain.ts";

type Candidate = {
    index: number;
    toolCallId: string;
    /** Replacement text for the result. */
    text: string;
    /** Absolute path for file tools, `bash:<command>` for bash. */
    key: string;
    kind: "read" | "edit" | "write" | "bash";
    error: boolean;
    /** An edit with an empty diff changed nothing, so it supersedes nothing. */
    noop: boolean;
    /** Reads with identical arguments return identical text. */
    readKey?: string;
};

const FILE_TOOLS = new Set(["read", "edit", "write"]);

// The command stays visible in the tool call, so the placeholder need not repeat it.
const BASH_PLACEHOLDER = "[superseded: this exact command was run again later]";

function resolveToCwd(filePath: string, cwd: string): string {
    const normalized = filePath.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
    let path = normalized;
    if (normalized.startsWith("file://")) {
        try {
            path = fileURLToPath(normalized);
        } catch {
            // Not a valid file URL: treat it as a plain path.
        }
    }
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    return resolve(cwd, expanded);
}

export function placeholder(path: string): string {
    return `[superseded: ${path} changed or was re-read later; read again if needed]`;
}

function textLength(content: readonly unknown[]): number {
    let total = 0;
    for (const block of content as Array<{ type?: string; text?: string }>) {
        if (block.type === "text") total += block.text?.length ?? 0;
    }
    return total;
}

/**
 * The cache lifetime pi uses for warming, from the model's retention tier. Unknown means
 * never expire by time: pruning then waits for compaction, a model switch or a new session.
 */
function cacheTtlMs(model: ExtensionContext["model"]): number {
    const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
    return (model?.promptCache?.[retention] ?? Number.POSITIVE_INFINITY) * 1000;
}

function modelKey(model: ExtensionContext["model"]): string {
    return model ? `${model.provider}/${model.id}` : "";
}

/**
 * Tool results a later call made stale, excluding the most recent assistant
 * turn: the model still needs what it just asked for.
 *
 * - A read is stale after a later edit/write of the file or an identical re-read.
 * - An edit is stale after a later edit/write of the file.
 * - A failed file call is stale after any later successful call on the file.
 * - A bash result is stale after the exact same command runs again.
 */
export function superseded(messages: readonly unknown[], cwd: string): Array<{ toolCallId: string; text: string }> {
    const calls = new Map<string, { name: string; args?: Record<string, unknown> }>();
    const candidates: Candidate[] = [];
    let lastAssistant = -1;

    messages.forEach((raw, index) => {
        const message = raw as {
            role?: string;
            toolCallId?: string;
            isError?: boolean;
            details?: { diff?: unknown };
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
        if (message.role !== "toolResult" || !message.toolCallId) return;
        const call = calls.get(message.toolCallId);
        const args = call?.args ?? {};
        const base = { index, toolCallId: message.toolCallId, error: message.isError === true, noop: false };
        if (call?.name === "bash" && typeof args.command === "string") {
            candidates.push({ ...base, text: BASH_PLACEHOLDER, key: `bash:${args.command}`, kind: "bash" });
            return;
        }
        if (!call || typeof args.path !== "string" || !FILE_TOOLS.has(call.name)) return;
        candidates.push({
            ...base,
            text: placeholder(args.path),
            key: resolveToCwd(args.path, cwd),
            kind: call.name as Candidate["kind"],
            noop: message.details?.diff === "",
            readKey: call.name === "read" ? `${args.offset ?? 1}/${args.limit ?? ""}/${args.raw === true}` : undefined,
        });
    });

    function stale(candidate: Candidate): boolean {
        return candidates.some((other) => {
            if (other.index <= candidate.index || other.key !== candidate.key) return false;
            if (candidate.kind === "bash") return true;
            if (other.error) return false;
            if (candidate.error) return true;
            return (
                (other.kind !== "read" && !other.noop) ||
                (candidate.kind === "read" && other.kind === "read" && other.readKey === candidate.readKey)
            );
        });
    }

    // A successful write result carries no anchors, so there is nothing to drop.
    return candidates
        .filter(
            (candidate) =>
                candidate.index < lastAssistant &&
                !(candidate.kind === "write" && !candidate.error) &&
                stale(candidate),
        )
        .map(({ toolCallId, text }) => ({ toolCallId, text }));
}

export function registerPrune(pi: ExtensionAPI, gain: Gain): void {
    // Sticky: an id pruned once stays pruned, so the prefix is stable across requests.
    const pruned = new Map<string, string>();
    let lastRequestAt = 0;
    let lastModelKey = "";
    let cacheInvalidated = false;

    // A new or switched session has no cache to protect, so start cold.
    function reset(): void {
        pruned.clear();
        lastRequestAt = 0;
        lastModelKey = "";
        cacheInvalidated = false;
    }

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
        // Each request re-sends the whole transcript, so savings count only on the request that pruned the id.
        const newlyPruned = new Set<string>();
        if (cold) {
            for (const item of superseded(event.messages, ctx.cwd)) {
                if (pruned.has(item.toolCallId)) continue;
                pruned.set(item.toolCallId, item.text);
                newlyPruned.add(item.toolCallId);
            }
        }
        if (pruned.size === 0) return;

        let replaced = false;
        let savedChars = 0;
        const messages = event.messages.map((message) => {
            if (message.role !== "toolResult") return message;
            const text = pruned.get(message.toolCallId);
            if (text === undefined) return message;
            replaced = true;
            if (newlyPruned.has(message.toolCallId)) savedChars += textLength(message.content) - text.length;
            return { ...message, content: [{ type: "text" as const, text }] };
        });
        if (!replaced) return;
        if (savedChars > 0) gain.record("prune", Math.round(savedChars / 4)); // Estimated at 4 chars per token.
        return { messages };
    });
}

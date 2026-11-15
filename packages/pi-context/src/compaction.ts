/** `context.compaction`: compact with a cheaper model than the session's. */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, SettingsManager, compact, getAgentDir } from "@earendil-works/pi-coding-agent";

function compactionSetting(file: string): string | undefined {
    try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"))?.context?.compaction;
        return typeof value === "string" && value ? value : undefined;
    } catch {
        return undefined;
    }
}

/** `context.compaction` as "provider/model-id[:thinking]"; project settings override global ones. */
export function readCompactionModel(cwd: string) {
    const value =
        compactionSetting(path.join(cwd, CONFIG_DIR_NAME, "settings.json")) ??
        compactionSetting(path.join(getAgentDir(), "settings.json"));
    if (!value) return undefined;
    // Same `:<thinking>` suffix pi's --model takes; only known levels split, so ids like `llama3:8b` stay whole.
    const match = /^(.*):(off|minimal|low|medium|high|xhigh|max)$/.exec(value);
    const ref = match ? match[1] : value;
    // A value without "provider/" gets an empty provider, so it fails model lookup like any unknown model.
    const slash = ref.indexOf("/");
    return { value, provider: slash > 0 ? ref.slice(0, slash) : "", id: ref.slice(slash + 1), thinking: match?.[2] };
}

function notify(ctx: ExtensionContext, message: string) {
    if (ctx.hasUI) ctx.ui.notify(`${message}; using the session model`, "warning");
}

export function registerCompaction(pi: ExtensionAPI): void {
    pi.on("session_before_compact", async (event, ctx) => {
        const ref = readCompactionModel(ctx.cwd);
        if (!ref) return;
        const model = ctx.modelRegistry.find(ref.provider, ref.id);
        if (!model) return notify(ctx, `context.compaction "${ref.value}" does not resolve to a known model`);
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) return notify(ctx, `context.compaction "${ref.value}": ${auth.error}`);
        try {
            const compaction = await compact(
                event.preparation,
                auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
                auth.apiKey,
                auth.headers as Record<string, string> | undefined, // null entries unset headers; pi forwards them as-is
                event.customInstructions,
                event.signal,
                (ref.thinking ?? pi.getThinkingLevel()) as Parameters<typeof compact>[6],
                undefined,
                auth.env,
                // pi's own resolved retry policy: same defaults and settings as its compaction path.
                SettingsManager.inMemory(pi.getSettings()).getRetrySettings(),
            );
            return { compaction };
        } catch (error) {
            if (!event.signal.aborted) notify(ctx, `Compaction with ${ref.value} failed: ${(error as Error).message}`);
        }
    });
}

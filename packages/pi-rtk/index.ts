import type { BashToolCallEvent, ExecResult, ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

const isBash = (event: ToolCallEvent): event is BashToolCallEvent => event.toolName === "bash";

// Text `rtk init` writes to CLAUDE.md (rtk-instructions v2), minus its "# Command output" heading.
export const RTK_PROMPT = `Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as \`rtk bypass <cmd>\` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.`;

export function rewrittenCommand(result: ExecResult): string | null {
    if (result.killed || (result.code !== 0 && result.code !== 3)) return null;
    return result.stdout.trim() || null;
}

export default async function (pi: ExtensionAPI) {
    if ((await pi.exec("rtk", ["gain", "--help"]).catch(() => null))?.code !== 0) return;

    pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.sections.command_output = RTK_PROMPT;
    });

    pi.on("tool_call", async (event, ctx) => {
        if (!isBash(event)) return;
        try {
            const result = await pi.exec("rtk", ["rewrite", event.input.command], {
                timeout: 2_000,
                signal: ctx.signal,
            });
            const rewritten = rewrittenCommand(result);
            if (rewritten) event.input.command = rewritten;
        } catch {}
    });

    pi.registerCommand("rtk", {
        description: "Show RTK token savings (rtk gain)",
        handler: async (_args, ctx) => {
            const result = await pi.exec("rtk", ["gain"], { timeout: 10_000 });
            if (result.code !== 0) {
                ctx.ui.notify(`rtk gain failed: ${result.stderr.trim() || `exit ${result.code}`}`, "error");
                return;
            }
            pi.appendEntry("rtk-gain", result.stdout.trim());
        },
    });

    pi.registerEntryRenderer("rtk-gain", (entry) => ({
        render: () => String(entry.data ?? "").split("\n"),
        invalidate: () => {},
    }));
}

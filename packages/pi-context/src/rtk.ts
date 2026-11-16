import { type ExecResult, type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { type Gain, format } from "./gain.ts";

type RtkSummary = { total_commands: number; total_saved: number; avg_savings_pct: number };

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

async function rtkSummary(pi: ExtensionAPI, args: string[]): Promise<RtkSummary | null> {
    try {
        const result = await pi.exec("rtk", ["gain", ...args, "-f", "json"], { timeout: 5_000 });
        if (result.killed || result.code !== 0) return null;
        return (JSON.parse(result.stdout) as { summary?: RtkSummary }).summary ?? null;
    } catch {
        return null;
    }
}

function rtkLine(label: string, summary: RtkSummary | null): string {
    if (!summary) return `  ${label}: not available`;
    return `  ${label}: ${format(summary.total_commands)} commands, ${format(summary.total_saved)} tokens saved (${summary.avg_savings_pct.toFixed(1)}%)`;
}

export async function registerRtk(pi: ExtensionAPI, gain: Gain): Promise<void> {
    // A hung rtk must not stall extension load, so the probe has a deadline; a killed probe counts as absent.
    const probe = await pi.exec("rtk", ["rewrite", "--help"], { timeout: 2_000 });
    if (probe.killed || probe.code !== 0) return;

    // Only registered when rtk is present, so a failure here is a broken rtk, not a missing one.
    gain.report("rtk", async () => {
        const [global, project] = await Promise.all([rtkSummary(pi, []), rtkSummary(pi, ["-p"])]);
        return [rtkLine("global", global), rtkLine("project", project)];
    });

    pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.sections.command_output = RTK_PROMPT;
    });

    pi.on("tool_call", async (event, ctx) => {
        // Already in RTK form: nothing to rewrite, so skip the subprocess.
        if (!isToolCallEventType("bash", event) || event.input.command.startsWith("rtk ")) return;
        try {
            const result = await pi.exec("rtk", ["rewrite", event.input.command], {
                timeout: 2_000,
                signal: ctx.signal,
            });
            // Exit 2 with a message is an rtk rule denying the command: block it with that message.
            if (!result.killed && result.code === 2 && result.stdout.trim()) {
                return { block: true, reason: result.stdout.trim() };
            }
            const rewritten = rewrittenCommand(result);
            if (rewritten) event.input.command = rewritten;
        } catch {}
    });
}

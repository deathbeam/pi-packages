/** /gain — tokens saved per source, counted in-process and flushed to a jsonl file. */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

const GAIN_FILE = "pi-context-gain.jsonl";

type GainEntry = { cwd: string; source: string; tokens: number };

export type Gain = {
    /** Tokens this process saved for a source. */
    record(source: string, tokens: number): void;
    /** A source that keeps its own stats: lines shown under a title. */
    report(title: string, lines: (ctx: ExtensionContext) => Promise<string[]>): void;
};

export function format(count: number): string {
    if (count < 1000) return String(Math.round(count));
    if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`;
    return `${(count / 1_000_000).toFixed(1)}M`;
}

/** A missing file means nothing was flushed; a line cut short by a crash is skipped. */
function readEntries(path: string): GainEntry[] {
    let text = "";
    try {
        text = readFileSync(path, "utf8");
    } catch {}
    return text.split("\n").flatMap((line) => {
        try {
            return [JSON.parse(line) as GainEntry];
        } catch {
            return [];
        }
    });
}

export function registerGain(pi: ExtensionAPI): Gain {
    const recorded = new Map<string, number>();
    const reports = new Map<string, (ctx: ExtensionContext) => Promise<string[]>>();

    // One line per source; O_APPEND keeps concurrent subagent writes from interleaving.
    pi.on("session_shutdown", (_event, ctx) => {
        for (const [source, tokens] of recorded) {
            if (tokens <= 0) continue;
            const entry = { time: Date.now(), cwd: ctx.cwd, source, tokens };
            appendFileSync(join(getAgentDir(), GAIN_FILE), `${JSON.stringify(entry)}\n`);
        }
        recorded.clear();
    });

    pi.registerCommand("gain", {
        description: "Show tokens saved",
        handler: async (_args, ctx) => {
            const entries = readEntries(join(getAgentDir(), GAIN_FILE));
            const flushed = (source: string, cwd?: string) =>
                entries
                    .filter((entry) => entry.source === source && (!cwd || entry.cwd === cwd))
                    .reduce((total, entry) => total + entry.tokens, 0);
            const totals = [...new Set([...recorded.keys(), ...entries.map((entry) => entry.source)])].map((source) => {
                const session = recorded.get(source) ?? 0;
                const project = session + flushed(source, ctx.cwd);
                return `${source}: session ${format(session)}, project ${format(project)}, all ${format(session + flushed(source))} tokens`;
            });
            const sections = await Promise.all(
                [...reports].map(async ([title, report]) => [
                    title,
                    ...(await report(ctx).catch(() => ["  not available"])),
                ]),
            );
            ctx.ui.notify([...totals, ...sections.flat()].join("\n"), "info");
        },
    });

    return {
        record: (source, tokens) => recorded.set(source, (recorded.get(source) ?? 0) + tokens),
        report: (title, lines) => void reports.set(title, lines),
    };
}

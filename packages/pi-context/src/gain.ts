/** /gain — tokens saved per source, counted in-process and flushed to a jsonl file. */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

export type Gain = {
    /** Tokens this process saved for a source. */
    record(source: string, tokens: number): void;
    /** A source that keeps its own stats: its all-time token total. */
    report(source: string, total: () => Promise<number>): void;
};

type GainEntry = { source: string; tokens: number };

const GAIN_FILE = "pi-context-gain.jsonl";

function format(count: number): string {
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
    const reports = new Map<string, () => Promise<number>>();

    // One line per source; O_APPEND keeps concurrent subagent writes from interleaving.
    pi.on("session_shutdown", () => {
        for (const [source, tokens] of recorded) {
            if (tokens <= 0) continue;
            const entry = { time: Date.now(), source, tokens };
            appendFileSync(join(getAgentDir(), GAIN_FILE), `${JSON.stringify(entry)}\n`);
        }
        recorded.clear();
    });

    pi.registerCommand("gain", {
        description: "Show tokens saved",
        handler: async (_args, ctx) => {
            const totals = new Map<string, number | undefined>();
            for (const entry of readEntries(join(getAgentDir(), GAIN_FILE))) {
                totals.set(entry.source, (totals.get(entry.source) ?? 0) + entry.tokens);
            }
            for (const [source, tokens] of recorded) totals.set(source, (totals.get(source) ?? 0) + tokens);
            for (const [source, total] of reports) totals.set(source, await total().catch(() => undefined));
            const rows: Array<[string, number | undefined]> = [...totals];
            rows.push(["total", rows.reduce((sum, [, tokens]) => sum + (tokens ?? 0), 0)]);
            const width = Math.max(...rows.map(([name]) => name.length));
            const lines = rows.map(
                ([name, tokens]) => `  ${name.padEnd(width)}  ${tokens === undefined ? "n/a" : format(tokens)}`,
            );
            ctx.ui.notify(["Tokens saved", ...lines].join("\n"), "info");
        },
    });

    return {
        record: (source, tokens) => recorded.set(source, (recorded.get(source) ?? 0) + tokens),
        report: (source, total) => void reports.set(source, total),
    };
}

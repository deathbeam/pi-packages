import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, it } from "vitest";

// getAgentDir() is read when the command runs, so the temp agent dir only has to be set before mounting.
const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-render-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// A flat custom session dir: no per-project subdirectories, as with --session-dir.
const sessionDir = mkdtempSync(join(tmpdir(), "pi-usage-render-sessions-"));

initTheme("dark");

const { default: extension } = await import("../index.ts");

/** Colour stubs keep the frames readable; they never change a line's visible width. */
const theme: any = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
};

function sessionHeader(id: string, cwd: string): string {
    return JSON.stringify({ type: "session", version: 3, id, cwd });
}

function messageLine(provider: string, model: string, ts: number, cost: number, tokens: number): string {
    return JSON.stringify({
        type: "message",
        message: {
            role: "assistant",
            provider,
            model,
            timestamp: ts,
            usage: {
                input: tokens,
                output: Math.round(tokens / 10),
                cacheRead: Math.round(tokens / 2),
                cacheWrite: Math.round(tokens / 20),
                cost: { total: cost },
            },
        },
    });
}

/** Realistic corpus: many days, providers, models and projects, one very long model and a wide-char path. */
function writeSessions(): void {
    const dir = sessionDir;
    const projects = ["/home/deathbeam/git/pi-packages", "/tmp/日本語のプロジェクト", "/tmp/x"];
    const providers = ["anthropic", "openai", "google-gemini-cli"];
    const models = ["claude-opus-4-5-very-long-model-identifier", "gpt-5.1", "gemini-3-pro"];
    for (const [p, cwd] of projects.entries()) {
        const lines = [sessionHeader(`s${p}`, cwd)];
        for (let day = 0; day < 60; day++) {
            const ts = Date.now() - day * 86_400_000;
            lines.push(messageLine(providers[day % 3]!, models[day % 3]!, ts, 0.5 * day + 0.004, day * 1_000));
            lines.push(messageLine(providers[(day + 1) % 3]!, models[(day + 1) % 3]!, ts, day === 0 ? 1200 : 0.1, 500));
        }
        writeFileSync(join(dir, `s${p}.jsonl`), lines.join("\n"));
    }
}

type View = { render(width: number): string[]; handleInput(data: string): void };

function mount(): View {
    let view: View | undefined;
    let command: any;
    extension({ registerCommand: (_name: string, registered: any) => (command = registered) } as any);
    const keys = { matches: () => false };
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    const ui = {
        theme,
        custom(factory: any) {
            view = factory(tui, theme, keys, () => {});
            return new Promise(() => {}); // stays open: the harness drives render directly
        },
    };
    const ctx = {
        mode: "tui",
        sessionManager: { getSessionDir: () => sessionDir },
        ui,
    };
    void command.handler("", ctx);
    assert.ok(view, "custom factory mounted a component");
    return view!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The scan is async, so render until the component leaves the "Scanning" splash. */
async function loaded(view: View): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
        const lines = view.render(100);
        if (!lines.some((line) => line.includes("Scanning"))) return;
        await sleep(10);
    }
    throw new Error("usage scan did not finish");
}

function assertFits(view: View, width: number): void {
    const lines = view.render(width);
    assert.ok(lines.length <= 24, `width ${width}: rendered more lines than the terminal has`);
    for (const [i, line] of lines.entries()) {
        const actual = visibleWidth(line);
        assert.ok(actual <= width, `width ${width}: line ${i} is ${actual} wide: ${JSON.stringify(line)}`);
    }
}

beforeAll(() => writeSessions());

afterAll(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
});

describe("usage dashboard render", () => {
    it("keeps every line inside the width from 1 to 200", async () => {
        const view = mount();
        await loaded(view);
        const lines = view.render(80);
        assert.ok(!lines.some((line) => line.includes("No usage")), "the custom session dir was scanned");
        for (let width = 1; width <= 200; width++) assertFits(view, width);
    });

    it("survives a shrink and grow sequence between frames", async () => {
        const view = mount();
        await loaded(view);
        const widths = [200, 120, 80, 40, 20, 10, 5, 3, 2, 1, 1, 2, 5, 10, 20, 40, 80, 120, 200];
        for (const width of widths) assertFits(view, width);
    });
});

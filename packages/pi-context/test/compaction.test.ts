import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, it } from "vitest";
import { readCompactionModel } from "../src/compaction.ts";
import { agentDir, cleanup, fire, loadExtension, tempDir } from "./helpers.ts";

afterAll(cleanup);

const globalSettings = join(agentDir, "settings.json");
const cwds: string[] = [];

afterEach(() => {
    rmSync(globalSettings, { force: true });
});

afterAll(() => {
    for (const cwd of cwds) rmSync(cwd, { recursive: true, force: true });
});

/** A fresh cwd, so a settings file written by another test cannot leak in. */
function newCwd(): string {
    const cwd = tempDir("pi-context-project-");
    cwds.push(cwd);
    return cwd;
}

/** A project whose `.pi/settings.json` holds `<key>.compaction = value`. */
function project(value: string, key = "context"): string {
    const cwd = newCwd();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ [key]: { compaction: value } }));
    return cwd;
}

describe("context.compaction parsing", () => {
    it("splits provider, model id and thinking level", () => {
        assert.deepEqual(readCompactionModel(project("openrouter/google/gemini-flash:low")), {
            value: "openrouter/google/gemini-flash:low",
            provider: "openrouter",
            id: "google/gemini-flash",
            thinking: "low",
        });
        assert.deepEqual(readCompactionModel(project("ollama/llama3:8b")), {
            value: "ollama/llama3:8b",
            provider: "ollama",
            id: "llama3:8b",
            thinking: undefined,
        });
    });

    it("gives a value without a provider an empty provider", () => {
        assert.deepEqual(readCompactionModel(project("no-provider")), {
            value: "no-provider",
            provider: "",
            id: "no-provider",
            thinking: undefined,
        });
    });

    it("does not read the removed archive.compaction key", () => {
        assert.equal(readCompactionModel(project("openrouter/google/gemini-flash:low", "archive")), undefined);
    });
});

describe("settings lookup", () => {
    it("falls back to the global settings file", () => {
        writeFileSync(globalSettings, JSON.stringify({ context: { compaction: "openrouter/global/model:high" } }));
        assert.equal(readCompactionModel(newCwd())?.value, "openrouter/global/model:high");
    });

    it("lets project settings override the global file", () => {
        writeFileSync(globalSettings, JSON.stringify({ context: { compaction: "openrouter/global/model:high" } }));
        assert.equal(
            readCompactionModel(project("openrouter/project/model:low"))?.value,
            "openrouter/project/model:low",
        );
    });
});

describe("compaction with the configured model", () => {
    it("warns and keeps the session model when the model does not resolve", async () => {
        const cwd = project("openrouter/google/gemini-flash:low");
        const notices: Array<{ message: string; level: string }> = [];
        const { handlers } = await loadExtension();
        const outcome = await fire(
            handlers,
            "session_before_compact",
            { preparation: {}, customInstructions: undefined, signal: new AbortController().signal },
            {
                cwd,
                hasUI: true,
                ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
                modelRegistry: { find: () => undefined },
            },
        );
        assert.equal(outcome, undefined);
        assert.deepEqual(notices, [
            {
                level: "warning",
                message:
                    'context.compaction "openrouter/google/gemini-flash:low" does not resolve to a known model; using the session model',
            },
        ]);
    });
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { resolveModel } from "../src/agents.ts";
import { cleanup, packageRoot } from "./helpers.ts";

const agentFiles = readdirSync(join(packageRoot, "agents"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({ file, text: readFileSync(join(packageRoot, "agents", file), "utf8") }));

afterAll(cleanup);

describe("bundled agents", () => {
    it("ships the documented agent set", () => {
        const names = agentFiles.map(({ text }) => text.match(/^name:\s*(.+)$/m)?.[1]).sort();
        assert.deepEqual(names, ["explore", "general", "researcher", "reviewer"]);
    });

    // A typo like `cheap:hgh` would not split and fail every delegate of that agent at child launch.
    it("uses a model tier and isolation flag the resolver understands", () => {
        for (const { file, text } of agentFiles) {
            const model = text.match(/^model:\s*(\S+)/m)?.[1];
            if (model)
                assert.match(
                    model,
                    /^(cheap|balanced|strong)(:(off|minimal|low|medium|high|xhigh|max))?$/,
                    `${file} model "${model}"`,
                );
            const isolated = text.match(/^isolated:\s*(\S+)/m)?.[1];
            if (isolated) assert.match(isolated, /^(true|false)$/, `${file} isolated "${isolated}"`);
        }
    });
});

describe("resolveModel", () => {
    const session = { model: { provider: "anthropic", id: "m" }, thinkingLevel: "medium" } as any;

    // A `:<thinking>` suffix on the agent/param beats the tier suffix, which beats the session level.
    it("prefers the requested suffix over the tier and the session", () => {
        assert.deepEqual(resolveModel("anthropic/x", {}, session), {
            model: "anthropic/x",
            thinking: "medium",
            explicit: undefined,
        });
        assert.deepEqual(resolveModel("anthropic/x:high", {}, session), {
            model: "anthropic/x",
            thinking: "high",
            explicit: "high",
        });
        // Only known levels split, so colon-bearing ids stay whole.
        assert.deepEqual(resolveModel("ollama/llama3:8b", {}, session), {
            model: "ollama/llama3:8b",
            thinking: "medium",
            explicit: undefined,
        });
    });

    it("takes the tier model but keeps a requested thinking level", () => {
        assert.deepEqual(resolveModel("cheap", { cheap: "anthropic/h" }, session), {
            model: "anthropic/h",
            thinking: "medium",
            explicit: undefined,
        });
        assert.deepEqual(resolveModel("cheap", { cheap: "google/flash:low" }, session), {
            model: "google/flash",
            thinking: "low",
            explicit: "low",
        });
        assert.deepEqual(resolveModel("cheap:high", { cheap: "google/flash:low" }, session), {
            model: "google/flash",
            thinking: "high",
            explicit: "high",
        });
    });

    it("falls back to the session model for a missing or malformed tier", () => {
        assert.deepEqual(resolveModel("cheap:low", {}, session), {
            model: "anthropic/m",
            thinking: "low",
            explicit: "low",
        });
        assert.deepEqual(resolveModel("cheap", { cheap: { model: "x/y" } }, session), {
            model: "anthropic/m",
            thinking: "medium",
            explicit: undefined,
        });
        assert.deepEqual(resolveModel(undefined, {}, {} as any), {
            model: undefined,
            thinking: undefined,
            explicit: undefined,
        });
    });
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, it } from "vitest";
import { agentsFor, agentRoster, resolveModel, unresolvedAlias } from "../src/agents.ts";
import { agentDir, cleanup, packageRoot } from "./helpers.ts";

const agentFiles = readdirSync(join(packageRoot, "agents"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({ file, text: readFileSync(join(packageRoot, "agents", file), "utf8") }));

afterAll(cleanup);

describe("bundled agents", () => {
    it("ships the documented agent set", () => {
        const names = agentFiles.map(({ text }) => text.match(/^name:\s*(.+)$/m)?.[1]).sort();
        assert.deepEqual(names, ["explore", "general", "researcher", "reviewer"]);
    });

    // A typo like `cheap:hgh` would not split and would leave the alias unset.
    it("uses a model alias and isolation flag the resolver understands", () => {
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

describe("agent discovery", () => {
    const agentFile = (layer: string) => `---\nname: probe\ndescription: ${layer}\n---\n${layer} prompt\n`;
    const home = process.env.HOME;

    afterEach(() => {
        process.env.HOME = home;
    });

    it("lets each later layer shadow the same agent name", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-delegate-discovery-"));
        const project = join(root, "project");
        const cwd = join(project, "sub");
        const configured = join(root, "configured");
        const user = join(agentDir, "agents");
        const layers = [
            [join(project, ".agents", "agents"), "project-agents"],
            [join(cwd, ".pi", "agents"), "project-pi"],
            [user, "user-pi"],
        ] as const;
        try {
            for (const dir of [project + "/.git", cwd, ...layers.map(([dir]) => dir), configured])
                mkdirSync(dir, { recursive: true });
            for (const [dir, layer] of layers) writeFileSync(join(dir, "probe.md"), agentFile(layer));
            writeFileSync(join(configured, "probe.md"), agentFile("configured"));
            writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ delegate: { agentDirs: [configured] } }));
            const winner = (trusted?: boolean) =>
                agentsFor(cwd, trusted ?? true).find((agent) => agent.name === "probe")?.description;

            assert.equal(winner(), "configured");
            rmSync(configured, { recursive: true, force: true });
            assert.equal(winner(), "project-pi");
            assert.equal(winner(false), "user-pi");
            rmSync(join(cwd, ".pi", "agents"), { recursive: true, force: true });
            assert.equal(winner(), "project-agents");
            rmSync(join(project, ".agents"), { recursive: true, force: true });
            // The walk stops at the project's .git, so .agents/ above it is not a project layer.
            assert.equal(winner(), "user-pi");
            assert.ok(
                agentsFor(cwd, true).some((agent) => agent.name === "explore"),
                "bundled agents still load",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(user, { recursive: true, force: true });
        }
    });

    it("prefers the pi agent dir over ~/.agents", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-delegate-home-"));
        const user = join(agentDir, "agents");
        try {
            process.env.HOME = root;
            mkdirSync(join(root, ".agents", "agents"), { recursive: true });
            mkdirSync(user, { recursive: true });
            writeFileSync(join(root, ".agents", "agents", "probe.md"), agentFile("home-agents"));
            writeFileSync(join(user, "probe.md"), agentFile("pi-agent-dir"));
            const winner = () => agentsFor(root, true).find((agent) => agent.name === "probe")?.description;

            assert.equal(winner(), "pi-agent-dir");
            rmSync(join(user, "probe.md"));
            assert.equal(winner(), "home-agents");
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(user, { recursive: true, force: true });
        }
    });
});

describe("agent roster", () => {
    it("shows each agent's model and isolation, and lists the configured and agent-named aliases", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-delegate-roster-"));
        const settings = join(agentDir, "settings.json");
        try {
            // A .git stops the project-layer walk, so the roster holds only the bundled and this agent dir.
            mkdirSync(join(root, ".git"), { recursive: true });
            writeFileSync(
                join(root, "aliased.md"),
                "---\nname: aliased\ndescription: cheap one\nmodel: cheap\n---\np\n",
            );
            writeFileSync(
                join(root, "raw.md"),
                "---\nname: raw\ndescription: raw model\nmodel: provider/id\nisolated: true\n---\np\n",
            );
            writeFileSync(
                settings,
                JSON.stringify({ delegate: { agentDirs: [root], models: { configured: "anthropic/h" } } }),
            );
            const roster = agentRoster(root, true);
            assert.match(roster, /^- aliased: cheap one\n  model: cheap; tools: session tools$/m);
            assert.match(roster, /^- raw: raw model\n  model: provider\/id; tools: session tools; isolated: true$/m);
            const aliases = roster.split("\n").find((line) => line.startsWith("Model aliases"));
            assert.match(aliases!, /\bconfigured\b/);
            assert.match(aliases!, /\bcheap\b/);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(settings, { force: true });
        }
    });
});

describe("resolveModel", () => {
    const session = { model: { provider: "anthropic", id: "m" }, thinkingLevel: "medium" } as any;

    // A `:<thinking>` suffix on the agent/param beats the alias suffix, which beats the session level.
    it("prefers the requested suffix over the alias and the session", () => {
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

    // Any key in `models` is an alias; no name is special.
    it("resolves a configured alias of any name, keeping a requested thinking level", () => {
        assert.deepEqual(resolveModel("fast", { fast: "anthropic/h" }, session), {
            model: "anthropic/h",
            thinking: "medium",
            explicit: undefined,
        });
        assert.deepEqual(resolveModel("fast", { fast: "google/flash:low" }, session), {
            model: "google/flash",
            thinking: "low",
            explicit: "low",
        });
        assert.deepEqual(resolveModel("fast:high", { fast: "google/flash:low" }, session), {
            model: "google/flash",
            thinking: "high",
            explicit: "high",
        });
    });

    // A provider prefix always means a literal id, even when a config key spells the same.
    it("passes a provider/model id through", () => {
        assert.deepEqual(resolveModel("anthropic/x", { "anthropic/x": "google/flash" }, session), {
            model: "anthropic/x",
            thinking: "medium",
            explicit: undefined,
        });
    });

    it("falls back to the session model for an unset or malformed alias", () => {
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

    it("names the alias an unset value falls back from", () => {
        assert.equal(unresolvedAlias("cheap", {}), "cheap");
        assert.equal(unresolvedAlias("cheap:low", { cheap: "anthropic/h" }), undefined);
        assert.equal(unresolvedAlias("anthropic/x", {}), undefined);
        assert.equal(unresolvedAlias(undefined, {}), undefined);
    });
});

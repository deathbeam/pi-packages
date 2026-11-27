import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    CONFIG_DIR_NAME,
    getAgentDir,
    hasTrustRequiringProjectResources,
    parseFrontmatter,
    ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";

export type AgentFile = {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    isolated?: boolean;
    prompt: string;
};

type DelegateConfig = {
    agentDirs?: unknown;
    models?: Record<string, unknown>;
};

const BUNDLED_AGENT_DIR = fileURLToPath(new URL("../agents", import.meta.url));

function expandPath(value: string, cwd: string): string {
    return resolve(cwd, value.replace(/^~(?=\/|$)/, homedir()));
}

function stringList(value: unknown): string[] {
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
}

function readConfig(path: string): DelegateConfig {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object") return {};
        const delegate = (parsed as { delegate?: unknown }).delegate;
        return delegate && typeof delegate === "object" ? (delegate as DelegateConfig) : {};
    } catch {
        return {};
    }
}

function loadAgents(dir: string): AgentFile[] {
    if (!existsSync(dir)) return [];
    const agents: AgentFile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
        try {
            const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
                readFileSync(join(dir, entry.name), "utf8"),
            );
            if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
            agents.push({
                name: frontmatter.name,
                description: frontmatter.description,
                tools: stringList(frontmatter.tools),
                model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
                isolated: typeof frontmatter.isolated === "boolean" ? frontmatter.isolated : undefined,
                prompt: body.trim(),
            });
        } catch {
            // One malformed agent file should not disable delegation.
        }
    }
    return agents;
}

/** pi's user skill dirs (`<agentDir>/skills` then `~/.agents/skills`) with `agents` for `skills`. */
function userAgentDirs(): string[] {
    // Reversed: pi loads `<agentDir>` first, so it wins.
    return [join(homedir(), ".agents", "agents"), join(getAgentDir(), "agents")];
}

/** pi's project skill dirs: `<cwd>/.pi/skills` plus `.agents/skills` from cwd up to the git root. */
function projectAgentDirs(cwd: string): string[] {
    const agentsDirs: string[] = [];
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
        agentsDirs.unshift(join(dir, ".agents", "agents"));
        if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
    }
    // Same reversal: pi loads .pi first.
    return [...agentsDirs, join(cwd, CONFIG_DIR_NAME, "agents")];
}

// Later dirs win; same order as pi's skill discovery.
function discoverAgents(cwd: string, configuredDirs: unknown, trusted: boolean): AgentFile[] {
    const dirs = [
        BUNDLED_AGENT_DIR,
        ...userAgentDirs(),
        ...(trusted ? projectAgentDirs(cwd) : []),
        ...stringList(configuredDirs),
    ].map((dir) => expandPath(dir, cwd));
    const agents = new Map<string, AgentFile>();
    for (const dir of [...new Set(dirs)]) {
        for (const agent of loadAgents(dir)) agents.set(agent.name, agent);
    }
    return [...agents.values()];
}

export function agentsFor(cwd: string, trusted: boolean): AgentFile[] {
    return discoverAgents(cwd, configFor(cwd, trusted).agentDirs, trusted);
}

export function agentByName(cwd: string, name: string, trusted: boolean): AgentFile {
    const agents = agentsFor(cwd, trusted);
    const agent = agents.find((candidate) => candidate.name === name);
    if (!agent) {
        const names = agents.map((candidate) => candidate.name).join(", ") || "(none)";
        throw new Error(`Unknown agent "${name}". Available agents: ${names}.`);
    }
    return agent;
}

/** pi's rule without a ctx: a stored decision, else trusted unless project resources need gating. */
export function projectTrusted(cwd: string): boolean {
    return new ProjectTrustStore(getAgentDir()).get(cwd) ?? !hasTrustRequiringProjectResources(cwd);
}

export function configFor(cwd: string, trusted: boolean): DelegateConfig {
    const global = readConfig(join(getAgentDir(), "settings.json"));
    // pi ignores project settings in an untrusted project.
    const project = trusted ? readConfig(join(cwd, CONFIG_DIR_NAME, "settings.json")) : {};
    return {
        agentDirs: [...stringList(global.agentDirs), ...stringList(project.agentDirs)],
        models: { ...(global.models ?? {}), ...(project.models ?? {}) },
    };
}

/** The roster the orchestrator's system prompt lists; see the `before_agent_start` hook in index.ts. */
export function agentRoster(cwd: string, trusted: boolean): string {
    const agents = agentsFor(cwd, trusted);
    const lines = [
        "Available agents for the delegate tool:",
        ...agents.flatMap((agent) => {
            const facts = [
                `model: ${agent.model ?? "session model"}`,
                `tools: ${agent.tools?.length ? agent.tools.join(", ") : "session tools"}`,
            ];
            if (agent.isolated) facts.push("isolated: true");
            return [`- ${agent.name}: ${agent.description}`, `  ${facts.join("; ")}`];
        }),
    ];
    const aliases = [
        ...new Set([
            ...Object.keys(configFor(cwd, trusted).models ?? {}),
            ...agents.flatMap((agent) => (agent.model && !/[/:]/.test(agent.model) ? [agent.model] : [])),
        ]),
    ];
    if (aliases.length) lines.push("", `Model aliases (accepted by the \`model\` parameter): ${aliases.join(", ")}.`);
    return lines.join("\n");
}

// Same `:<thinking>` suffix pi's --model takes; only known levels split, so ids like `llama3:8b` stay whole.
function splitThinking(value: string): { model: string; thinking?: string } {
    const match = /^(.*):(off|minimal|low|medium|high|xhigh|max)$/.exec(value);
    return match ? { model: match[1], thinking: match[2] } : { model: value };
}

/** The configured provider/model for an alias name; an id with a provider prefix is never an alias. */
function configuredAlias(name: string, models: Record<string, unknown>): string | undefined {
    const value = name.includes("/") ? undefined : models[name];
    return typeof value === "string" && value ? value : undefined;
}

// Precedence: requested `:<thinking>` suffix, then the alias suffix, then the session level.
// `explicit` is the level the request names outright; undefined means it only inherits the session level.
export function resolveModel(
    value: string | undefined,
    models: Record<string, unknown>,
    ctx: Pick<ExtensionContext, "model" | "thinkingLevel">,
): { model?: string; thinking?: string; explicit?: string } {
    const split = splitThinking(value ?? "");
    const thinking = split.thinking ?? ctx.thinkingLevel;
    const configured = configuredAlias(split.model, models);
    if (configured) {
        const alias = splitThinking(configured);
        const explicit = split.thinking ?? alias.thinking;
        return { model: alias.model, thinking: explicit ?? ctx.thinkingLevel, explicit };
    }
    // A provider/model id is literal; an unset alias falls back to the session model.
    if (split.model.includes("/")) return { model: split.model, thinking, explicit: split.thinking };
    return {
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinking,
        explicit: split.thinking,
    };
}

/** An alias name the config leaves unset; resolution then falls back to the session model. */
export function unresolvedAlias(value: string | undefined, models: Record<string, unknown>): string | undefined {
    const name = splitThinking(value ?? "").model;
    return name && !name.includes("/") && !configuredAlias(name, models) ? name : undefined;
}

export function contextWindowFor(ctx: ExtensionContext, model: string | undefined): number | undefined {
    const separator = model?.indexOf("/") ?? -1;
    if (!model || separator < 0) return undefined;
    return ctx.modelRegistry.find(model.slice(0, separator), model.slice(separator + 1))?.contextWindow;
}

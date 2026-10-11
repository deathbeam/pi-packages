import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

type AgentFile = {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    prompt: string;
};

type DelegateConfig = {
    agentDirs?: unknown;
    models?: Record<string, unknown>;
};

const DEFAULT_AGENT_DIR = "~/.agents/agents";
const BUNDLED_AGENT_DIR = fileURLToPath(new URL("./agents", import.meta.url));
const MODEL_TIERS = new Set(["cheap", "balanced", "strong"]);

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

export function configFor(cwd: string): DelegateConfig {
    const global = readConfig(join(getAgentDir(), "settings.json"));
    const project = readConfig(join(cwd, CONFIG_DIR_NAME, "settings.json"));
    return {
        agentDirs: [...stringList(global.agentDirs), ...stringList(project.agentDirs)],
        models: { ...(global.models ?? {}), ...(project.models ?? {}) },
    };
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
                prompt: body.trim(),
            });
        } catch {
            // One malformed agent file should not disable delegation.
        }
    }
    return agents;
}

export function discoverAgents(cwd: string, configuredDirs: unknown): AgentFile[] {
    const dirs = [BUNDLED_AGENT_DIR, DEFAULT_AGENT_DIR, ...stringList(configuredDirs)].map((dir) =>
        expandPath(dir, cwd),
    );
    const agents = new Map<string, AgentFile>();
    for (const dir of [...new Set(dirs)]) {
        for (const agent of loadAgents(dir)) agents.set(agent.name, agent);
    }
    return [...agents.values()];
}

// Same `:<thinking>` suffix pi's --model takes; only known levels split, so ids like `llama3:8b` stay whole.
function splitThinking(value: string): { model: string; thinking?: string } {
    const match = /^(.*):(off|minimal|low|medium|high|xhigh|max)$/.exec(value);
    return match ? { model: match[1], thinking: match[2] } : { model: value };
}

// Precedence: requested `:<thinking>` suffix, then the tier suffix, then the session level.
export function resolveModel(
    value: string | undefined,
    models: Record<string, unknown>,
    ctx: Pick<ExtensionContext, "model" | "thinkingLevel">,
): { model?: string; thinking?: string } {
    const split = splitThinking(value ?? "");
    const thinking = split.thinking ?? ctx.thinkingLevel;
    if (split.model && !MODEL_TIERS.has(split.model)) return { model: split.model, thinking };
    const configured = models[split.model];
    if (typeof configured === "string" && configured) {
        const tier = splitThinking(configured);
        return { model: tier.model, thinking: split.thinking ?? tier.thinking ?? ctx.thinkingLevel };
    }
    return { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking };
}

export function contextWindowFor(ctx: ExtensionContext, model: string | undefined): number | undefined {
    const separator = model?.indexOf("/") ?? -1;
    if (!model || separator < 0) return undefined;
    return ctx.modelRegistry.find(model.slice(0, separator), model.slice(separator + 1))?.contextWindow;
}

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
    thinking?: string;
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
                thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
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

export function resolveModel(
    value: string | undefined,
    models: Record<string, unknown>,
    current: ExtensionContext["model"],
): { model?: string; thinking?: string } {
    if (value && !MODEL_TIERS.has(value)) return { model: value };
    const configured = value ? models[value] : undefined;
    const entry =
        configured && typeof configured === "object"
            ? (configured as { model?: unknown; thinking?: unknown })
            : undefined;
    const model = typeof configured === "string" ? configured : typeof entry?.model === "string" ? entry.model : "";
    // Tier thinking only applies when the model itself came from the tier entry.
    if (model) return { model, thinking: typeof entry?.thinking === "string" ? entry.thinking : undefined };
    return { model: current ? `${current.provider}/${current.id}` : undefined };
}

export function contextWindowFor(ctx: ExtensionContext, model: string | undefined): number | undefined {
    const separator = model?.indexOf("/") ?? -1;
    if (!model || separator < 0) return undefined;
    return ctx.modelRegistry.find(model.slice(0, separator), model.slice(separator + 1))?.contextWindow;
}

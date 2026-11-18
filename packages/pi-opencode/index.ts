import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type FreeModel = { provider: string; id: string; api: string };

const CLI_VERSION = "1.19.0";
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// Zen's free lane answers a request without these names with 429 FreeUsageLimitError.
const GATE_TOOLS = ["bash", "edit", "glob", "grep", "read"].map((name) => ({
    type: "function",
    function: {
        name,
        description: `${name} (not available in this request)`,
        parameters: { type: "object", properties: {} },
    },
}));

let lastMs = 0;
let counter = 0;

// OpenCode ids are ULIDs: 12 hex timestamp chars then 14 base62 chars. Sessions use the
// inverted timestamp, requests the forward one.
function generatedId(descending: boolean): string {
    const now = Date.now();
    if (now !== lastMs) {
        lastMs = now;
        counter = 0;
    }
    counter += 1;
    const value = BigInt(now) * 0x1000n + BigInt(counter);
    const stamped = descending ? ~value : value;
    const timestamp = Array.from({ length: 6 }, (_, index) =>
        Number((stamped >> BigInt(40 - 8 * index)) & 0xffn)
            .toString(16)
            .padStart(2, "0"),
    ).join("");
    return timestamp + Array.from(randomBytes(14), (byte) => ID_CHARS[byte % ID_CHARS.length]).join("");
}

function isFreeModel(model: FreeModel): boolean {
    return model.provider === "opencode" && (model.id === "big-pickle" || model.id.endsWith("-free"));
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// HTTP header names are case-insensitive, but a duplicate key would send both values.
function setHeader(headers: Record<string, string | null>, name: string, value: string): void {
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key !== name && key.toLowerCase() === lower) delete headers[key];
    }
    headers[name] = value;
}

export default function (pi: ExtensionAPI): void {
    // Zen keeps one free-lane session per OpenCode process and one request id per call.
    const sessions = new Map<string, string>();

    pi.on("before_provider_headers", (event, ctx) => {
        const model = ctx.model;
        if (!model || !isFreeModel(model)) return;

        setHeader(event.headers, "User-Agent", `opencode/${CLI_VERSION}`);
        setHeader(event.headers, "x-opencode-client", "cli");
        setHeader(event.headers, "x-opencode-project", "global");
        const session = ctx.sessionManager.getSessionId();
        let id = sessions.get(session);
        if (!id) {
            id = `ses_${generatedId(true)}`;
            sessions.set(session, id);
        }
        setHeader(event.headers, "x-opencode-session", id);
        setHeader(event.headers, "x-opencode-request", `msg_${generatedId(false)}`);
    });

    pi.on("before_provider_request", (event, ctx) => {
        const model = ctx.model;
        if (!model || !isFreeModel(model) || model.api !== "openai-completions") return;
        if (!isObject(event.payload)) return;
        const tools: Array<{ function?: { name?: string } }> = Array.isArray(event.payload.tools)
            ? event.payload.tools
            : [];
        const declared = new Set(tools.map((tool) => tool.function?.name));
        const missing = GATE_TOOLS.filter((tool) => !declared.has(tool.function.name));
        if (missing.length === 0) return;
        // A tool-less request (e.g. a title or summary) must not start calling the stand-ins.
        return { ...event.payload, tools: [...tools, ...missing], ...(tools.length === 0 && { tool_choice: "none" }) };
    });
}

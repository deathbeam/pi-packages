import { randomBytes, randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CLI_NAME = "vibe_rs";
const CLI_VERSION = "3.1.4";
const CALL_SOURCE = "vibe_code";
const HOST_KIND = "local";
const PLATFORM_IDS: Record<string, string> = {
    win32: "windows",
    darwin: "darwin",
    linux: "linux",
    freebsd: "freebsd",
    openbsd: "openbsd",
    netbsd: "netbsd",
};

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

function newSessionId(): string {
    const head = randomBytes(10).toString("hex");
    const tail = randomBytes(6).toString("hex");
    return `${head.slice(0, 8)}-${head.slice(8, 12)}-${head.slice(12, 16)}-${head.slice(16, 20)}-${tail}`;
}

function machine(): string {
    switch (arch()) {
        case "x64":
            return platform() === "win32" ? "amd64" : "x86_64";
        case "arm64":
            return platform() === "linux" ? "aarch64" : "arm64";
        default:
            return arch();
    }
}

// shortcut: os_version is the kernel release, use the distro VERSION_ID if it ever matters.
function requestMetadata(session_id: string): Record<string, string> {
    return {
        os: PLATFORM_IDS[platform()] ?? platform(),
        arch: machine(),
        os_version: release(),
        version: CLI_VERSION,
        session_id,
        message_id: randomUUID(),
        agent_entrypoint: "cli",
        agent_version: CLI_VERSION,
        client_name: CLI_NAME,
        client_version: CLI_VERSION,
        terminal_emulator: "unknown",
        call_type: "main_call",
        call_source: CALL_SOURCE,
        host_kind: HOST_KIND,
    };
}

export default function (pi: ExtensionAPI): void {
    const sessions = new Map<string, string>();

    const affinity = (ctx: ExtensionContext): string => {
        const piSession = ctx.sessionManager.getSessionId();
        let session = sessions.get(piSession);
        if (!session) {
            session = newSessionId();
            sessions.set(piSession, session);
        }
        return session;
    };

    pi.on("before_provider_headers", (event, ctx) => {
        const model = ctx.model;
        if (!model || model.provider !== "mistral") return;

        setHeader(event.headers, "User-Agent", `mistral-client-python/Mistral-Vibe/${CLI_VERSION}`);
        setHeader(event.headers, "x-affinity", affinity(ctx));
    });

    pi.on("before_provider_request", (event, ctx) => {
        const model = ctx.model;
        if (!model || model.provider !== "mistral") return;
        if (!isObject(event.payload)) return;

        return { ...event.payload, metadata: requestMetadata(affinity(ctx)) };
    });
}

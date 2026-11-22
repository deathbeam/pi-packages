import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { History } from "../src/inspector.ts";

// Hermetic: the pinned session dir reads PI_CODING_AGENT_DIR at module load, so set the temp dir first.
export const agentDir = mkdtempSync(join(tmpdir(), "pi-delegate-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

export const sessionDir = join(agentDir, "sessions", "delegates");
export const packageRoot = fileURLToPath(new URL("../", import.meta.url));

initTheme("dark");

const { default: extension } = await import("../index.ts");

export const keyHint = (_keybinding: string, description: string) => `«key»${description}`;

export const baseCtx: any = {
    cwd: packageRoot,
    hasUI: false,
    isProjectTrusted: () => true,
    model: { provider: "anthropic", id: "m" },
    modelRegistry: { find: () => ({ contextWindow: 1000000 }) },
    thinkingLevel: "off",
};

export function cleanup(): void {
    rmSync(agentDir, { recursive: true, force: true });
}

// A theme stub for the renderers: colors are recorded, never emitted.
export function themeStub() {
    const colors: string[] = [];
    const colored: [string, string][] = [];
    const backgrounds: string[] = [];
    const theme: any = {
        fg: (color: string, text: string) => {
            colors.push(color);
            colored.push([color, text]);
            return text;
        },
        bg: (color: string, text: string) => {
            backgrounds.push(color);
            return text;
        },
        bold: (text: string) => text,
    };
    return { theme, colors, colored, backgrounds };
}

export function fakeChild(): any {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
}

export function jobEntry(id: string, status: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        agent: "explore",
        description: "d",
        task: "t",
        model: "m",
        tools: [],
        toolCalls: 0,
        startedAt: 1,
        status,
        messages: [] as any[],
        ...extra,
    };
}

export async function withTimeout<T>(promise: Promise<T>, ms = 10000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>(
        (_, reject) => (timer = setTimeout(() => reject(new Error("delegate test timed out")), ms)),
    );
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

export function tempGitRepo(files: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "pi-delegate-git-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    if (Object.keys(files).length > 0) {
        git("add", ".");
        git("commit", "-q", "-m", "seed");
    }
    return { dir, git, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export type RegisteredExtension = {
    tools: any[];
    savedEntries: any[];
    messages: { message: any; options: any }[];
    inspect: any;
    renderReport: any;
    tool: (name: string) => any;
    nextMessage: () => Promise<{ message: any; options: any }>;
};

/** A stub of the ExtensionAPI members the extension registers, capturing what the model and the UI see. */
export function registerExtension(
    options: { activeTools?: string[]; on?: (event: string, handler: any) => void } = {},
): RegisteredExtension {
    const tools: any[] = [];
    const savedEntries: any[] = [];
    const messages: { message: any; options: any }[] = [];
    const waiters: ((entry: { message: any; options: any }) => void)[] = [];
    let inspect: any;
    let renderReport: any;
    extension({
        on: (event: string, handler: any) => options.on?.(event, handler),
        sendMessage(message: any, messageOptions: any) {
            const entry = { message, options: messageOptions };
            messages.push(entry);
            waiters.shift()?.(entry);
        },
        registerMessageRenderer(type: string, renderer: any) {
            if (type === "delegate-result") renderReport = renderer;
        },
        registerCommand(name: string, command: any) {
            if (name === "delegate") inspect = command;
        },
        registerTool(tool: any) {
            tools.push(tool);
        },
        getActiveTools: () => options.activeTools ?? ["read"],
        appendEntry: (customType: string, data: any) => savedEntries.push({ type: "custom", customType, data }),
    } as any);
    const tool = (name: string) => tools.find((entry) => entry.name === name);
    return {
        tools,
        savedEntries,
        messages,
        inspect,
        renderReport,
        tool,
        nextMessage: () => new Promise((resolve) => waiters.push(resolve)),
    };
}

export type OverlayState = {
    renders: number;
    screens: number;
    widgetLines: string[];
    notifications: string[];
    // What the last opened overlay looked like, read back by the tests that care about it.
    overlay?: {
        overlay?: boolean;
        overlayOptions?: unknown;
        height: number;
        historyWidths: { first: number[]; second: number[] };
    };
    onRender?: () => void;
    showViewer?: (view: any) => void;
};

const inspectorKeys: Record<string, string> = {
    "tui.select.cancel": "\x1b",
    "tui.select.up": "up",
    "tui.select.down": "down",
    "tui.altScreen.pageUp": "pageUp",
    "tui.altScreen.pageDown": "pageDown",
    "tui.altScreen.top": "ctrl+home",
    "tui.altScreen.bottom": "ctrl+end",
    "app.tools.expand": "ctrl+o",
};

/** A TUI stub that opens the inspector overlay and records widget repaints and frame measurements. */
export function overlayHarness(theme: any) {
    const state: OverlayState = { renders: 0, screens: 0, widgetLines: [], notifications: [] };
    const viewerReady = new Promise<any>((resolve) => (state.showViewer = resolve));
    const tui = {
        terminal: { rows: 24 },
        requestRender() {
            state.renders++;
            state.onRender?.();
            state.onRender = undefined;
        },
    };
    const ui = {
        theme,
        notify(message: string) {
            state.notifications.push(message);
        },
        setWidget(_key: string, lines: any) {
            state.widgetLines = typeof lines === "function" ? lines(undefined, theme).render(500) : (lines as string[]);
            // Pi repaints the widgets on every setWidget, so the ticker also redraws an open overlay.
            tui.requestRender();
        },
        async custom(factory: any, options: any) {
            let close: (value?: unknown) => void;
            const closed = new Promise((resolve) => (close = resolve));
            // HStack measured its children at the full width first, so a frame that renders its history at more
            // than one width re-renders every transcript row. Measure each frame instead of assuming one.
            const widths: number[] = [];
            const renderWindow = History.prototype.window;
            History.prototype.window = function (this: any, width: number, top?: number, height?: number) {
                widths.push(width);
                return (renderWindow as any).call(this, width, top, height);
            };
            let view: any;
            let height = 0;
            try {
                view = factory(
                    tui,
                    theme,
                    {
                        matches: (data: string, action: string) => inspectorKeys[action] === data,
                        getKeys: (action: string) => [inspectorKeys[action]],
                    },
                    close!,
                );
                height = view.render(80).length;
                widths.length = 0;
                view.render(80);
                const first = widths.splice(0);
                view.render(80);
                state.overlay = {
                    overlay: options?.overlay,
                    overlayOptions: options?.overlayOptions,
                    height,
                    historyWidths: { first, second: widths.splice(0) },
                };
            } finally {
                History.prototype.window = renderWindow;
            }
            state.screens++;
            state.showViewer!(view);
            return closed;
        },
    };
    return { tui, ui, viewerReady, state };
}

/** A fake pi child speaking the RPC protocol, so the extension can spawn a real process. */
function writeFakeCli(dir: string): string {
    const cli = join(dir, "pi.mjs");
    writeFileSync(
        cli,
        `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
const COMMANDS_LOG = '${join(dir, "commands.log")}';
const ARGV_LOG = '${join(dir, "argv.log")}';
const EMPTY_MARKER = '${join(dir, "empty")}';
appendFileSync(ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const argv = process.argv.slice(2);
const sessionId = argv[argv.indexOf("--session-id") + 1];
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
const sessionFile = sessionDir + "/" + new Date().toISOString().replace(/[:.]/g, "-") + "_" + sessionId + ".jsonl";
let parentId = null;
let entryId = 0;
// Persist the transcript like pi does, so finished jobs can be reloaded from their session file.
const record = (message) => {
    if (!sessionId || !sessionDir) return;
    mkdirSync(sessionDir, { recursive: true });
    if (entryId === 0) appendFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\\n");
    const id = "e" + ++entryId;
    appendFileSync(sessionFile, JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message }) + "\\n");
    parentId = id;
};
let stage = 0;
let promptMessage = "";
const send = (event) => {
    if (event.type === "message_end") record(event.message);
    process.stdout.write(JSON.stringify(event) + "\\n");
};
process.stdin.on("data", (data) => {
    for (const line of data.toString().trim().split("\\n")) {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
            send({ type: "response", command: "get_state", id: command.id, success: true, data: { messageCount: existsSync(EMPTY_MARKER) ? 0 : 5 } });
        } else if (command.type === "prompt") {
            promptMessage = command.message;
            send({ type: "response", command: "prompt", id: command.id, success: true });
            send({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message }], timestamp: Date.now() } });
            if (command.message.startsWith("revive")) {
                send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Revived and finished." }], timestamp: Date.now() } });
                send({ type: "agent_settled" });
            }
        } else if (command.type === "set_model" || command.type === "set_thinking_level") {
            appendFileSync(COMMANDS_LOG, command.type + " " + (command.provider || "") + " " + (command.modelId || command.level || "") + "\\n");
            send({ type: "response", command: command.type, id: command.id, success: command.provider !== "nope", error: command.provider === "nope" ? "Model not found: nope/x" : undefined });
        } else if (command.type === "steer") {
            // Real children stream tool calls inside assistant messages and their results as toolResult messages.
            const toolCall = (id, path) => {
                send({ type: "tool_execution_start", toolName: "read", args: { path } });
                send({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "ok" }] } });
                return { type: "toolCall", id, name: "read", arguments: { path } };
            };
            if (++stage === 1) {
                const calls = [];
                for (let i = 0; i < 105; i++) calls.push(toolCall("call" + i, "src/" + i + ".ts"));
                send({ type: "message_end", message: { role: "assistant", content: calls, timestamp: Date.now() } });
                for (let i = 0; i < 105; i++) {
                    send({ type: "message_end", message: { role: "toolResult", toolCallId: "call" + i, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() } });
                }
                send({ type: "message_update", usage: { totalTokens: 37000 } });
            } else {
                const call = toolCall("callEnd", "src/end.ts");
                send({ type: "message_end", message: { role: "assistant", content: [call], timestamp: Date.now() } });
                send({ type: "message_end", message: { role: "toolResult", toolCallId: "callEnd", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() } });
            }
            const message = { role: "user", content: stage === 1 ? command.message : [{ type: "text", text: command.message }], timestamp: Date.now() };
            send({ type: "message_start", message });
            send({ type: "message_end", message });
            if (stage === 2) send({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 37000 }, content: [{ type: "text", text: "## Done\\n\\n| Path | Count |\\n| --- | ---: |\\n| a.ts | 2 |" }] } });
            send({ type: "response", command: "steer", id: command.id, success: true });
            if (stage === 2) send({ type: "agent_settled" });
        } else if (command.type === "abort") {
            // A slow exit is the window in which apply or a revive that does not wait races this child's last write.
            const late = promptMessage === "late writer";
            setTimeout(() => {
                if (late) writeFileSync("late.txt", "late\\n");
                send({ type: "response", command: "abort", id: command.id, success: true });
                send({ type: "agent_settled", aborted: true });
            }, late || promptMessage === "close during revive" ? 300 : 0);
        }
    }
});
setTimeout(() => process.exit(1), 5000).unref();
`,
    );
    return cli;
}

/** A temp dir with the fake pi CLI, set as the process entrypoint so delegates spawn it. */
export function fakePi() {
    const dir = mkdtempSync(join(tmpdir(), "pi-delegate-fake-cli-"));
    const cli = writeFakeCli(dir);
    process.argv = [process.argv[0], cli];
    mkdirSync(sessionDir, { recursive: true });
    return { dir, cli, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The argv of every fake child spawned from this dir, oldest first. */
export function spawnedChildren(dir: string): string[][] {
    try {
        return readFileSync(join(dir, "argv.log"), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    } catch {
        return [];
    }
}

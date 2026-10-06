import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
    COLLAPSED_OUTPUT_LINES,
    formatDuration,
    formatTokens,
    jobLine,
    launchDetails,
    limitOutput,
    outputPreview,
    reportText,
    resultPreview,
    SPINNER_FRAMES,
    SPINNER_INTERVAL_MS,
    STATUS_COLORS,
    STATUS_ICONS,
    statusIcon,
    toolCallDetail,
    usageStats,
    widgetJobs,
    WIDGET_MAX_LINES,
} from "./format.ts";
import { runChild } from "./child.ts";

initTheme("dark");

const root = new URL("./", import.meta.url);
const index = readFileSync(new URL("index.ts", root), "utf8");
const child = readFileSync(new URL("child.ts", root), "utf8");

// Regex tripwires cannot see runtime syntax or protocol behavior, so compile and exercise both below.
const indexCheckDir = mkdtempSync(join(tmpdir(), "pi-delegate-index-check-"));
const indexCheckFile = join(indexCheckDir, "index.mjs");
writeFileSync(indexCheckFile, stripTypeScriptTypes(index, { mode: "strip" }));
try {
    execFileSync(process.execPath, ["--check", indexCheckFile], { stdio: "pipe" });
} finally {
    rmSync(indexCheckDir, { recursive: true, force: true });
}

// Tripwires for wiring the compiled-file check cannot see: the child protocol, the delivery path,
// and where the prompt text lives. Renderer behavior is exercised below, not matched against source text.
assert.match(index, /name: "delegate"/);
assert.match(index, /registerCommand\("delegate"/);
assert.match(index, /name: "delegate_list"/);
assert.match(index, /name: "delegate_steer"/);
assert.match(index, /name: "delegate_cancel"/);
const excluded = index.match(/const DELEGATION_TOOLS = new Set\(\[([\s\S]*?)\]\)/)?.[1];
assert.ok(excluded, "missing child delegation denylist");
assert.deepEqual([...excluded.matchAll(/"([^"]+)"/g)].map(([, name]) => name).sort(), [
    "delegate",
    "delegate_cancel",
    "delegate_list",
    "delegate_steer",
]);
assert.match(index, /!DELEGATION_TOOLS\.has\(tool\)/);
assert.match(index, /spawn\(process\.execPath, \[entrypoint, "--mode", "rpc", "--no-session/);
assert.match(index, /\["--model", model, "--tools", tools\.join\(","\)\]/);
assert.match(child, /case "agent_settled"/);
assert.match(child, /type: "steer", message/);
// pi skips before_agent_start in runs a delegate report starts, so a prompt section would vanish exactly then.
assert.doesNotMatch(index, /systemPromptOptions\.sections/);
assert.match(index, /registerMessageRenderer\(RESULT_MESSAGE/);
assert.match(index, /pi\.sendMessage\(/);
// A follow-up waits for a run end; a parent stuck polling never reaches one and the report is lost.
assert.match(index, /background: ctx\.hasUI/);
assert.match(index, /deliverAs: "steer"/);
assert.match(index, /setWidget\(WIDGET_KEY/);
// One status vocabulary; a glyph written into a view drifts out of sync with the others.
assert.doesNotMatch(index, /[✓✗●○]/);

const expected = ["explore", "general", "researcher", "reviewer"];
const agentFiles = readdirSync(new URL("agents/", root))
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({ file, text: readFileSync(new URL(`agents/${file}`, root), "utf8") }));
const names = agentFiles.map(({ text }) => text.match(/^name:\s*(.+)$/m)?.[1]).sort();
assert.deepEqual(names, expected);
assert.match(
    agentFiles.find(({ file }) => file === "reviewer.md").text,
    /caused or made reachable by the assigned change/,
);
// An invalid level makes every delegate of that agent fail at child launch, not at load.
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
for (const { file, text } of agentFiles) {
    const level = text.match(/^thinking:\s*(\S+)/m)?.[1];
    if (level) assert.ok(thinkingLevels.has(level), `${file} has invalid thinking level "${level}"`);
}

assert.ok(SPINNER_FRAMES.length > 1);
assert.deepEqual(Object.keys(STATUS_ICONS).sort(), ["cancelled", "done", "failed"]);
assert.deepEqual(Object.keys(STATUS_COLORS).sort(), ["cancelled", "done", "failed", "running"]);
assert.equal(statusIcon("running", 0), SPINNER_FRAMES[0]);
assert.equal(statusIcon("running", SPINNER_INTERVAL_MS), SPINNER_FRAMES[1]);
assert.equal(statusIcon("done", SPINNER_INTERVAL_MS), STATUS_ICONS.done);
assert.equal(launchDetails({ model: "x/y", tools: ["read", "ls"] }).join("\n"), "  Model: x/y\n  Tools: read, ls");
assert.deepEqual(launchDetails({ tools: [] }), ["  Model: default", "  Tools: none"]);
assert.deepEqual(outputPreview("a\nb", 5), { shown: ["a", "b"], hidden: 0 });
assert.deepEqual(outputPreview("a\nb\nc", 2), { shown: ["a", "b"], hidden: 1 });
assert.deepEqual(outputPreview("```\ncode\nmore", 2), { shown: ["```", "code", "```"], hidden: 1 });
assert.deepEqual(outputPreview("```\na\n```\nb", 3), { shown: ["```", "a", "```"], hidden: 1 });
assert.equal(formatTokens(900), "900");
assert.equal(formatTokens(1234), "1.2k");
assert.equal(formatTokens(200000), "200k");
assert.equal(formatDuration(42000), "42s");
assert.equal(formatDuration(65000), "1m 05s");
assert.equal(formatDuration(3720000), "1h 02m");
assert.equal(usageStats({}, 0), "0s");
assert.equal(usageStats({ toolCalls: 3, contextTokens: 2400, contextWindow: 200000 }, 42000), "2.4k/200k · 42s");
assert.equal(usageStats({ contextTokens: 2400 }, 1000), "2.4k · 1s");
assert.equal(toolCallDetail("bash", { command: "npm test\nsecond" }), "npm test");
assert.equal(toolCallDetail("read", { file_path: "src/a.ts" }), "src/a.ts");
assert.equal(toolCallDetail("edit", { path: "src/a.ts" }), "src/a.ts");
assert.equal(toolCallDetail("grep", { pattern: "foo", path: "src" }), "/foo/ in src");
assert.equal(toolCallDetail("ls", {}), ".");
assert.equal(toolCallDetail("bash", undefined), "");
assert.equal(resultPreview({ content: [{ type: "text", text: "\n  12 passing\n" }] }), "12 passing");
assert.equal(resultPreview({ content: [{ type: "image", data: "x" }] }), undefined);
assert.equal(resultPreview({ content: [{ type: "text", text: "x".repeat(200) }] }).length, 120);
assert.equal(
    reportText({
        id: "a1b2c3d4",
        agent: "explore",
        description: "find callers",
        toolCalls: 2,
        elapsedMs: 65000,
        output: "done",
    }),
    'Delegated agent "explore" (job a1b2c3d4) finished.\n\ndone',
);
assert.equal(
    reportText({ id: "a1b2c3d4", agent: "explore", description: "x", toolCalls: 0, elapsedMs: 1000 }),
    'Delegated agent "explore" (job a1b2c3d4) finished.',
);
assert.equal(
    reportText({ id: "a1b2c3d4", agent: "explore", description: "x", toolCalls: 1, elapsedMs: 1000, error: "boom" }),
    'Delegated agent "explore" (job a1b2c3d4) failed: boom',
);
assert.equal(jobLine({ description: "find callers" }, 42000), "find callers · 42s");
assert.equal(jobLine({}, 0), "0s");
assert.equal(jobLine({ description: "x", toolCalls: 3, contextTokens: 2400 }, 42000), "x · 2.4k · 42s");
// A burst of delegations must never reach pi's ten-line widget cut, which chops mid-list.
for (let count = 1; count <= 40; count += 1) {
    const { shown, hidden, detail } = widgetJobs(Array.from({ length: count }, (_, i) => i));
    const lines = 1 + shown.length * (detail ? 3 : 1) + (hidden ? 1 : 0);
    assert.ok(lines <= WIDGET_MAX_LINES, `${count} jobs render ${lines} lines`);
}
assert.deepEqual(widgetJobs([1, 2, 3]), { shown: [1, 2, 3], hidden: 0, detail: true });
assert.deepEqual(widgetJobs([1, 2, 3, 4]), { shown: [1, 2, 3, 4], hidden: 0, detail: false });
assert.deepEqual(widgetJobs([1, 2, 3, 4, 5, 6, 7, 8, 9]), {
    shown: [2, 3, 4, 5, 6, 7, 8, 9],
    hidden: 1,
    detail: false,
});
assert.equal(limitOutput("ok"), "ok");
assert.equal(limitOutput("x".repeat(2000), 1000), "x".repeat(1000) + "\n\n[Output truncated: 1000 bytes omitted.]");
// A cut inside a multi-byte character backs off to the boundary instead of emitting U+FFFD.
const longCjk = limitOutput("あ".repeat(40000), 1000).split("\n\n")[0];
assert.ok(/^あ+$/.test(longCjk));
assert.equal(Buffer.byteLength(longCjk, "utf8"), 999);
// A 4-byte astral character must not be cut into a lone surrogate.
const longEmoji = limitOutput("🙂".repeat(1000), 1000).split("\n\n")[0];
assert.ok(/^[\u{1F642}]+$/u.test(longEmoji));
assert.equal(Array.from(longEmoji).length, 250);
// The protocol test uses a fake child: stdout splits a UTF-8 code point and steer returns a failed ack.
function fakeChild() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
}
const fake = fakeChild();
fake.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
        if (!line) continue;
        const command = JSON.parse(line);
        if (command.type === "prompt") {
            fake.stdout.write(
                `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n`,
            );
            const bytes = Buffer.from(
                `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "é" } })}\n`,
            );
            const split = bytes.indexOf(0xc3) + 1;
            fake.stdout.write(bytes.subarray(0, split));
            fake.stdout.write(bytes.subarray(split));
        } else if (command.type === "steer") {
            fake.stdout.write(
                `${JSON.stringify({ type: "response", id: command.id, command: "steer", success: false, error: "steer rejected" })}\n`,
            );
        }
    }
});
const activity = [];
const run = runChild(fake, "task", undefined, (update) => {
    if (update.activity) activity.push(update.activity);
});
assert.equal(fake.stdout.readableEncoding, "utf8");
await assert.rejects(run.steer("steer"), /steer rejected/);
assert.deepEqual(activity, [], "rejected steering should not appear in activity");
fake.stdout.write(
    `${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { file_path: "src/a.ts" } })}\n`,
);
fake.stdout.write(
    `${JSON.stringify({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "file loaded\nmore" }] } })}\n`,
);
fake.stdout.write(
    `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "é" }] } })}\n`,
);
// Consumed user messages preserve prose, ignore images, and never replace the final assistant output.
const guidance = "Parent guidance\n\nKeep both paragraphs.";
fake.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "user", content: guidance } })}\n`);
fake.stdout.write(
    `${JSON.stringify({
        type: "message_end",
        message: {
            role: "user",
            content: [
                { type: "text", text: "block one\n" },
                { type: "image", data: "x", mimeType: "image/png" },
                { type: "text", text: "block two" },
            ],
        },
    })}\n`,
);
fake.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
assert.equal(await run.done, "é");
assert.deepEqual(activity, [
    { kind: "tool", text: "read", detail: "src/a.ts" },
    { kind: "result", text: "↳ read: file loaded" },
    { kind: "assistant", text: "é" },
    { kind: "user", text: guidance },
    { kind: "user", text: "block one\nblock two" },
]);

// Inspectable assistant text must not be cut at the old 8 KiB ceiling.
const longText = "é" + "x".repeat(9000);
const longMessage = fakeChild();
let captured;
longMessage.stdin.on("data", (chunk) => {
    const command = JSON.parse(chunk.toString());
    if (command.type !== "prompt") return;
    longMessage.stdout.write(
        `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n`,
    );
    longMessage.stdout.write(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: longText }] } })}\n`,
    );
    longMessage.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
});
const longRun = runChild(longMessage, "task", undefined, (update) => {
    if (update.activity?.kind === "assistant") captured = update.activity.text;
});
assert.equal(await longRun.done, longText);
assert.equal(captured, longText);

const rejected = fakeChild();
let killed = false;
rejected.kill = () => (killed = true);
rejected.stdin.on("data", (chunk) => {
    const command = JSON.parse(chunk.toString());
    rejected.stdout.write(
        `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: false, error: "prompt rejected" })}\n`,
    );
});
await assert.rejects(runChild(rejected, "bad task", undefined).done, /prompt rejected/);
assert.equal(killed, true);
assert.equal(rejected.stdin.writableEnded, true);

const signal = new AbortController();
signal.abort();
const cancelled = fakeChild();
await assert.rejects(runChild(cancelled, "task", signal.signal).done, /aborted/);
assert.equal(cancelled.stdin.writableEnded, true);

const controller = new AbortController();
const stopping = fakeChild();
let abortRequested = false;
stopping.stdin.on("data", (chunk) => {
    const command = JSON.parse(chunk.toString());
    if (command.type === "prompt") {
        stopping.stdout.write(
            `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n`,
        );
    } else if (command.type === "abort") {
        abortRequested = true;
        stopping.stdout.write(
            `${JSON.stringify({ type: "response", id: command.id, command: "abort", success: true })}\n`,
        );
        stopping.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    }
});
const active = runChild(stopping, "task", controller.signal);
controller.abort();
await assert.rejects(active.done, /aborted/);
assert.equal(abortRequested, true);
assert.equal(stopping.stdin.writableEnded, true);

// The command is TUI-only; an empty session should explain why there is no view.
const { default: extension } = await import(new URL("index.ts", root).href);
const registered = [];
let inspect;
let renderReport;
const deliveries = [];
const delivered = new Promise((resolve) => deliveries.push(resolve));
const deliveredSecond = new Promise((resolve) => deliveries.push(resolve));
extension({
    on() {},
    sendMessage(message) {
        deliveries.shift()?.(message);
    },
    registerMessageRenderer(type, renderer) {
        if (type === "delegate-result") renderReport = renderer;
    },
    registerCommand(name, command) {
        if (name === "delegate") inspect = command;
    },
    registerTool(tool) {
        registered.push(tool);
    },
    getActiveTools: () => ["read"],
});
let notice;
await inspect.handler("", { mode: "tui", ui: { notify: (message) => (notice = message) } });
assert.match(notice, /No delegates/);
// Missing CLI argv must fail before spawning a child.
const delegate = registered.find((tool) => tool.name === "delegate");
// User agent dirs can override bundled agents, so check the tier format rather than one agent.
assert.match(delegate.description, /^- \S+ \(\S+\): /m, "agent list with model tier missing");
assert.match(delegate.promptGuidelines.join("\n"), /use delegate proactively/);
assert.match(
    delegate.promptGuidelines.join("\n"),
    /delegate any new context-heavy investigation before tracing it yourself/,
);
assert.match(delegate.promptGuidelines.join("\n"), /required delegate report before claiming the task is done/);
assert.match(delegate.promptGuidelines.join("\n"), /call any tool solely to wait/);
const ctx = {
    cwd: fileURLToPath(root),
    hasUI: false,
    model: { provider: "anthropic", id: "m" },
    modelRegistry: { find: () => ({ contextWindow: 1000000 }) },
    thinkingLevel: "off",
};
const argv = process.argv;
process.argv = [argv[0]];
try {
    await assert.rejects(
        delegate.execute(
            "call",
            { agent: "explore", description: "find callers", task: "trace it" },
            undefined,
            () => {},
            ctx,
        ),
        /CLI entrypoint/,
    );
} finally {
    process.argv = argv;
}

// A real RPC child populates recent jobs; a second stays live in the two-column observer.
const fakeCliDir = mkdtempSync(join(tmpdir(), "pi-delegate-fake-cli-"));
const fakeCli = join(fakeCliDir, "pi.mjs");
writeFileSync(
    fakeCli,
    `
let stage = 0;
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
process.stdin.on("data", (data) => {
    for (const line of data.toString().trim().split("\\n")) {
        const command = JSON.parse(line);
        if (command.type === "prompt") {
            send({ type: "response", command: "prompt", id: command.id, success: true });
            send({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message }], timestamp: Date.now() } });
        } else if (command.type === "steer") {
            if (++stage === 1) {
                for (let i = 0; i < 105; i++) {
                    send({ type: "tool_execution_start", toolName: "read", args: { path: "src/" + i + ".ts" } });
                    send({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "ok" }] } });
                }
                send({ type: "message_update", usage: { totalTokens: 37000 } });
            } else {
                send({ type: "tool_execution_start", toolName: "read", args: { path: "src/end.ts" } });
                send({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "ok" }] } });
            }
            const message = { role: "user", content: stage === 1 ? command.message : [{ type: "text", text: command.message }], timestamp: Date.now() };
            send({ type: "message_start", message });
            send({ type: "message_end", message });
            if (stage === 2) send({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 37000 }, content: [{ type: "text", text: "## Done\\n\\n| Path | Count |\\n| --- | ---: |\\n| a.ts | 2 |" }] } });
            send({ type: "response", command: "steer", id: command.id, success: true });
            if (stage === 2) send({ type: "agent_settled" });
        }
    }
});
setTimeout(() => process.exit(1), 5000).unref();
`,
);
const colors = [];
const colored = [];
const theme = {
    fg: (color, text) => {
        colors.push(color);
        colored.push([color, text]);
        return text;
    },
    bold: (text) => text,
};
// delegate_list intentionally keeps Pi's default rendering; the rest use compact call headers and keep failures visible.
for (const tool of registered.filter((entry) => entry.name !== "delegate_list")) {
    assert.equal(typeof tool.renderCall, "function", `${tool.name} has no call renderer`);
    assert.equal(typeof tool.renderResult, "function", `${tool.name} has no result renderer`);
    const partial = tool.renderCall({}, theme, { expanded: false, argsComplete: false }).render(80);
    assert.ok(stripVTControlCharacters(partial[0]).trim().startsWith(tool.name));
    assert.doesNotMatch(partial.join("\n"), /undefined/);
    colored.length = 0;
    const failure = tool.renderResult(
        { content: [{ type: "text", text: "Specific failure" }], details: undefined },
        { expanded: false },
        theme,
        { isError: true },
    );
    assert.match(failure.render(80).join("\n"), /Specific failure/);
    assert.ok(colored.some(([color, text]) => color === "error" && text.includes("Specific failure")));
    colored.length = 0;
    const fallback = tool.renderResult(
        { content: [{ type: "text", text: "Plain result" }], details: undefined },
        { expanded: false },
        theme,
        { isError: false },
    );
    assert.match(fallback.render(80).join("\n"), /Plain result/);
    assert.ok(colored.some(([color, text]) => color === "toolOutput" && text.includes("Plain result")));
}
// Collapse after wrapping: a long single-line message must not become an unbounded tool card.
const longPayload = "START-OF-PAYLOAD " + "漢🙂 words ".repeat(600) + " END-OF-PAYLOAD";
for (const name of ["delegate", "delegate_steer"]) {
    const tool = registered.find((entry) => entry.name === name);
    const args = {
        agent: "general",
        id: "deadbeef",
        description: "Short description",
        task: longPayload,
        message: longPayload,
    };
    const collapsed = tool.renderCall(args, theme, { expanded: false });
    for (const width of [32, 80, 120]) {
        const rows = collapsed.render(width);
        const plain = rows.map(stripVTControlCharacters);
        assert.ok(rows.length <= COLLAPSED_OUTPUT_LINES + 3, `${name} preview grew past its visual line cap`);
        assert.ok(
            rows.every((row) => visibleWidth(row) <= width),
            `${name} overflowed ${width} columns`,
        );
        assert.match(plain[0], new RegExp(name === "delegate" ? "^delegate general" : "^delegate_steer deadbeef"));
        assert.doesNotMatch(plain[0], /START-OF-PAYLOAD/);
        if (name === "delegate" && width === 120)
            assert.match(plain[0], /Short description/, "launch summary missing from header");
        assert.equal(plain[1].trim(), "", "payload needs a separator below the header");
        assert.match(plain.join("\n"), /START-OF-PAYLOAD/);
        assert.doesNotMatch(plain.join("\n"), /END-OF-PAYLOAD/);
    }
    assert.match(collapsed.render(120).join("\n"), /more lines.*to expand/);
    collapsed.invalidate();
    const expanded = tool.renderCall(args, theme, { expanded: true }).render(80);
    assert.match(expanded.join("\n"), /END-OF-PAYLOAD/);
    assert.ok(expanded.length > COLLAPSED_OUTPUT_LINES + 3);
    assert.ok(expanded.every((row) => visibleWidth(row) <= 80));
    assert.doesNotMatch(expanded.join("\n"), /more lines.*to expand/);
    const indented = "    keep indentation";
    const preserved = tool
        .renderCall({ ...args, description: "", task: indented, message: indented }, theme, { expanded: true })
        .render(80);
    assert.ok(
        preserved.some((row) => stripVTControlCharacters(row).startsWith(indented)),
        `${name} trimmed payload indentation`,
    );
    const blank = tool
        .renderCall({ ...args, description: "", task: " \n ", message: " \n " }, theme, { expanded: true })
        .render(80);
    assert.equal(blank.length, 1, `${name} rendered blank payload rows`);
}
// delegate_list relies on Pi's default 10-line capped result fallback, so there is nothing custom to assert.
let renders = 0;
let onRender;
const tui = {
    terminal: { rows: 24 },
    requestRender() {
        renders++;
        onRender?.();
        onRender = undefined;
    },
};
let screens = 0;
let showViewer;
const viewerReady = new Promise((resolve) => (showViewer = resolve));
let widgetLines;
const ui = {
    theme,
    setWidget(_key, lines) {
        widgetLines = lines;
    },
    async custom(factory, options) {
        assert.equal(options?.overlay, true);
        assert.deepEqual(options.overlayOptions, { width: "100%", maxHeight: "100%", row: 0, col: 0 });
        let done;
        const result = new Promise((resolve) => (done = resolve));
        const view = factory(
            tui,
            theme,
            {
                matches: (data, action) =>
                    ({ "tui.select.cancel": "\x1b", "tui.select.up": "up", "tui.select.down": "down" })[action] ===
                    data,
            },
            done,
        );
        assert.equal(view.render(80).length, tui.terminal.rows);
        screens++;
        showViewer(view);
        return result;
    },
};
process.argv = [argv[0], fakeCli];
let timer;
const timeout = new Promise(
    (_, reject) => (timer = setTimeout(() => reject(new Error("delegate check timed out")), 5000)),
);
try {
    const first = await delegate.execute(
        "call",
        { agent: "explore", description: "first run", task: "trace it" },
        undefined,
        () => {},
        { ...ctx, mode: "tui", hasUI: true, ui },
    );
    assert.match(first.content[0].text, /no-op bash commands.*end your turn/);
    assert.match(widgetLines.join("\n"), /1 running · 1 total/);
    assert.match(widgetLines.join("\n"), new RegExp(`${first.details.id} explore first run`));
    assert.match(
        delegate.renderResult(first, { expanded: false }, theme, { isError: false }).render(120).join("\n"),
        new RegExp(`✓ ${first.details.id} explore started in background`),
    );
    const steer = registered.find((tool) => tool.name === "delegate_steer");
    const steerArgs = { id: `job ${first.details.id}`, message: guidance };
    const call = steer.renderCall(steerArgs, theme, { expanded: true });
    const callRows = call.render(120).map((row) => stripVTControlCharacters(row).trimEnd());
    assert.match(callRows[0], new RegExp(`^delegate_steer ${first.details.id} explore`));
    assert.doesNotMatch(callRows[0], /Parent guidance/);
    assert.match(callRows.slice(1).join("\n"), /Parent guidance\n\s*\nKeep both paragraphs\./);
    const firstSteer = await steer.execute("call", { id: first.details.id, message: guidance });
    const steerResult = steer.renderResult(firstSteer, { expanded: true }, theme, { isError: false }).render(120);
    const steerCard = [...callRows, ...steerResult].join("\n");
    assert.equal(steerCard.match(/Parent guidance/g)?.length, 1);
    const launchArgs = { agent: "explore", description: "first run", task: "trace it" };
    const launch = delegate.renderCall(launchArgs, theme, { expanded: true }).render(120).join("\n");
    const launchResult = delegate
        .renderResult(first, { expanded: true }, theme, { isError: false })
        .render(120)
        .join("\n");
    assert.match(launchResult, /Model:[\s\S]*Tools:/);
    assert.equal(launch.concat(launchResult).match(/trace it/g)?.length, 1, "launch task shown twice");
    assert.equal(launch.concat(launchResult).match(/first run/g)?.length, 1, "launch description shown twice");
    assert.match(
        delegate
            .renderResult(
                { ...first, content: [{ type: "text", text: "Launch failed" }] },
                { expanded: false },
                theme,
                { isError: true },
            )
            .render(120)
            .join("\n"),
        /Launch failed/,
    );
    await steer.execute("call", { id: first.details.id, message: "second" });
    const firstReport = await Promise.race([delivered, timeout]);
    assert.equal(firstReport.details.error, undefined);
    assert.equal(firstReport.details.toolCalls, 106);
    assert.doesNotMatch(firstReport.content, /\b\d+ tool calls?\b/);
    assert.match(
        stripVTControlCharacters(steer.renderCall(steerArgs, theme, { expanded: false }).render(120)[0]),
        new RegExp(`^delegate_steer ${first.details.id} explore`),
        "finished delegate identity lost from call header",
    );
    assert.match(
        renderReport(firstReport, { expanded: false }, theme).render(120).join("\n"),
        new RegExp(`✓ ${first.details.id} explore first run`),
    );

    const second = await delegate.execute(
        "call",
        {
            agent: "explore",
            description: "second run",
            task: "Trace delegates and collect their activity across the workspace.\nReport a detailed note after every step, including all found paths and why they matter. Finish with a final regression signal.",
        },
        undefined,
        () => {},
        { ...ctx, mode: "tui", hasUI: true, ui },
    );
    assert.match(widgetLines.join("\n"), /1 running · 2 total/);
    assert.match(widgetLines.join("\n"), new RegExp(`${second.details.id} explore second run`));
    const observing = inspect.handler("", { mode: "tui", ui });
    const view = await Promise.race([viewerReady, timeout]);
    const renderCount = renders;
    await Promise.race([new Promise((resolve) => (onRender = resolve)), timeout]);
    assert.ok(renders > renderCount, "ticker did not redraw the observer");
    colored.length = 0;
    const rows = view.render(80);
    const opened = rows.join("\n");
    assert.ok(
        rows.some((row) => stripVTControlCharacters(row).split("│")[1]?.trim() === "user"),
        "initial user message missing from inspector",
    );
    assert.match(rows[0], /\[Jobs\]  Activity · 1 running · 2 total/);
    assert.doesNotMatch(rows[0], /Jobs \(/);
    assert.doesNotMatch(rows[0], /Delegates/);
    assert.match(opened, /second run/);
    assert.match(opened, /signal\./);
    assert.ok(rows.some((row) => row.includes(second.details.model)));
    assert.ok(
        rows.findIndex((row) => row.includes(second.details.model)) <
            rows.findIndex((row) => row.includes("Trace delegates")),
    );
    assert.match(opened, new RegExp(`✓ ${first.details.id} explore`));
    assert.match(opened, new RegExp(`${second.details.id} explore`));
    assert.match(rows[2].split("│")[0], new RegExp(`${second.details.id} explore`));
    assert.match(rows[2].split("│")[1], new RegExp(`${second.details.id} explore`));
    assert.ok(colored.some(([color, text]) => color === "muted" && text === second.details.id));
    assert.ok(colored.some(([color, text]) => color === "toolTitle" && text === "explore"));
    const toolsRow = rows.findIndex((row) => row.includes("read, grep, find, ls"));
    const titleRow = rows.findIndex((row) => row.split("│")[1]?.includes("second run"));
    assert.ok(rows.findIndex((row) => row.includes(second.details.model)) < toolsRow);
    assert.match(rows[toolsRow + 1].split("│")[1], /─{20}/);
    assert.equal(titleRow, toolsRow + 2);
    assert.ok(titleRow < rows.findIndex((row) => row.includes("Trace delegates")));
    assert.doesNotMatch(rows[toolsRow].split("│")[1], /Tools:/);
    const narrow = view.render(32).join("\n");
    assert.match(narrow, /read, grep/);
    assert.match(narrow, /find, ls/);
    assert.match(narrow, /… \d+ more lines/, "long task preview must be capped");
    assert.match(rows[4].split("│")[0], /\d+s/);
    // The list pane already draws a border; the task text carries none of its own.
    assert.match(opened, /Trace delegates/);
    assert.doesNotMatch(opened, /│\s*Trace/);
    assert.doesNotMatch(opened, /Model:|Task:/);
    const originalNow = Date.now;
    try {
        Date.now = () => 0;
        const frame = () => SPINNER_FRAMES.find((icon) => view.render(80)[2]?.includes(icon));
        const firstFrame = frame();
        Date.now = () => SPINNER_INTERVAL_MS;
        assert.notEqual(frame(), firstFrame, "running status spinner stayed frozen");
    } finally {
        Date.now = originalNow;
    }
    view.handleInput("down");
    assert.match(view.render(80).join("\n"), /first run/);
    assert.match(view.render(80).join("\n"), /Count/);
    assert.match(view.render(80).join("\n"), /a\.ts/);
    assert.match(view.render(80).join("\n"), /read, grep, find, ls/);
    const recentRows = view.render(80);
    const recentStats = recentRows[7].split("│")[0].match(/37k\/1\.0M · \d+s/)?.[0];
    assert.ok(recentStats, "finished job tokens and time missing from list");
    assert.doesNotMatch(recentRows.join("\n"), /\b\d+ tool calls?\b/);
    const now = Date.now;
    try {
        Date.now = () => now() + 60000;
        assert.ok(view.render(80).join("\n").includes(recentStats), "finished job elapsed time kept ticking");
    } finally {
        Date.now = now;
    }
    view.handleInput("up");
    assert.match(view.render(80).join("\n"), /second run/);

    const before = renders;
    const steered = await steer.execute("call", { id: second.details.id, message: guidance });
    assert.equal(steered.details.toolCalls, 105);
    assert.match(
        steer.renderResult(steered, { expanded: false }, theme, { isError: false }).render(120).join("\n"),
        new RegExp(`✓ ${second.details.id} explore second run`),
    );
    assert.ok(renders > before, "live activity did not redraw the observer");
    await Promise.race([new Promise((resolve) => (onRender = resolve)), timeout]);
    assert.match(widgetLines.join("\n"), /37k\/1\.0M/);
    assert.doesNotMatch(widgetLines.join("\n"), /\b\d+ tool calls?\b/);
    view.handleInput("\t");
    assert.match(view.render(80)[0], /\[Activity\]/);
    assert.doesNotMatch(view.render(80)[0], /\[Jobs/);
    assert.match(view.render(80).join("\n"), /read src\/104.ts/);
    const liveRows = view.render(80).map(stripVTControlCharacters);
    assert.ok(
        liveRows.some((row) => row.split("│")[1]?.trim() === "user"),
        "steer role label missing",
    );
    const guidanceRow = liveRows.findIndex((row) => row.includes("Parent guidance"));
    assert.ok(guidanceRow >= 0, "steer text missing from live inspector");
    assert.equal(liveRows[guidanceRow + 1]?.split("│")[1]?.trim(), "", "steer paragraph break lost");
    assert.match(liveRows[guidanceRow + 2], /Keep both paragraphs\./);
    assert.match(
        liveRows.at(-2)?.split("│")[1] ?? "",
        /\b(\d+)\/\1\b/,
        "history stopped following the latest activity",
    );
    assert.match(view.render(80)[4].split("│")[0], /    37k\/1\.0M · \d+s/);
    assert.doesNotMatch(view.render(80).join("\n"), /\b\d+ tool calls?\b/);
    const list = registered.find((tool) => tool.name === "delegate_list");
    const listed = await list.execute();
    assert.doesNotMatch(listed.content[0].text, /\b\d+ tool calls?\b/);
    // The list result renders job identity rows from details, not the model-facing text.
    assert.equal(typeof list.renderCall, "undefined");
    assert.ok(
        listed.details.jobs.some((job) => job.id === second.details.id && job.agent === "explore"),
        "running job missing from list details",
    );
    const listCard = list
        .renderResult(listed, { expanded: false }, theme, { isError: false })
        .render(120)
        .map(stripVTControlCharacters);
    assert.equal(listCard[0].trim(), "", "list rows missing their footer separator");
    assert.match(
        listCard.slice(1).join("\n"),
        new RegExp(`${second.details.id} explore second run · 37k/1\\.0M · \\d+s`),
    );
    assert.ok(colored.some(([color, text]) => color === "toolTitle" && text === "explore"));
    assert.match(
        list
            .renderResult(
                { content: [{ type: "text", text: "No delegates are running." }], details: undefined },
                { expanded: false },
                theme,
                { isError: false },
            )
            .render(80)
            .join("\n"),
        /No delegates are running\./,
    );
    assert.ok(colors.includes("toolTitle") && colors.includes("accent") && colors.includes("text"));
    for (let i = 0; i < 3; i++) view.handleInput("up");
    const scrolledRows = view.render(80);
    const taskRow = scrolledRows.findIndex((row) => row.split("│")[1]?.includes("Trace delegates"));
    const historyRow =
        scrolledRows.findIndex((row, index) => index > taskRow && row.split("│")[1]?.includes("─".repeat(20))) + 1;
    assert.ok(taskRow > titleRow && historyRow > taskRow + 1, "history separator missing");
    const scrolledLine = scrolledRows[historyRow];
    await steer.execute("call", { id: second.details.id, message: "Final parent guidance" });
    assert.equal(view.render(80)[historyRow], scrolledLine, "new events moved the scrolled-back history");
    const secondReport = await Promise.race([deliveredSecond, timeout]);
    assert.equal(secondReport.details.error, undefined);
    assert.match(
        renderReport(secondReport, { expanded: false }, theme).render(120).join("\n"),
        new RegExp(`✓ ${second.details.id} explore second run`),
    );
    for (let i = 0; i < 30; i++) view.handleInput("down");
    assert.match(view.render(80).join("\n"), /Count/);
    view.invalidate();
    assert.match(view.render(80).join("\n"), /a\.ts/);
    view.handleInput("\x1b");
    await observing;
    assert.equal(screens, 1);
    // A fresh inspector must retain both steer messages after the job finishes.
    tui.terminal.rows = 40;
    const reopenedReady = new Promise((resolve) => (showViewer = resolve));
    const reopening = inspect.handler("", { mode: "tui", ui });
    const reopened = await Promise.race([reopenedReady, timeout]);
    const reopenedText = reopened.render(80).join("\n");
    assert.match(reopenedText, /Parent guidance/);
    assert.match(reopenedText, /Keep both paragraphs\./);
    assert.match(reopenedText, /Final parent guidance/);
    assert.match(reopenedText, /Count/);
    reopened.handleInput("\x1b");
    await reopening;
    tui.terminal.rows = 24;
    assert.equal(screens, 2);
    const cancel = registered.find((tool) => tool.name === "delegate_cancel");
    const tuiCtx = { ...ctx, mode: "tui", hasUI: true, ui };
    const cancelled = await delegate.execute(
        "call",
        { agent: "explore", description: "cancelled run", task: "trace it" },
        undefined,
        () => {},
        tuiCtx,
    );
    const cancellation = await cancel.execute("call", { id: cancelled.details.id }, undefined, () => {}, tuiCtx);
    assert.match(
        stripVTControlCharacters(
            cancel.renderCall({ id: cancelled.details.id }, theme, { expanded: false }).render(120)[0],
        ),
        new RegExp(`^delegate_cancel ${cancelled.details.id} explore`),
        "cancelled delegate identity lost from call header",
    );
    colored.length = 0;
    const cancelledResult = cancel
        .renderResult(cancellation, { expanded: false }, theme, { isError: false })
        .render(120)
        .join("\n");
    assert.match(
        cancelledResult,
        new RegExp(`${STATUS_ICONS.cancelled} ${cancelled.details.id} explore cancellation requested`),
    );
    assert.ok(
        colored.some(([color, text]) => color === STATUS_COLORS.cancelled && text === STATUS_ICONS.cancelled),
        "cancellation icon must be muted, not an error",
    );
    const remaining = await delegate.execute(
        "call",
        { agent: "explore", description: "remaining run", task: "trace it" },
        undefined,
        () => {},
        tuiCtx,
    );
    assert.match(widgetLines.join("\n"), /1 running · 4 total/);
    await cancel.execute("call", { id: remaining.details.id }, undefined, () => {}, tuiCtx);
} finally {
    clearTimeout(timer);
    process.argv = argv;
    rmSync(fakeCliDir, { recursive: true, force: true });
}

console.log("pi-delegate check passed");

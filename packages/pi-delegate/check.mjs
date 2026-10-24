import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { initTheme, renderDiff } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
    COLLAPSED_OUTPUT_LINES,
    jobLine,
    launchDetails,
    limitOutput,
    outputPreview,
    piDiff,
    reportText,
    resultPreview,
    SPINNER_INTERVAL_MS,
    STATUS_COLORS,
    statusText,
    toolCallDetail,
    usageStats,
    widgetJobs,
} from "./format.ts";
import { priorActivity, runChild } from "./child.ts";
import { resolveModel } from "./agents.ts";
import { createJobStore } from "./store.ts";
// Hermetic: configFor and the pinned session dir must not read the host's real agent settings.
const agentDir = mkdtempSync(join(tmpdir(), "pi-delegate-check-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

initTheme("dark");

const root = new URL("./", import.meta.url);
const index = readFileSync(new URL("index.ts", root), "utf8");
const child = readFileSync(new URL("child.ts", root), "utf8");
const store = readFileSync(new URL("store.ts", root), "utf8");
const inspector = readFileSync(new URL("inspector.ts", root), "utf8");
const agents = readFileSync(new URL("agents.ts", root), "utf8");
const isolation = readFileSync(new URL("isolation.ts", root), "utf8");
// Tripwires match source text across every module, so code that moved stays covered.
const sources = `${index}\n${store}\n${inspector}\n${agents}\n${isolation}`;

// Tripwires for wiring the runtime import cannot see: the child protocol, the delivery path,
// and where the prompt text lives. Renderer behavior is exercised below, not matched against source text.
assert.match(sources, /name: "delegate"/);
assert.match(sources, /registerCommand\("delegate"/);
assert.match(sources, /name: "delegate_list"/);
assert.match(sources, /name: "delegate_steer"/);
assert.match(sources, /name: "delegate_cancel"/);
assert.match(sources, /name: "delegate_apply"/);
const excluded = sources.match(/const DELEGATION_TOOLS = new Set\(([\s\S]*?)\]\)/)?.[1];
assert.ok(excluded, "missing child delegation denylist");
assert.deepEqual([...excluded.matchAll(/"([^"]+)"/g)].map(([, name]) => name).sort(), [
    "delegate",
    "delegate_apply",
    "delegate_cancel",
    "delegate_list",
    "delegate_steer",
]);
assert.match(sources, /!DELEGATION_TOOLS\.has\(tool\)/);
// Pinned child sessions: every spawn and revive reopens the same deterministic transcript.
assert.doesNotMatch(sources, /--no-session/);
assert.match(sources, /const DELEGATE_SESSION_DIR = join\(getAgentDir\(\), "sessions", "delegates"\)/);
assert.match(sources, /"--session-id",\s*`delegate-\$\{job\.id\}`,\s*"--session-dir",\s*DELEGATE_SESSION_DIR/);
assert.match(sources, /spawn\(process\.execPath, \[entrypoint, "--mode", "rpc", \.\.\.args\]/);
assert.match(sources, /"--model",\s*model,\s*"--tools",\s*tools\.join\(","\)/);
// A `:<thinking>` suffix on the agent/param beats the tier suffix, which beats the session level.
const session = { model: { provider: "anthropic", id: "m" }, thinkingLevel: "medium" };
assert.deepEqual(resolveModel("anthropic/x", {}, session), { model: "anthropic/x", thinking: "medium" });
assert.deepEqual(resolveModel("anthropic/x:high", {}, session), { model: "anthropic/x", thinking: "high" });
// Only known levels split, so colon-bearing ids stay whole.
assert.deepEqual(resolveModel("ollama/llama3:8b", {}, session), { model: "ollama/llama3:8b", thinking: "medium" });
assert.deepEqual(resolveModel("cheap", { cheap: "anthropic/h" }, session), {
    model: "anthropic/h",
    thinking: "medium",
});
assert.deepEqual(resolveModel("cheap", { cheap: "google/flash:low" }, session), {
    model: "google/flash",
    thinking: "low",
});
assert.deepEqual(resolveModel("cheap:high", { cheap: "google/flash:low" }, session), {
    model: "google/flash",
    thinking: "high",
});
// An unset or malformed tier falls back to the session model but keeps the requested level.
assert.deepEqual(resolveModel("cheap:low", {}, session), { model: "anthropic/m", thinking: "low" });
assert.deepEqual(resolveModel("cheap", { cheap: { model: "x/y" } }, session), {
    model: "anthropic/m",
    thinking: "medium",
});
assert.deepEqual(resolveModel(undefined, {}, {}), { model: undefined, thinking: undefined });
assert.match(child, /case "agent_settled"/);
// get_state exists only for the revive guard: verifying the pinned transcript is not empty.
assert.match(child, /type: "get_state"/);
assert.match(child, /type: "steer", message/);
// pi skips before_agent_start in runs a delegate report starts, so a prompt section would vanish exactly then.
assert.doesNotMatch(sources, /systemPromptOptions\.sections/);
assert.match(sources, /registerMessageRenderer\(RESULT_MESSAGE/);
assert.match(sources, /pi\.sendMessage\(/);
// A follow-up waits for a run end; a parent stuck polling never reaches one and the report is lost.
assert.match(sources, /background: ctx\.hasUI/);
assert.match(sources, /deliverAs: "steer"/);
assert.match(sources, /setWidget\(WIDGET_KEY/);
// One status vocabulary; a glyph written into a view drifts out of sync with the others.
assert.doesNotMatch(sources, /[✓✗●○]/);

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
// A typo like `cheap:hgh` would not split and fail every delegate of that agent at child launch.
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

// Crash recovery: entry dedupe runs through the store's restore seam.
const jobEntry = (id, status, extra = {}) => ({
    id,
    agent: "explore",
    description: "d",
    task: "t",
    model: "m",
    tools: [],
    toolCalls: 0,
    startedAt: 1,
    status,
    activity: [],
    ...extra,
});
const branch = (jobs) => jobs.map((job) => ({ type: "custom", customType: "delegate-job", data: job }));
// Last entry wins per id and the order stays newest first, so a job shows once with its latest status.
// A restored "running" job no live job owns is a crash orphan, so restore marks it interrupted.
const restoreStore = createJobStore(() => {});
const restoredIds = (entries) => {
    restoreStore.restore(entries);
    return restoreStore.all().map(({ id, status }) => ({ id, status }));
};
assert.deepEqual(restoredIds(branch([jobEntry("a", "running"), jobEntry("b", "running"), jobEntry("a", "done")])), [
    { id: "a", status: "done" },
    { id: "b", status: "interrupted" },
]);
assert.deepEqual(restoredIds(branch([jobEntry("a", "running"), jobEntry("a", "interrupted")])), [
    { id: "a", status: "interrupted" },
]);
assert.deepEqual(
    restoredIds([{ type: "custom", customType: "other", data: jobEntry("a", "running") }, { type: "message" }]),
    [],
);

assert.deepEqual(Object.keys(STATUS_COLORS).sort(), ["cancelled", "done", "failed", "interrupted", "running"]);
// One vocabulary: every status renders through statusText; only running spins with the clock.
const bare = { fg: (_color, text) => text };
assert.notEqual(statusText(bare, "running", 0), statusText(bare, "running", SPINNER_INTERVAL_MS));
for (const status of ["done", "failed", "cancelled", "interrupted"])
    assert.equal(statusText(bare, status, 0), statusText(bare, status, SPINNER_INTERVAL_MS), `${status} icon spins`);
assert.equal(launchDetails({ model: "x/y", tools: ["read", "ls"] }).join("\n"), "  Model: x/y\n  Tools: read, ls");
assert.deepEqual(launchDetails({ tools: [] }), ["  Model: default", "  Tools: none"]);
assert.deepEqual(outputPreview("a\nb", 5), { shown: ["a", "b"], hidden: 0 });
assert.deepEqual(outputPreview("a\nb\nc", 2), { shown: ["a", "b"], hidden: 1 });
assert.deepEqual(outputPreview("```\ncode\nmore", 2), { shown: ["```", "code", "```"], hidden: 1 });
assert.deepEqual(outputPreview("```\na\n```\nb", 3), { shown: ["```", "a", "```"], hidden: 1 });
// A git unified diff must convert to pi's `+-<padded num> content` format before renderDiff colors it.
const unified = [
    "diff --git a/x.ts b/x.ts",
    "index 111..222 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,4 +1,5 @@",
    " line1",
    "-old2",
    "+new2",
    "+new2b",
    " line3",
    "\\ No newline at end of file",
].join("\n");
const converted = piDiff(unified).split("\n");
assert.deepEqual(converted, ["x.ts", " 1 line1", "-2 old2", "+2 new2", "+3 new2b", " 4 line3"]);
for (const line of converted.slice(1)) assert.match(line, /^([-+ ]) *\d+ /);
const codes = renderDiff(piDiff(unified))
    .split("\n")
    .map((line) => /^\u001b\[([0-9;]+)m/.exec(line)?.[1]);
assert.ok(codes[2] !== codes[1] && codes[3] !== codes[1], "added/removed lines must not render as context");
assert.equal(usageStats({}, 0), "0s");
assert.equal(usageStats({ contextTokens: 900 }, 42000), "900 · 42s");
assert.equal(usageStats({ contextTokens: 1234 }, 0), "1.2k · 0s");
assert.equal(usageStats({ contextTokens: 200000 }, 0), "200k · 0s");
assert.equal(usageStats({ contextTokens: 2400 }, 1000), "2.4k · 1s");
assert.equal(usageStats({ toolCalls: 3, contextTokens: 2400, contextWindow: 200000 }, 42000), "2.4k/200k · 42s");
assert.equal(usageStats({}, 65000), "1m 05s");
assert.equal(usageStats({}, 3720000), "1h 02m");
assert.equal(toolCallDetail("bash", { command: "npm test\nsecond" }), "npm test");
assert.equal(toolCallDetail("read", { path: "src/a.ts" }), "src/a.ts");
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
        contextTokens: 2400,
        contextWindow: 200000,
        elapsedMs: 65000,
        output: "done",
    }),
    'Delegate "explore" (job a1b2c3d4, 2.4k/200k · 1m 05s) finished.\n\ndone',
);
assert.equal(
    reportText({ id: "a1b2c3d4", agent: "explore", description: "x", toolCalls: 0, elapsedMs: 1000 }),
    'Delegate "explore" (job a1b2c3d4, 1s) finished.',
);
assert.equal(
    reportText({ id: "a1b2c3d4", agent: "explore", description: "x", toolCalls: 1, elapsedMs: 1000, error: "boom" }),
    'Delegate "explore" (job a1b2c3d4, 1s) failed: boom\nTo continue this job, call delegate_steer with id a1b2c3d4 and a message.',
);
assert.equal(jobLine({ description: "find callers" }, 42000), "find callers · 42s");
assert.equal(jobLine({}, 0), "0s");
assert.equal(jobLine({ description: "x", toolCalls: 3, contextTokens: 2400 }, 42000), "x · 2.4k · 42s");
// A burst of delegations must never reach pi's ten-line widget cut, which chops mid-list.
for (let count = 1; count <= 40; count += 1) {
    const { shown, hidden, detail } = widgetJobs(Array.from({ length: count }, (_, i) => i));
    const lines = 1 + shown.length * (detail ? 3 : 1) + (hidden ? 1 : 0);
    assert.ok(lines <= 10, `${count} jobs render ${lines} lines`);
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
    `${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } })}\n`,
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
// A revive whose get_state fails must fail the run, not prompt into an unverifiable transcript.
const unverifiable = fakeChild();
unverifiable.stdin.on("data", (chunk) => {
    const command = JSON.parse(chunk.toString());
    unverifiable.stdout.write(
        `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: false, error: "state unavailable" })}\n`,
    );
});
await assert.rejects(runChild(unverifiable, "task", undefined, undefined, true).done, /state unavailable/);
// A live model swap speaks set_model, and set_thinking_level only for an explicit level.
const swapping = fakeChild();
const spoken = [];
swapping.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
        if (!line) continue;
        const command = JSON.parse(line);
        spoken.push(command);
        swapping.stdout.write(
            `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true })}\n`,
        );
    }
});
const swappingRun = runChild(swapping, "task", undefined);
await swappingRun.swapModel("anthropic", "flash");
await swappingRun.swapModel("google", "gemini", "high");
assert.deepEqual(
    spoken
        .filter((command) => command.type !== "prompt")
        .map((command) => [command.type, command.provider ?? command.level, command.modelId]),
    [
        ["set_model", "anthropic", "flash"],
        ["set_model", "google", "gemini"],
        ["set_thinking_level", "high", undefined],
    ],
);
// A rejected set_model must surface the child's error instead of passing silently.
const refusing = fakeChild();
refusing.stdin.on("data", (chunk) => {
    const command = JSON.parse(chunk.toString());
    refusing.stdout.write(
        `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: command.type !== "set_model", error: command.type === "set_model" ? "Model not found: nope/x" : undefined })}\n`,
    );
});
const refusingRun = runChild(refusing, "task", undefined);
await assert.rejects(refusingRun.swapModel("nope", "x"), /Model not found/);
// A set_thinking_level failure must not hide the already-applied swap: the ack callback still ran.
const halfSwapped = fakeChild();
let applied = false;
halfSwapped.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
        if (!line) continue;
        const command = JSON.parse(line);
        halfSwapped.stdout.write(
            `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: command.type !== "set_thinking_level", error: command.type === "set_thinking_level" ? "level rejected" : undefined })}\n`,
        );
    }
});
const halfRun = runChild(halfSwapped, "task", undefined);
await assert.rejects(
    halfRun.swapModel("anthropic", "flash", "high", () => (applied = true)),
    /level rejected/,
);
assert.equal(applied, true);

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

// A revived job's inspector history replays the child's persisted transcript, malformed lines and all.
const seedDir = mkdtempSync(join(tmpdir(), "pi-delegate-seed-"));
writeFileSync(
    join(seedDir, "2026-01-01T00-00-00-000Z_delegate-seed1.jsonl"),
    [
        JSON.stringify({ type: "session", id: "delegate-seed1" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "trace it" } }),
        JSON.stringify({
            type: "message",
            message: {
                role: "assistant",
                content: [
                    { type: "text", text: "Reading files." },
                    { type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts" } },
                ],
            },
        }),
        JSON.stringify({
            type: "message",
            message: {
                role: "toolResult",
                toolCallId: "t1",
                toolName: "read",
                content: [{ type: "text", text: "const a = 1;" }],
            },
        }),
        "{not json",
    ].join("\n") + "\n",
);
assert.deepEqual(priorActivity(seedDir, "seed1"), [
    { kind: "user", text: "trace it" },
    { kind: "assistant", text: "Reading files." },
    { kind: "tool", text: "read", detail: "src/a.ts" },
    { kind: "result", text: "↳ read: const a = 1;" },
]);
assert.deepEqual(priorActivity(seedDir, "nope"), [], "unknown session id must seed nothing");
assert.deepEqual(priorActivity(join(seedDir, "missing"), "seed1"), [], "missing session dir must seed nothing");

// The command is TUI-only; an empty session should explain why there is no view.
const { default: extension } = await import(new URL("index.ts", root).href);
const registered = [];
let inspect;
let renderReport;
const deliveries = [];
const savedEntries = [];
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
    appendEntry: (customType, data) => savedEntries.push({ type: "custom", customType, data }),
});
let notice;
await inspect.handler("", { mode: "tui", ui: { notify: (message) => (notice = message) } });
assert.match(notice, /No delegates/);
// Missing CLI argv must fail before spawning a child.
const delegate = registered.find((tool) => tool.name === "delegate");
// User agent dirs can override bundled agents, so check the tier format rather than one agent.
assert.match(delegate.description, /^- \S+ \(\S+\): /m, "agent list with model tier missing");
// The model must learn from the tool description that steering continues or redirects any job.
assert.match(delegate.description, /follow up on or redirect an existing job, see delegate_steer/);
assert.match(delegate.promptGuidelines.join("\n"), /You are the orchestrator/);
// Drift reminder: only the orchestrating session, at 5 then 10 direct calls, and a delegate call resets it.
const nudged = (activeTools) => {
    const handlers = {};
    const reminders = [];
    extension({
        on: (event, handler) => (handlers[event] = handler),
        sendMessage: (message, options) => reminders.push({ message, options }),
        registerMessageRenderer() {},
        registerCommand() {},
        registerTool() {},
        getActiveTools: () => activeTools,
    });
    return {
        reminders,
        prompt: () => handlers.before_agent_start(),
        call: (toolName, parentToolCallId) => handlers.tool_result({ toolName, parentToolCallId }),
    };
};
const parent = nudged(["read", "delegate"]);
for (const tool of ["grep", "grep", "read", "edit", "ls"]) parent.call(tool);
assert.equal(parent.reminders.length, 0, "edits are not exploration");
parent.call("bash");
assert.equal(parent.reminders.length, 1);
assert.equal(parent.reminders[0].message.display, false);
assert.equal(parent.reminders[0].options.deliverAs, "steer");
assert.match(parent.reminders[0].message.content, /5 direct exploration calls/);
for (let i = 0; i < 4; i++) parent.call("read");
assert.equal(parent.reminders.length, 1, "the second reminder waits for 10 calls");
parent.call("read");
assert.equal(parent.reminders.length, 2);
parent.call("delegate");
for (let i = 0; i < 5; i++) parent.call("read");
assert.equal(parent.reminders.length, 3, "a delegate call resets the count");
const childSession = nudged(["read"]);
for (let i = 0; i < 10; i++) childSession.call("read");
assert.equal(childSession.reminders.length, 0, "children cannot delegate, so they are never nudged");
const scripted = nudged(["delegate"]);
for (let i = 0; i < 10; i++) scripted.call("grep", "codemode-call");
assert.equal(scripted.reminders.length, 0, "calls a script issued are not the model's own steps");
for (let i = 0; i < 4; i++) scripted.call("read");
scripted.prompt();
scripted.call("read");
assert.equal(scripted.reminders.length, 0, "a new prompt resets the count");
assert.match(delegate.promptGuidelines.join("\n"), /While delegates run, stay outside their scopes/);
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
import { appendFileSync, existsSync } from "node:fs";
const COMMANDS_LOG = '${join(fakeCliDir, "commands.log")}';
let stage = 0;
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
process.stdin.on("data", (data) => {
    for (const line of data.toString().trim().split("\\n")) {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
            send({ type: "response", command: "get_state", id: command.id, success: true, data: { messageCount: existsSync("/tmp/pi-delegate-fake-empty") ? 0 : 5 } });
        } else if (command.type === "prompt") {
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
    assert.match(failure.render(80).join("\n"), /✗/, "thrown errors must show the failure mark");
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
    // The launch entry is written at spawn, before the job produces any output.
    assert.ok(
        savedEntries.some((entry) => entry.data?.id === first.details.id && entry.data?.status === "running"),
        "launch entry missing",
    );
    assert.match(
        delegate.renderResult(first, { expanded: false }, theme, { isError: false }).render(120).join("\n"),
        new RegExp(`${first.details.id} explore started in background`),
    );
    assert.match(
        delegate.renderResult(first, { expanded: false }, theme, { isError: false }).render(120).join("\n"),
        /✓/,
        "background launch missing its call-success mark",
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
    // Display-only suffix: the session thinking (off) shows on the model, --model stays raw.
    assert.match(first.details.model, /:off$/, "inherited thinking must suffix the model display");
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
    assert.match(rows[toolsRow + 2].split("│")[1], /─{20}/);
    assert.equal(titleRow, toolsRow + 1);
    assert.ok(titleRow < rows.findIndex((row) => row.includes("Trace delegates")));
    assert.doesNotMatch(rows[toolsRow].split("│")[1], /Tools:/);
    const narrow = view.render(32).join("\n");
    assert.match(narrow, /read, grep/);
    assert.match(narrow, /find, ls/);
    assert.equal(view.render(32).length, tui.terminal.rows, "long task must not grow the pane");
    assert.match(rows[4].split("│")[0], /\d+s/);
    // The task reaches the pane only as the child's first user message.
    assert.match(opened, /Trace delegates/);
    assert.doesNotMatch(opened, /│\s*Trace/);
    assert.doesNotMatch(opened, /Model:|Task:/);
    const originalNow = Date.now;
    try {
        Date.now = () => 0;
        const firstFrame = view.render(80)[2];
        Date.now = () => SPINNER_INTERVAL_MS;
        assert.notEqual(view.render(80)[2], firstFrame, "running status spinner stayed frozen");
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
    view.handleInput("\x1b[C");
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
        liveRows.at(-3)?.split("│")[1] ?? "",
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
    // The list shows finished jobs too, each with its terminal status.
    assert.ok(
        listed.details.jobs.some((job) => job.id === first.details.id && job.status === "done"),
        "finished job missing from list details",
    );
    assert.match(listed.content[0].text, new RegExp(`${first.details.id} explore · done`));
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
                { content: [{ type: "text", text: "No delegates yet." }], details: undefined },
                { expanded: false },
                theme,
                { isError: false },
            )
            .render(80)
            .join("\n"),
        /No delegates yet\./,
    );
    assert.ok(colors.includes("toolTitle") && colors.includes("accent") && colors.includes("text"));
    for (let i = 0; i < 3; i++) view.handleInput("up");
    const scrolledRows = view.render(80);
    // No task block above the transcript anymore; anchor on the first transcript row under the header.
    const scrolledLine = scrolledRows[toolsRow + 3];
    await steer.execute("call", { id: second.details.id, message: "Final parent guidance" });
    assert.equal(view.render(80)[toolsRow + 3], scrolledLine, "new events moved the scrolled-back history");
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
    // pi --continue loads a fresh extension; finished jobs come back from the session branch.
    let restoreSession;
    let restoredInspect;
    extension({
        on: (event, handler) => event === "session_start" && (restoreSession = handler),
        registerCommand: (name, command) => name === "delegate" && (restoredInspect = command),
        registerTool() {},
        registerMessageRenderer() {},
        sendMessage() {},
        appendEntry() {},
        getActiveTools: () => [],
    });
    restoreSession({}, { sessionManager: { getBranch: () => savedEntries } });
    tui.terminal.rows = 40;
    const restoredReady = new Promise((resolve) => (showViewer = resolve));
    const restoring = restoredInspect.handler("", { mode: "tui", ui });
    const restored = await Promise.race([restoredReady, timeout]);
    const restoredText = restored.render(80).join("\n");
    assert.match(restoredText, /second run/);
    assert.match(restoredText, /Final parent guidance/);
    // Launch plus completion entries restore as one job per id, not two rows.
    assert.match(restoredText, /0 running · 2 total/, "restored jobs listed more than once");
    restored.handleInput("\x1b");
    await restoring;
    tui.terminal.rows = 24;
    assert.equal(screens, 3);

    // Crash recovery end to end: a restored "running" job is interrupted and announced, then revivable.
    let recoverSession;
    let treeSession;
    let launchTool;
    let steerTool;
    let cancelTool;
    let recoverInspect;
    let interruptedNotice;
    extension({
        on: (event, handler) =>
            event === "session_start"
                ? (recoverSession = handler)
                : event === "session_tree" && (treeSession = handler),
        registerCommand: (name, command) => name === "delegate" && (recoverInspect = command),
        registerTool: (tool) => {
            if (tool.name === "delegate") launchTool = tool;
            else if (tool.name === "delegate_steer") steerTool = tool;
            else if (tool.name === "delegate_cancel") cancelTool = tool;
        },
        registerMessageRenderer() {},
        sendMessage: (message) => (interruptedNotice = message),
        appendEntry: (customType, data) => savedEntries.push({ type: "custom", customType, data }),
        getActiveTools: () => [],
    });
    const orphan = {
        ...jobEntry("orphan1", "running"),
        agent: "explore",
        description: "orphaned run",
    };
    recoverSession(
        {},
        { sessionManager: { getBranch: () => [{ type: "custom", customType: "delegate-job", data: orphan }] } },
    );
    assert.equal(orphan.status, "running", "restore mutated the session's own entry");
    assert.equal(savedEntries.at(-1).data.status, "interrupted");
    assert.equal(savedEntries.at(-1).data.id, "orphan1");
    assert.equal(interruptedNotice.customType, "delegate-interrupted");
    assert.match(interruptedNotice.content, /orphan1 .*explore: orphaned run/);
    assert.match(interruptedNotice.content, /delegate_steer/);
    // The pinned transcript replays into the revived job's activity, so the inspector keeps the old history.
    mkdirSync(join(agentDir, "sessions", "delegates"), { recursive: true });
    writeFileSync(
        join(agentDir, "sessions", "delegates", "2026-01-01T00-00-00-000Z_delegate-orphan1.jsonl"),
        `${JSON.stringify({ type: "session", id: "delegate-orphan1" })}\n${JSON.stringify({
            type: "message",
            message: { role: "user", content: "orphan task" },
        })}\n`,
    );
    const revived = await steerTool.execute(
        "call",
        { id: "job orphan1", message: "revive: finish it" },
        undefined,
        () => {},
        { ...ctx, hasUI: false },
    );
    assert.match(revived.content[0].text, /Revived and finished\./);
    assert.equal(revived.details.id, "orphan1");
    assert.match(
        stripVTControlCharacters(
            steerTool.renderResult(revived, { expanded: false }, theme, { isError: false }).render(120).join("\n"),
        ),
        new RegExp(`✓ orphan1 explore revived[\\s\\S]*Revived and finished\\.`),
        "foreground revive missing its mark and child output",
    );
    const orphanLaunch = savedEntries.find((entry) => entry.data?.id === "orphan1" && entry.data.status === "running");
    assert.ok(
        orphanLaunch?.data.activity.some((item) => item.kind === "user" && item.text === "orphan task"),
        "revived job did not replay the prior transcript",
    );
    const orphanEntries = savedEntries.filter((entry) => entry.data?.id === "orphan1");
    assert.deepEqual(
        orphanEntries.map((entry) => entry.data.status),
        ["interrupted", "running", "done"],
    );
    // A done job revives too, and a model override reaches the relaunched child.
    const revivedAgain = await steerTool.execute(
        "call",
        { id: "job orphan1", message: "revive: once more", model: "anthropic/flash:high" },
        undefined,
        () => {},
        { ...ctx, hasUI: false },
    );
    assert.match(revivedAgain.content[0].text, /Revived and finished\./);
    assert.equal(revivedAgain.details.model, "anthropic/flash:high");
    // A foreground revive inherits the tool's abort signal, so Esc can stop it mid-run.
    const aborting = new AbortController();
    aborting.abort();
    await assert.rejects(
        steerTool.execute("call", { id: "job orphan1", message: "revive: abort me" }, aborting.signal, () => {}, {
            ...ctx,
            hasUI: false,
        }),
        /aborted/,
    );
    // A mid-run session_tree rebuild restores the live job's launch entry. The restore must not double it, and
    // finishing the job must not leave a phantom running row behind.
    const phantom = await launchTool.execute(
        "call",
        { agent: "explore", description: "phantom run", task: "trace it" },
        undefined,
        () => {},
        { ...ctx, mode: "tui", hasUI: true, ui },
    );
    treeSession({}, { sessionManager: { getBranch: () => savedEntries } });
    tui.terminal.rows = 40;
    const phantomReady = new Promise((resolve) => (showViewer = resolve));
    const openingPhantom = recoverInspect.handler("", { mode: "tui", ui });
    const phantomView = await Promise.race([phantomReady, timeout]);
    assert.match(
        phantomView.render(80).join("\n"),
        /1 running · 4 total/,
        "restored launch entry doubled the live job",
    );
    // A running job swaps its model live: set_model (and set_thinking_level for an explicit level) reach
    // the child over the RPC, without a restart, before the steer message is queued.
    const swappedLive = await steerTool.execute(
        "call",
        { id: phantom.details.id, message: "use a cheaper model", model: "anthropic/flash:high" },
        undefined,
        () => {},
        { ...ctx, mode: "tui", hasUI: true, ui },
    );
    assert.match(swappedLive.content[0].text, /delivered/);
    assert.match(
        readFileSync(join(fakeCliDir, "commands.log"), "utf8"),
        /set_model anthropic flash\nset_thinking_level +high/,
    );
    // A rejected live swap surfaces the child's error; the job stays live and cancellable.
    await assert.rejects(
        steerTool.execute(
            "call",
            { id: phantom.details.id, message: "no swap", model: "nope/x" },
            undefined,
            () => {},
            { ...ctx, mode: "tui", hasUI: true, ui },
        ),
        /Model not found/,
    );
    await cancelTool.execute("call", { id: phantom.details.id }, undefined, () => {}, {
        ...ctx,
        mode: "tui",
        hasUI: true,
        ui,
    });
    phantomView.invalidate();
    const phantomDone = phantomView.render(80).join("\n");
    assert.match(phantomDone, /0 running · 4 total/, "finished job left a phantom running row");
    assert.match(phantomDone, /✗/);
    phantomView.handleInput("\x1b");
    await openingPhantom;
    tui.terminal.rows = 24;
    // Reviving a recreated (empty) pinned transcript must fail instead of prompting into a blank session.
    const orphan2 = {
        ...jobEntry("orphan2", "running"),
        agent: "explore",
        description: "empty revive",
    };
    recoverSession(
        {},
        {
            sessionManager: {
                getBranch: () => [...savedEntries, { type: "custom", customType: "delegate-job", data: orphan2 }],
            },
        },
    );
    assert.equal(savedEntries.at(-1).data.status, "interrupted");
    writeFileSync("/tmp/pi-delegate-fake-empty", "");
    await assert.rejects(
        steerTool.execute("call", { id: "job orphan2", message: "revive: try again" }, undefined, () => {}, {
            ...ctx,
            hasUI: false,
        }),
        /transcript is empty[\s\S]*delegate_steer with id orphan2/,
    );
    rmSync("/tmp/pi-delegate-fake-empty", { force: true });
    assert.equal(savedEntries.filter((entry) => entry.data?.id === "orphan2").at(-1).data.status, "failed");
    // A failed job is revivable: the pinned transcript reopens and the continuation prompt settles it.
    const revivedFailed = await steerTool.execute(
        "call",
        { id: "job orphan2", message: "revive: try again" },
        undefined,
        () => {},
        { ...ctx, hasUI: false },
    );
    assert.match(revivedFailed.content[0].text, /Revived and finished\./);
    assert.equal(revivedFailed.details.id, "orphan2");
    assert.deepEqual(
        savedEntries.filter((entry) => entry.data?.id === "orphan2").map((entry) => entry.data.status),
        ["interrupted", "running", "failed", "running", "done"],
    );
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
    assert.match(cancelledResult, new RegExp(`✓ ${cancelled.details.id} explore cancellation requested`));
    assert.ok(
        colored.some(([color, text]) => color === STATUS_COLORS.done && text === "✓"),
        "cancellation mark must show the call's success, not the job's cancelled status",
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
    // Strict models inject literal "null" (string or JSON null) for optional params they omit;
    // it must not read as job id "null" and fail the call.
    const nulled = await delegate.execute(
        "call",
        { agent: "explore", description: "null params", task: "trace it", model: null },
        undefined,
        () => {},
        tuiCtx,
    );
    await cancel.execute("call", { id: nulled.details.id }, undefined, () => {}, tuiCtx);
    // Steering a finished job revives it in the background under the same id, with a fresh report to come.
    const deliveredRevived = new Promise((resolve) => deliveries.push(resolve));
    const revivedLaunch = await steer.execute(
        "call",
        { id: `job ${cancelled.details.id}`, message: "revive: finish it" },
        undefined,
        () => {},
        tuiCtx,
    );
    assert.equal(revivedLaunch.details.id, cancelled.details.id);
    assert.match(revivedLaunch.content[0].text, /^Revived delegate "explore" in the background/);
    assert.match(
        stripVTControlCharacters(
            steer.renderResult(revivedLaunch, { expanded: false }, theme, { isError: false }).render(120).join("\n"),
        ),
        new RegExp(`${cancelled.details.id} explore revived in background`),
        "revived launch missing its mark in the result header",
    );
    const revivedReport = await Promise.race([deliveredRevived, timeout]);
    assert.equal(revivedReport.details.id, cancelled.details.id);
    assert.equal(revivedReport.details.error, undefined);
} finally {
    clearTimeout(timer);
    process.argv = argv;
    rmSync(fakeCliDir, { recursive: true, force: true });
    rmSync("/tmp/pi-delegate-fake-empty", { force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
}

console.log("pi-delegate check passed");

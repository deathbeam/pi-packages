import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterAll, afterEach, describe, it, vi } from "vitest";
import extension from "../index.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-combos-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const cwds: string[] = [];

afterEach(() => {
    vi.useRealTimers();
});

afterAll(() => {
    for (const cwd of cwds) rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

function model(provider: string, id: string, overrides: Partial<Model<"openai-completions">> = {}): Model<any> {
    return {
        id,
        name: id,
        provider,
        api: "openai-completions",
        baseUrl: "https://example.test",
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 200000,
        maxTokens: 8000,
        ...overrides,
    };
}

function message(id: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: `${id} reply` }],
        api: "openai-completions",
        provider: "anthropic",
        model: id,
        usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        errorMessage: stopReason === "error" ? "boom" : undefined,
        timestamp: Date.now(),
    };
}

function scripted(events: AssistantMessageEvent[]) {
    const stream = createAssistantMessageEventStream();
    for (const event of events) stream.push(event);
    stream.end();
    return stream;
}

const failed = (reason: "error" | "aborted" = "error"): AssistantMessageEvent => ({
    type: "error",
    reason,
    error: message(reason, reason),
});

/** Writes project combos into a fresh cwd and runs session_start against a fake registry. */
function start(
    combos: Record<string, string[]>,
    models: Model<any>[],
    replies: Record<string, AssistantMessageEvent[]>,
) {
    const cwd = mkdtempSync(join(tmpdir(), "pi-combos-cwd-"));
    cwds.push(cwd);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ combos }));

    const providers = new Map<string, any>();
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const pi: any = {
        on: (event: string, handler: (event: any, ctx: any) => any) =>
            handlers.set(event, [...(handlers.get(event) ?? []), handler]),
        registerProvider: (name: string, config: any) => providers.set(name, config),
        unregisterProvider: (name: string) => providers.delete(name),
    };
    const calls: Array<{ member: Model<any>; options: SimpleStreamOptions | undefined }> = [];
    const registry = {
        find: (provider: string, id: string) => models.find((entry) => entry.provider === provider && entry.id === id),
        streamSimple: (member: Model<any>, _context: unknown, options: SimpleStreamOptions | undefined) => {
            calls.push({ member, options });
            return scripted(replies[member.id] ?? [failed()]);
        },
    };

    extension(pi);
    for (const handler of handlers.get("session_start") ?? []) {
        handler({}, { cwd, modelRegistry: registry, hasUI: false });
    }
    return { provider: providers.get("combo"), calls };
}

const combo = (name: string) => ({ id: name }) as Model<any>;

async function send(
    provider: any,
    context: unknown,
    options?: SimpleStreamOptions,
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
    const stream = provider.streamSimple(combo("smart"), context, options);
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    return { events, result: await stream.result() };
}

describe("pi-combos", () => {
    it("registers combo ids at load time, before session_start", () => {
        const cwd = mkdtempSync(join(tmpdir(), "pi-combos-cwd-"));
        cwds.push(cwd);
        mkdirSync(join(cwd, ".pi"));
        writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ combos: { smart: ["anthropic/a"] } }));

        const providers = new Map<string, any>();
        const pi: any = {
            on: () => {},
            registerProvider: (name: string, config: any) => providers.set(name, config),
            unregisterProvider: (name: string) => providers.delete(name),
        };
        const previousCwd = process.cwd();
        process.chdir(cwd);
        try {
            extension(pi);
        } finally {
            process.chdir(previousCwd);
        }

        // pi restores the session model before session_start, so the ids must exist here already.
        const provider = providers.get("combo");
        assert.deepEqual(
            provider.models.map((entry: { id: string }) => entry.id),
            ["smart"],
        );
    });

    it("falls back to the next member on an error before any output", async () => {
        const { provider, calls } = start(
            { smart: ["anthropic/flaky", "openai/ok"] },
            [model("anthropic", "flaky"), model("openai", "ok")],
            {
                flaky: [failed()],
                ok: [
                    { type: "start", partial: message("ok") },
                    { type: "text_start", contentIndex: 0, partial: message("ok") },
                    { type: "done", reason: "stop", message: message("ok") },
                ],
            },
        );
        assert.ok(provider, "combo provider registered");

        const { events, result } = await send(provider, {});
        assert.deepEqual(
            events.map((event) => event.type),
            ["start", "text_start", "done"],
        );
        assert.equal(result.model, "ok");
        assert.deepEqual(
            calls.map((call) => call.member.id),
            ["flaky", "ok"],
        );

        // The failed member cools down, so the next request starts with the healthy one.
        calls.length = 0;
        assert.equal((await send(provider, {})).result.model, "ok");
        assert.deepEqual(
            calls.map((call) => call.member.id),
            ["ok"],
        );
    });

    it("doubles the cooldown on each failure in a row", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const okReply: AssistantMessageEvent[] = [
            { type: "start", partial: message("ok") },
            { type: "text_start", contentIndex: 0, partial: message("ok") },
            { type: "done", reason: "stop", message: message("ok") },
        ];
        const { provider, calls } = start(
            { smart: ["anthropic/flaky", "openai/ok"] },
            [model("anthropic", "flaky"), model("openai", "ok")],
            { flaky: [failed()], ok: okReply },
        );
        const firstTried = async () => {
            calls.length = 0;
            await send(provider, {});
            return calls[0].member.id;
        };

        assert.equal(await firstTried(), "flaky"); // fails: 1 minute
        vi.advanceTimersByTime(61_000);
        assert.equal(await firstTried(), "flaky"); // fails again: 2 minutes
        vi.advanceTimersByTime(61_000);
        assert.equal(await firstTried(), "ok");
        vi.advanceTimersByTime(60_000);
        assert.equal(await firstTried(), "flaky");
    });

    it("does not fall back once a member has produced output", async () => {
        const { provider, calls } = start(
            { smart: ["anthropic/flaky", "openai/ok"] },
            [model("anthropic", "flaky"), model("openai", "ok")],
            {
                flaky: [
                    { type: "start", partial: message("flaky") },
                    { type: "text_start", contentIndex: 0, partial: message("flaky") },
                    failed(),
                ],
            },
        );
        assert.ok(provider, "combo provider registered");

        const { events, result } = await send(provider, {});
        assert.deepEqual(
            events.map((event) => event.type),
            ["start", "text_start", "error"],
        );
        assert.equal(result.stopReason, "error");
        assert.deepEqual(
            calls.map((call) => call.member.id),
            ["flaky"],
        );
    });

    it("propagates an abort without trying the next member", async () => {
        const { provider, calls } = start(
            { smart: ["anthropic/flaky", "openai/ok"] },
            [model("anthropic", "flaky"), model("openai", "ok")],
            {
                flaky: [failed("aborted")],
            },
        );
        assert.ok(provider, "combo provider registered");

        const { events, result } = await send(provider, {});
        assert.deepEqual(
            events.map((event) => event.type),
            ["error"],
        );
        assert.equal(result.stopReason, "aborted");
        assert.equal(calls.length, 1);
    });

    it("strips the combo provider credentials before forwarding to a member", async () => {
        const signal = new AbortController().signal;
        const { provider, calls } = start({ smart: ["openai/ok"] }, [model("openai", "ok")], {
            ok: [{ type: "done", reason: "stop", message: message("ok") }],
        });
        assert.ok(provider, "combo provider registered");

        await send(
            provider,
            {},
            {
                apiKey: "combo-key",
                headers: { authorization: "Bearer combo" },
                env: { SECRET: "1" },
                maxTokens: 100,
                signal,
            },
        );
        assert.equal(calls.length, 1);
        assert.deepEqual(Object.keys(calls[0].options ?? {}).sort(), ["maxTokens", "signal"]);
        assert.equal(calls[0].options?.signal, signal);
    });

    it("uses the strictest member metadata", () => {
        const { provider } = start(
            { smart: ["anthropic/a", "openai/b"] },
            [
                model("anthropic", "a", { contextWindow: 200000, maxTokens: 8000, input: ["text", "image"] }),
                model("openai", "b", { contextWindow: 100000, maxTokens: 4000, input: ["text"], reasoning: true }),
            ],
            {},
        );
        assert.ok(provider, "combo provider registered");

        const [registered] = provider.models;
        assert.equal(registered.id, "smart");
        assert.equal(registered.contextWindow, 100000);
        assert.equal(registered.maxTokens, 4000);
        assert.deepEqual(registered.input, ["text"]);
        assert.equal(registered.reasoning, true);
    });
});

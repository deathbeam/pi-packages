import assert from "node:assert/strict";
import { describe, it } from "vitest";
import extension from "../index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Handler = (event: any, ctx: any) => any;

function setup() {
    const handlers = new Map<string, Handler[]>();
    const pi: any = {
        on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    };
    extension(pi);

    const fire = (name: string, payload: any, ctx: any = context()) => {
        let outcome: any;
        for (const handler of handlers.get(name) ?? []) outcome = handler(payload, ctx) ?? outcome;
        return outcome;
    };
    return { fire };
}

const model = (provider = "mistral") => ({ provider, id: "mistral-medium-3.5", api: "mistral-conversations" });

const context = (current: any = model(), sessionId = "pi-session-1") => ({
    model: current,
    sessionManager: { getSessionId: () => sessionId },
});

const headers = (init: Record<string, string> = {}): Record<string, string> => ({
    accept: "text/event-stream",
    "User-Agent": "pi/1.6.0 (linux; node/v26.13.1; x64)",
    ...init,
});

const payload = (init: Record<string, unknown> = {}) => ({
    model: "mistral-medium-3.5",
    stream: true,
    messages: [],
    ...init,
});

const sendHeaders = (
    fire: (name: string, event: any, ctx?: any) => any,
    ctx?: any,
    init: Record<string, string> = {},
) => {
    const sent = headers(init);
    fire("before_provider_headers", { type: "before_provider_headers", headers: sent }, ctx);
    return sent;
};

describe("request headers", () => {
    it("sends the user agent and affinity on a mistral model", () => {
        const { fire } = setup();
        const sent = sendHeaders(fire);

        assert.equal(sent["User-Agent"], "mistral-client-python/Mistral-Vibe/3.1.4");
        assert.match(sent["x-affinity"], UUID);
        assert.equal(sent.accept, "text/event-stream");
    });

    it("keeps the affinity per session and not across sessions", () => {
        const { fire } = setup();
        const first = sendHeaders(fire);
        const second = sendHeaders(fire);
        assert.equal(first["x-affinity"], second["x-affinity"]);

        const other = sendHeaders(fire, context(model(), "pi-session-2"));
        assert.notEqual(other["x-affinity"], first["x-affinity"]);
    });

    it("leaves other providers and a missing model alone", () => {
        const { fire } = setup();
        for (const current of [model("openai"), model("opencode")]) {
            assert.deepEqual(sendHeaders(fire, context(current)), headers(), current.provider);
        }
        const sent = headers();
        fire("before_provider_headers", { type: "before_provider_headers", headers: sent }, { model: undefined });
        assert.deepEqual(sent, headers());
    });

    it("replaces stale header names case-insensitively", () => {
        const { fire } = setup();
        const sent = sendHeaders(fire, undefined, { "user-agent": "stale", "x-affinity": "pi-session-1" });

        assert.equal(sent["user-agent"], undefined);
        assert.notEqual(sent["x-affinity"], "pi-session-1");
        assert.match(sent["x-affinity"], UUID);
    });
});

describe("request metadata", () => {
    it("adds metadata carrying the same session id and keeps the payload", () => {
        const { fire } = setup();
        const sent = sendHeaders(fire);
        const outcome = fire("before_provider_request", { type: "before_provider_request", payload: payload() });

        assert.equal(outcome.model, "mistral-medium-3.5");
        assert.deepEqual(outcome.messages, []);
        assert.equal(outcome.metadata.session_id, sent["x-affinity"]);
        assert.match(outcome.metadata.message_id, UUID);
        assert.equal(outcome.metadata.call_type, "main_call");
        assert.equal(outcome.metadata.call_source, "vibe_code");
        assert.equal(outcome.metadata.host_kind, "local");
        assert.equal(outcome.metadata.version, "3.1.4");
        assert.equal(outcome.metadata.agent_entrypoint, "cli");
        assert.equal(outcome.metadata.agent_version, "3.1.4");
        assert.equal(outcome.metadata.client_name, "vibe_rs");
        assert.equal(outcome.metadata.client_version, "3.1.4");
        assert.equal(outcome.metadata.terminal_emulator, "unknown");
        assert.ok(["linux", "darwin", "windows", process.platform].includes(outcome.metadata.os));
        assert.equal(typeof outcome.metadata.arch, "string");
        assert.equal(typeof outcome.metadata.os_version, "string");
        assert.equal(outcome.metadata.user_plan, undefined);
        assert.equal(outcome.metadata.parent_session_id, undefined);
    });

    it("skips other providers, missing models and non-object payloads", () => {
        const { fire } = setup();
        const body = payload();

        for (const current of [context(model("openai")), { model: undefined }]) {
            assert.equal(
                fire("before_provider_request", { type: "before_provider_request", payload: body }, current),
                undefined,
            );
        }
        assert.equal(fire("before_provider_request", { type: "before_provider_request", payload: "raw" }), undefined);
        assert.deepEqual(body, payload());
    });
});

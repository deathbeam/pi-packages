import assert from "node:assert/strict";
import { describe, it } from "vitest";
import extension from "../index.ts";

const SESSION_ID = /^ses_[0-9A-Za-z]{26}$/;
const REQUEST_ID = /^msg_[0-9A-Za-z]{26}$/;

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

const ZERO_COST = { input: 0, output: 0 };

const model = (id: string, api = "openai-completions", provider = "opencode", cost = { input: 1, output: 2 }) => ({
    provider,
    id,
    api,
    cost,
});

const free = (id: string, api = "openai-completions") => model(id, api, "opencode", ZERO_COST);

const context = (current = free("big-pickle"), sessionId = "pi-session-1") => ({
    model: current,
    sessionManager: { getSessionId: () => sessionId },
});

const headers = (init: Record<string, string> = {}): Record<string, string> => ({
    "x-opencode-session": "pi-session-1",
    "x-opencode-client": "pi",
    "User-Agent": "pi/1.5.2 (linux; node/v26.13.1; x64)",
    ...init,
});

describe("OpenCode identity headers", () => {
    it("sends the CLI headers for a free model", () => {
        const { fire } = setup();
        const sent = headers();
        fire("before_provider_headers", { type: "before_provider_headers", headers: sent });

        assert.equal(sent["User-Agent"], "opencode/1.19.0");
        assert.equal(sent["x-opencode-client"], "cli");
        assert.equal(sent["x-opencode-project"], "global");
        assert.match(sent["x-opencode-session"], SESSION_ID);
        assert.match(sent["x-opencode-request"], REQUEST_ID);
    });

    it("keeps the session id stable and rotates the request id", () => {
        const { fire } = setup();
        const first = headers();
        const second = headers();
        fire("before_provider_headers", { type: "before_provider_headers", headers: first });
        fire("before_provider_headers", { type: "before_provider_headers", headers: second });

        assert.equal(first["x-opencode-session"], second["x-opencode-session"]);
        assert.notEqual(first["x-opencode-request"], second["x-opencode-request"]);

        const other = headers();
        fire(
            "before_provider_headers",
            { type: "before_provider_headers", headers: other },
            context(free("big-pickle"), "pi-session-2"),
        );
        assert.notEqual(other["x-opencode-session"], first["x-opencode-session"]);
    });

    it("recognizes every zero-cost model", () => {
        const { fire } = setup();
        for (const id of ["big-pickle", "deepseek-v4.1-flash-free", "beam-free"]) {
            const sent = headers();
            fire("before_provider_headers", { type: "before_provider_headers", headers: sent }, context(free(id)));
            assert.equal(sent["x-opencode-client"], "cli", id);
        }
    });

    it("leaves paid models and other providers alone", () => {
        const { fire } = setup();
        const paid = [model("claude-sonnet-5"), model("fake-free"), model("big-pickle", "openai-completions", "other")];
        for (const current of paid) {
            const sent = headers();
            fire("before_provider_headers", { type: "before_provider_headers", headers: sent }, context(current));
            assert.deepEqual(sent, headers(), current.id);
        }
    });

    it("ignores a missing model", () => {
        const { fire } = setup();
        const sent = headers();
        fire("before_provider_headers", { type: "before_provider_headers", headers: sent }, { model: undefined });
        assert.deepEqual(sent, headers());
    });

    it("replaces an existing user-agent case-insensitively", () => {
        const { fire } = setup();
        const sent = headers({ "user-agent": "stale" });
        fire("before_provider_headers", { type: "before_provider_headers", headers: sent });

        assert.equal(sent["user-agent"], undefined);
        assert.equal(sent["User-Agent"], "opencode/1.19.0");
    });
});

describe("free-tier tool declarations", () => {
    const names = (outcome: any) => outcome.tools.map((tool: any) => tool.function.name);

    it("declares the gate tools on a request without tools", () => {
        const { fire } = setup();
        const outcome = fire("before_provider_request", {
            type: "before_provider_request",
            payload: { model: "big-pickle" },
        });

        assert.deepEqual(names(outcome), ["bash", "edit", "glob", "grep", "read"]);
        assert.equal(outcome.tool_choice, "none");
        assert.equal(outcome.model, "big-pickle");
    });

    it("treats an empty tools array as tool-less", () => {
        const { fire } = setup();
        const outcome = fire("before_provider_request", {
            type: "before_provider_request",
            payload: { tools: [] },
        });
        assert.deepEqual(names(outcome), ["bash", "edit", "glob", "grep", "read"]);
    });

    it("adds only the missing gate tools to a request that has tools", () => {
        const { fire } = setup();
        const tool = (name: string) => ({ type: "function", function: { name } });
        const payload = { tools: [tool("read"), tool("bash"), tool("todo")], tool_choice: "auto" };
        const outcome = fire("before_provider_request", { type: "before_provider_request", payload });

        assert.deepEqual(
            outcome.tools.map((entry: any) => entry.function.name),
            ["read", "bash", "todo", "edit", "glob", "grep"],
        );
        assert.equal(outcome.tool_choice, "auto");

        const all = { tools: ["bash", "edit", "glob", "grep", "read"].map(tool) };
        assert.equal(fire("before_provider_request", { type: "before_provider_request", payload: all }), undefined);
    });

    it("skips paid models, other APIs and non-object payloads", () => {
        const { fire } = setup();
        const payload = { model: "big-pickle" };

        for (const current of [model("claude-sonnet-5"), free("big-pickle", "anthropic-messages")]) {
            assert.equal(
                fire("before_provider_request", { type: "before_provider_request", payload }, context(current)),
                undefined,
            );
        }
        assert.equal(fire("before_provider_request", { type: "before_provider_request", payload: "raw" }), undefined);
        assert.deepEqual(payload, { model: "big-pickle" });
    });
});

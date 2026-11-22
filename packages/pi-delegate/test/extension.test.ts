import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, describe, it } from "vitest";
import { COLLAPSED_OUTPUT_LINES } from "../src/format.ts";
import { agentDir, baseCtx, cleanup, keyHint, registerExtension, tempGitRepo, themeStub } from "./helpers.ts";

const { theme, colored } = themeStub();
const argv = process.argv;

afterAll(() => {
    process.argv = argv;
    cleanup();
});

describe("registration", () => {
    it("registers the delegate tools and its TUI command", async () => {
        const app = registerExtension();
        assert.deepEqual(app.tools.map((tool) => tool.name).sort(), [
            "delegate",
            "delegate_apply",
            "delegate_cancel",
            "delegate_discard",
            "delegate_list",
            "delegate_steer",
        ]);
        assert.equal(typeof app.renderReport, "function", "no renderer for delegate reports");
        // The command is TUI-only; an empty session should explain why there is no view.
        let notice: string | undefined;
        await app.inspect.handler("", { mode: "tui", ui: { notify: (message: string) => (notice = message) } });
        assert.match(notice!, /No delegates/);
    });

    it("describes the available agents with their model alias", () => {
        const app = registerExtension();
        // User agent dirs can override bundled agents, so check the alias format rather than one agent.
        assert.match(app.tool("delegate").description, /^- \S+ \(\S+\): /m, "agent list with model alias missing");
    });

    it("lists the model aliases the config and the loaded agents name", () => {
        const app = registerExtension();
        for (const tool of ["delegate", "delegate_steer"]) {
            const description = app.tool(tool).parameters.properties.model.description as string;
            for (const alias of ["cheap", "balanced", "strong"])
                assert.match(description, new RegExp(`\\b${alias}\\b`), `${tool} model alias ${alias} missing`);
            assert.match(description, /provider\/model id/, tool);
        }
        assert.match(
            app.tool("delegate_steer").parameters.properties.model.description,
            /A running job switches live\./,
        );
    });

    // An unset alias silently uses the session model, so session start names it, not every delegate call.
    it("warns once per unset agent alias on session start", () => {
        const settings = join(agentDir, "settings.json");
        writeFileSync(settings, JSON.stringify({ delegate: { models: { cheap: "anthropic/h" } } }));
        try {
            const handlers: Record<string, any> = {};
            registerExtension({ on: (event, handler) => (handlers[event] = handler) });
            const notices: string[] = [];
            const ctx = { ...baseCtx, hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
            handlers.session_start({}, { ...ctx, sessionManager: { getBranch: () => [] } });
            // general and reviewer share an alias each with another agent; both warn once.
            assert.equal(notices.length, 2);
            assert.ok(notices.some((notice) => /"balanced"/.test(notice)));
            assert.ok(notices.some((notice) => /"strong"/.test(notice)));
            assert.ok(notices.every((notice) => !/"cheap"/.test(notice)));
        } finally {
            rmSync(settings, { force: true });
        }
    });

    // The model must learn from the tool description that steering continues or redirects any job.
    it("tells the model how to steer and how to behave around delegates", () => {
        const app = registerExtension();
        const delegate = app.tool("delegate");
        assert.match(delegate.description, /follow up on or redirect an existing job, see delegate_steer/);
        const guidelines = delegate.promptGuidelines.join("\n");
        assert.match(guidelines, /You are the orchestrator/);
        assert.match(guidelines, /While delegates run, stay outside their scopes/);
        assert.match(guidelines, /required delegate report before claiming the task is done/);
        assert.match(guidelines, /call any tool solely to wait/);
    });

    it("takes no discard flag on delegate_apply", () => {
        const app = registerExtension();
        assert.equal("discard" in app.tool("delegate_apply").parameters.properties, false);
    });
});

describe("exploration nudges", () => {
    // Drift reminder: only the orchestrating session, at 5 then 10 direct calls, and a delegate call resets it.
    const nudged = (activeTools: string[]) => {
        const handlers: Record<string, (payload: any) => void> = {};
        const app = registerExtension({ activeTools, on: (event, handler) => (handlers[event] = handler) });
        return {
            reminders: app.messages,
            prompt: () => handlers.before_agent_start({ messageType: "user" }),
            customRun: () => handlers.before_agent_start({ messageType: "custom" }),
            call: (toolName: string, parentToolCallId?: string) => handlers.tool_result({ toolName, parentToolCallId }),
        };
    };

    it("reminds the orchestrator at 5 and 10 direct calls, reset by a delegate call", () => {
        const parent = nudged(["read", "delegate"]);
        for (const tool of ["grep", "grep", "read", "edit", "ls"]) parent.call(tool);
        assert.equal(parent.reminders.length, 0, "edits are not exploration");
        parent.call("bash");
        assert.equal(parent.reminders.length, 1);
        assert.equal(parent.reminders[0].message.display, false);
        assert.deepEqual(parent.reminders[0].options, { deliverAs: "steer" });
        assert.match(parent.reminders[0].message.content, /5 direct exploration calls/);
        for (let i = 0; i < 4; i++) parent.call("read");
        assert.equal(parent.reminders.length, 1, "the second reminder waits for 10 calls");
        parent.call("read");
        assert.equal(parent.reminders.length, 2);
        parent.call("delegate");
        for (let i = 0; i < 5; i++) parent.call("read");
        assert.equal(parent.reminders.length, 3, "a delegate call resets the count");
    });

    it("never nudges a session that cannot delegate", () => {
        const childSession = nudged(["read"]);
        for (let i = 0; i < 10; i++) childSession.call("read");
        assert.equal(childSession.reminders.length, 0, "children cannot delegate, so they are never nudged");
    });

    it("ignores script-issued calls and resets on a user prompt", () => {
        const scripted = nudged(["delegate"]);
        for (let i = 0; i < 10; i++) scripted.call("grep", "codemode-call");
        assert.equal(scripted.reminders.length, 0, "calls a script issued are not the model's own steps");
        for (let i = 0; i < 4; i++) scripted.call("read");
        scripted.prompt();
        scripted.call("read");
        assert.equal(scripted.reminders.length, 0, "a new prompt resets the count");
        // One call already landed after the reset; three more reach the fifth, so only a reset here hides the nudge.
        for (let i = 0; i < 3; i++) scripted.call("read");
        scripted.customRun();
        scripted.call("read");
        assert.equal(scripted.reminders.length, 1, "a triggered custom message does not reset the count");
    });
});

describe("delegate launch without a CLI entrypoint", () => {
    // Missing CLI argv must fail before spawning a child.
    it("fails before spawning", async () => {
        const app = registerExtension();
        process.argv = [argv[0]];
        try {
            await assert.rejects(
                app
                    .tool("delegate")
                    .execute(
                        "call",
                        { agent: "explore", description: "find callers", task: "trace it" },
                        undefined,
                        () => {},
                        baseCtx,
                    ),
                /CLI entrypoint/,
            );
        } finally {
            process.argv = argv;
        }
    });

    // A launch that cannot spawn must not leave an isolated clone behind.
    it("leaves no clone behind", async () => {
        const app = registerExtension();
        const repo = tempGitRepo({ "seed.txt": "seed\n" });
        try {
            process.argv = [argv[0]];
            try {
                await assert.rejects(
                    app
                        .tool("delegate")
                        .execute(
                            "call",
                            { agent: "explore", description: "leak", task: "trace it", isolated: true },
                            undefined,
                            () => {},
                            { ...baseCtx, cwd: repo.dir },
                        ),
                    /CLI entrypoint/,
                );
            } finally {
                process.argv = argv;
            }
            assert.equal(existsSync(join(repo.dir, ".pi", "worktrees")), false, "failed launch left a clone behind");
        } finally {
            repo.remove();
        }
    });
});

describe("tool renderers", () => {
    // delegate_list keeps Pi's default call line; delegate_cancel and delegate_discard also keep Pi's default result
    // rendering. The rest use compact call headers and keep failures visible.
    const defaultResultTools = new Set(["delegate_cancel", "delegate_discard"]);

    it("renders every tool call header and keeps failures visible", () => {
        const app = registerExtension();
        for (const tool of app.tools) {
            if (tool.name !== "delegate_list") {
                assert.equal(typeof tool.renderCall, "function", `${tool.name} has no call renderer`);
                const partial = tool.renderCall({}, theme, { expanded: false, argsComplete: false }).render(80);
                assert.ok(stripVTControlCharacters(partial[0]).trim().startsWith(tool.name));
                assert.doesNotMatch(partial.join("\n"), /undefined/);
            }
            if (defaultResultTools.has(tool.name)) {
                assert.equal(tool.renderResult, undefined, `${tool.name} should inherit Pi's default result rendering`);
                continue;
            }
            assert.equal(typeof tool.renderResult, "function", `${tool.name} has no result renderer`);
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
                { isError: false, keyHint },
            );
            assert.match(fallback.render(80).join("\n"), /Plain result/);
            assert.ok(colored.some(([color, text]) => color === "toolOutput" && text.includes("Plain result")));
        }
    });

    // Collapse after wrapping: a long single-line message must not become an unbounded tool card.
    it("caps the collapsed call preview and expands it", () => {
        const app = registerExtension();
        const longPayload = "START-OF-PAYLOAD " + "漢🙂 words ".repeat(600) + " END-OF-PAYLOAD";
        for (const name of ["delegate", "delegate_steer"]) {
            const tool = app.tool(name);
            const args = {
                agent: "general",
                id: "deadbeef",
                description: "Short description",
                task: longPayload,
                message: longPayload,
            };
            const collapsed = tool.renderCall(args, theme, { expanded: false, keyHint });
            for (const width of [32, 80, 120]) {
                const rows = collapsed.render(width);
                const plain = rows.map(stripVTControlCharacters);
                assert.ok(rows.length <= COLLAPSED_OUTPUT_LINES + 3, `${name} preview grew past its visual line cap`);
                assert.ok(
                    rows.every((row: string) => visibleWidth(row) <= width),
                    `${name} overflowed ${width} columns`,
                );
                assert.match(
                    plain[0],
                    new RegExp(name === "delegate" ? "^delegate general" : "^delegate_steer deadbeef"),
                );
                assert.doesNotMatch(plain[0], /START-OF-PAYLOAD/);
                if (name === "delegate" && width === 120)
                    assert.match(plain[0], /Short description/, "launch summary missing from header");
                assert.equal(plain[1].trim(), "", "payload needs a separator below the header");
                assert.match(plain.join("\n"), /START-OF-PAYLOAD/);
                assert.doesNotMatch(plain.join("\n"), /END-OF-PAYLOAD/);
            }
            assert.match(collapsed.render(120).join("\n"), /more lines.*to expand/);
            collapsed.invalidate();
            const expanded = tool.renderCall(args, theme, { expanded: true, keyHint }).render(80);
            assert.match(expanded.join("\n"), /END-OF-PAYLOAD/);
            assert.ok(expanded.length > COLLAPSED_OUTPUT_LINES + 3);
            assert.ok(expanded.every((row: string) => visibleWidth(row) <= 80));
            assert.doesNotMatch(expanded.join("\n"), /more lines.*to expand/);
            const indented = "    keep indentation";
            const preserved = tool
                .renderCall({ ...args, description: "", task: indented, message: indented }, theme, {
                    expanded: true,
                    keyHint,
                })
                .render(80);
            assert.ok(
                preserved.some((row: string) => stripVTControlCharacters(row).startsWith(indented)),
                `${name} trimmed payload indentation`,
            );
            const blank = tool
                .renderCall({ ...args, description: "", task: " \n ", message: " \n " }, theme, {
                    expanded: true,
                    keyHint,
                })
                .render(80);
            assert.equal(blank.length, 1, `${name} rendered blank payload rows`);
        }
    });
});

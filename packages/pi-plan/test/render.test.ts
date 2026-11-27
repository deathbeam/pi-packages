import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, it } from "vitest";
import extension from "../index.ts";

initTheme("dark");

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every token renders as plain text, so assertions read the stripped output directly. */
const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const context: any = { isError: false, keyHint: () => "to expand" };

function setup() {
    const dir = mkdtempSync(join(tmpdir(), "pi-plan-render-"));
    dirs.push(dir);
    const tools: Record<string, any> = {};
    extension({
        registerTool: (tool: any) => (tools[tool.name] = tool),
        registerCommand: () => {},
        on: () => {},
        appendEntry: () => {},
    } as any);
    const ctx: any = {
        cwd: dir,
        hasUI: true,
        mode: "tui",
        sessionManager: { getBranch: () => [] },
        ui: { theme, setWidget() {}, notify() {} },
    };
    return { tool: tools.plan!, ctx };
}

type Setup = ReturnType<typeof setup>;

function call(setup: Setup, params: Record<string, unknown>): Promise<any> {
    return setup.tool.execute("call", params, undefined, undefined, setup.ctx);
}

function view(setup: Setup, result: any, expanded = false, isError = false): string[] {
    const component = setup.tool.renderResult(result, { expanded, isPartial: false }, theme, {
        ...context,
        expanded,
        isError,
    });
    // Text pads every row to the width, so compare the visible text only.
    return component.render(100).map((line: string) => line.trimEnd());
}

function callView(setup: Setup, args: Record<string, unknown>): string {
    return setup.tool
        .renderCall(args, theme, context)
        .render(100)
        .map((line: string) => line.trimEnd())
        .join("\n");
}

const plan = {
    action: "create",
    name: "foo",
    goal: "ship the widget",
    context: "src/widget.ts renders nothing yet",
    tasks: [
        { title: "render the widget", where: "src/widget.ts", doneWhen: "npm test -- widget: 1 passed" },
        { title: "wire the tool", blockedBy: ["t1"], doneWhen: "npm run check: no errors" },
    ],
};

function many(count: number) {
    return {
        ...plan,
        tasks: Array.from({ length: count }, (_, index) => ({ title: `task ${index + 1}`, doneWhen: "x" })),
    };
}

describe("renderCall", () => {
    it("names the action and its key argument on one line", () => {
        const setup_ = setup();
        assert.equal(
            callView(setup_, { action: "create", name: "foo", goal: "g", context: "c", tasks: [] }),
            "plan create foo",
        );
        assert.equal(callView(setup_, { action: "get" }), "plan get");
        assert.equal(callView(setup_, { action: "get", name: "foo", id: "t2" }), "plan get foo t2");
        assert.equal(callView(setup_, { action: "list" }), "plan list");
        assert.equal(
            callView(setup_, { action: "update", id: "t1", status: "doing", note: "dispatched" }),
            "plan update t1 doing · dispatched",
        );
        assert.equal(callView(setup_, { action: "update", id: "t1", status: "null" }), "plan update t1");
    });

    it("truncates a long note", () => {
        const setup_ = setup();
        const note = "x".repeat(100);
        assert.equal(callView(setup_, { action: "update", id: "t1", note }).length, "plan update t1 · ".length + 60);
    });
});

describe("create", () => {
    it("renders the summary, a row per task and the blockers", async () => {
        const setup_ = setup();
        const result = await call(setup_, plan);
        const lines = view(setup_, result);

        assert.equal(lines[0], "");
        assert.equal(lines[1], "plan foo 0/2 · next t1");
        assert.equal(lines[2], "○ t1 render the widget");
        assert.equal(lines[3], "○ t2 wire the tool · blockedBy t1");
    });

    it("adds goal, context, checks and notes when expanded", async () => {
        const setup_ = setup();
        const result = await call(setup_, {
            ...plan,
            tasks: [{ title: "a", where: "src/a.ts", doneWhen: "x", status: "done", notes: ["Ruling: dropped it"] }],
        });
        const collapsed = view(setup_, result);
        assert.ok(!collapsed.some((line) => line.includes("Goal:")));
        assert.ok(!collapsed.some((line) => line.includes("Done when:")));

        const expanded = view(setup_, result, true);
        assert.ok(expanded.includes("  Goal: ship the widget"));
        assert.ok(expanded.includes("  Context: src/widget.ts renders nothing yet"));
        assert.ok(expanded.includes("  Where: src/a.ts"));
        assert.ok(expanded.includes("  Done when: x"));
        assert.ok(expanded.includes("  Ruling: dropped it"));
        assert.equal(expanded[1], "plan foo 1/1");
    });

    it("caps the collapsed view with pi's more-lines hint", async () => {
        const setup_ = setup();
        const result = await call(setup_, many(12));
        const collapsed = view(setup_, result);

        assert.equal(collapsed.length, 12);
        assert.equal(collapsed.at(-1), "... (3 more lines, to expand)");
        assert.equal(view(setup_, result, true).length, 28);
    });
});

describe("update", () => {
    it("renders the changed task, where the plan stands and the note", async () => {
        const setup_ = setup();
        const created = await call(setup_, plan);
        const result = await call(setup_, { action: "update", id: "t1", status: "done", note: "npm test: 1 passed" });
        const lines = view(setup_, result);

        assert.equal(text_of(created), "plan foo 0/2");
        assert.deepEqual(lines, ["", "✓ t1 render the widget", "  npm test: 1 passed", "foo 1/2 · next t2"]);
    });

    it("omits the note row when the call only changed the status", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        const result = await call(setup_, { action: "update", id: "t1", status: "blocked" });
        assert.deepEqual(view(setup_, result), ["", "✗ t1 render the widget", "foo 0/2"]);
    });
});

describe("get", () => {
    it("renders the whole plan", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        const lines = view(setup_, await call(setup_, { action: "get" }));

        assert.equal(lines[1], "plan foo 0/2 · next t1");
        assert.equal(lines[2], "○ t1 render the widget");
    });

    it("renders one task as a row plus its brief", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        assert.deepEqual(view(setup_, await call(setup_, { action: "get", id: "t2" })), [
            "",
            "○ t2 wire the tool · blockedBy t1",
            "  Done when: npm run check: no errors",
        ]);
    });

    it("drops a blocker that is already done", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        await call(setup_, { action: "update", id: "t1", status: "done" });
        assert.equal(view(setup_, await call(setup_, { action: "get", id: "t2" }))[1], "○ t2 wire the tool");
    });

    it("wraps a long note under its label", async () => {
        const setup_ = setup();
        const note = Array.from({ length: 60 }, (_, index) => `w${index}`).join(" ");
        const result = await call(setup_, { ...plan, tasks: [{ title: "a", doneWhen: "x", notes: [note] }] });
        const lines = view(setup_, result, true);
        const start = lines.findIndex((line) => line.startsWith("  w0 "));
        assert.ok(start >= 0);
        assert.match(lines[start + 1]!, /^ {2}w/);
    });
});

describe("list", () => {
    it("shows a row per plan, marks the active one and names unreadable files", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        await call(setup_, { ...plan, name: "other", tasks: [] });
        const dir = join(setup_.ctx.cwd, ".pi", "plans");
        writeFileSync(join(dir, "broken.json"), "{ not json");

        const lines = view(setup_, await call(setup_, { action: "list" }));
        assert.deepEqual(lines, ["", "  foo 0/2 · next t1", "› other 0/0", "? broken unreadable"]);
    });
});

describe("errors", () => {
    it("falls back to the content text in the error color", async () => {
        const setup_ = setup();
        const result = { content: [{ type: "text", text: "Plan foo has no task t9." }], details: undefined };
        assert.deepEqual(view(setup_, result, false, true), ["", "✗ Plan foo has no task t9."]);
    });
});

function text_of(result: any): string {
    return result.content[0].text.split("\n")[0];
}

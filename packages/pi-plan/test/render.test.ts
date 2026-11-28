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
    // Text pads every row to the width and markdown colors it, so compare the visible text only.
    return component.render(100).map((line: string) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd());
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
    plan: "foo",
    title: "ship the widget",
    goal: "the widget ships",
    detail: "src/widget.ts renders nothing yet",
    tasks: [
        { title: "render the widget", goal: "npm test -- widget: 1 passed", detail: "src/widget.ts" },
        { title: "wire the tool", goal: "npm run check: no errors", detail: "src/tool.ts", dependsOn: ["t1"] },
    ],
};

function many(count: number) {
    return {
        ...plan,
        tasks: Array.from({ length: count }, (_, index) => ({ title: `task ${index + 1}`, goal: "x", detail: "d" })),
    };
}

describe("renderCall", () => {
    it("names the action and its key argument on one line", () => {
        const setup_ = setup();
        assert.equal(
            callView(setup_, { action: "create", plan: "foo", title: "t", goal: "g", detail: "d", tasks: [] }),
            "plan create foo",
        );
        assert.equal(callView(setup_, { action: "get" }), "plan get");
        assert.equal(callView(setup_, { action: "get", plan: "foo", task: "t2" }), "plan get foo t2");
        assert.equal(callView(setup_, { action: "list" }), "plan list");
        assert.equal(
            callView(setup_, { action: "update", task: "t1", status: "doing", note: "dispatched" }),
            "plan update t1 doing · dispatched",
        );
        assert.equal(callView(setup_, { action: "update", task: "t1", status: "null" }), "plan update t1");
    });

    it("truncates a long note", () => {
        const setup_ = setup();
        const note = "x".repeat(100);
        assert.equal(callView(setup_, { action: "update", task: "t1", note }).length, "plan update t1 · ".length + 60);
    });
});

describe("create", () => {
    it("renders the summary, a row per task and the dependencies", async () => {
        const setup_ = setup();
        const result = await call(setup_, plan);
        const lines = view(setup_, result);

        assert.equal(lines[0], "");
        assert.equal(lines[1], "plan foo ship the widget 0/2");
        assert.equal(lines[2], "○ t1 render the widget");
        assert.equal(lines[3], "○ t2 wire the tool · dependsOn t1");
    });

    it("renders the summary and one row per task, with the facts expanded", async () => {
        const setup_ = setup();
        const result = await call(setup_, {
            ...plan,
            tasks: [{ title: "a", goal: "x", detail: "src/a.ts", status: "done", notes: ["dropped it"] }],
        });
        const collapsed = view(setup_, result);
        assert.equal(collapsed[1], "plan foo ship the widget 1/1");
        assert.ok(!collapsed.some((line) => line.includes("src/a.ts")));

        const expanded = view(setup_, result, true);
        assert.ok(expanded.includes("  Goal: the widget ships"));
        assert.ok(expanded.includes("  Detail: src/widget.ts renders nothing yet"));
        assert.ok(expanded.includes("  Detail: src/a.ts"));
        assert.ok(expanded.includes("  dropped it"));
    });

    it("caps the collapsed view with pi's more-lines hint", async () => {
        const setup_ = setup();
        const result = await call(setup_, many(12));
        const collapsed = view(setup_, result);

        assert.equal(collapsed.length, 12);
        assert.match(collapsed.at(-1)!, /^\.\.\. \(\d+ more lines, to expand\)$/);
        assert.ok(view(setup_, result, true).some((line) => line.includes("t12 task 12")));
    });
});

describe("update", () => {
    it("renders the changed task, where the plan stands and the note", async () => {
        const setup_ = setup();
        const created = await call(setup_, plan);
        const result = await call(setup_, { action: "update", task: "t1", status: "done", note: "npm test: 1 passed" });
        const lines = view(setup_, result);

        assert.equal(text_of(created), "# Plan foo: ship the widget (0/2 done)");
        assert.deepEqual(lines, ["", "✓ t1 render the widget", "  npm test: 1 passed", "foo ship the widget 1/2"]);
    });

    it("omits the note row when the call only changed the status", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        const result = await call(setup_, { action: "update", task: "t1", status: "blocked" });
        assert.deepEqual(view(setup_, result), ["", "✗ t1 render the widget", "foo ship the widget 0/2"]);
    });

    it("renders a plan note when the call names no task", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        const result = await call(setup_, { action: "update", note: "Ruling: widget stays in src" });
        assert.deepEqual(view(setup_, result), ["", "  Ruling: widget stays in src", "foo ship the widget 0/2"]);
    });
});

describe("get", () => {
    it("renders the whole plan as markdown", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        const lines = view(setup_, await call(setup_, { action: "get" }), true);

        assert.equal(lines[0], "");
        assert.equal(lines[1], "Plan foo: ship the widget (0/2 done)");
        assert.deepEqual(
            lines.filter((line) => line.startsWith("Task ")),
            ["Task t1 [todo]: render the widget", "Task t2 [todo]: wire the tool"],
        );
        assert.ok(lines.includes("the widget ships"));
        assert.ok(lines.includes("src/widget.ts renders nothing yet"));
    });

    it("renders one task with the plan's goal and detail", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        const lines = view(setup_, await call(setup_, { action: "get", task: "t2" }), true);

        assert.ok(lines.includes("Plan foo: ship the widget (0/2 done)"));
        assert.ok(lines.includes("Depends on: t1"));
        assert.ok(lines.includes("npm run check: no errors"));
        assert.ok(lines.includes("src/tool.ts"));
        assert.ok(!lines.some((line) => line.includes("render the widget")));
    });

    it("caps the task brief until the result is expanded", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        const collapsed = view(setup_, await call(setup_, { action: "get", task: "t2" }));

        assert.equal(collapsed.length, 12);
        assert.match(collapsed.at(-1)!, /^\.\.\. \(\d+ more lines, to expand\)$/);
    });

    it("keeps a declared dependency that is already done", async () => {
        const setup_ = setup();
        await call(setup_, plan);
        await call(setup_, { action: "update", task: "t1", status: "done" });
        const lines = view(setup_, await call(setup_, { action: "get", task: "t2" }), true);
        assert.ok(lines.includes("Depends on: t1"));
    });

    it("wraps a long note under its label", async () => {
        const setup_ = setup();
        const note = Array.from({ length: 60 }, (_, index) => `w${index}`).join(" ");
        const result = await call(setup_, {
            ...plan,
            tasks: [{ title: "a", goal: "x", detail: "src/a.ts", notes: [note] }],
        });
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
        await call(setup_, { ...plan, plan: "other", title: "other plan", tasks: [] });
        const dir = join(setup_.ctx.cwd, ".pi", "plans");
        writeFileSync(join(dir, "broken.json"), "{ not json");

        const lines = view(setup_, await call(setup_, { action: "list" }));
        assert.deepEqual(lines, ["", "  foo ship the widget 0/2", "› other other plan 0/0", "? broken unreadable"]);
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

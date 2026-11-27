import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, it } from "vitest";
import extension from "../index.ts";
import { PlansScreen } from "../src/inspector.ts";
import { nextTask, type Plan, type PlanTask } from "../src/store.ts";

initTheme("dark");

const dirs: string[] = [];

function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-plan-test-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function themeStub() {
    const colors: string[] = [];
    const theme: any = {
        fg: (color: string, text: string) => (colors.push(color), text),
    };
    return { theme, colors };
}

function setup(cwd: string, branch: unknown[] = []) {
    const tools: Record<string, any> = {};
    const commands: Record<string, any> = {};
    const handlers: Record<string, (...args: any[]) => any> = {};
    const entries: any[] = [];
    extension({
        registerTool: (tool: any) => (tools[tool.name] = tool),
        registerCommand: (name: string, command: any) => (commands[name] = command),
        on: (event: string, handler: any) => (handlers[event] = handler),
        appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    } as any);
    const state = { widget: undefined as any, notes: [] as string[], theme: themeStub().theme };
    const ctx: any = {
        cwd,
        hasUI: true,
        mode: "tui",
        sessionManager: { getBranch: () => branch },
        ui: {
            theme: state.theme,
            setWidget: (_key: string, content: any) => (state.widget = content),
            notify: (message: string) => state.notes.push(message),
        },
    };
    return { tools, commands, handlers, ctx, state, entries };
}

type Setup = ReturnType<typeof setup>;

function call(setup: Setup, params: Record<string, unknown>): Promise<any> {
    return setup.tools.plan!.execute("call", params, undefined, undefined, setup.ctx);
}

function text(result: any): string {
    return result.content[0].text;
}

function sample(overrides: Record<string, unknown> = {}) {
    return {
        action: "create",
        name: "foo",
        goal: "ship the widget",
        context: "src/widget.ts renders nothing yet",
        tasks: [
            { title: "render the widget", where: "src/widget.ts", doneWhen: "npm test -- widget: 1 passed" },
            { title: "wire the tool", blockedBy: ["t1"], doneWhen: "npm run check: no errors" },
        ],
        ...overrides,
    };
}

const second = { name: "second", goal: "g2", context: "c2" };

function stored(setup: Setup, name: string): Plan {
    return JSON.parse(readFileSync(join(setup.ctx.cwd, ".pi", "plans", `${name}.json`), "utf8"));
}

describe("create", () => {
    it("assigns ids, writes the plan and fills the widget", async () => {
        const setup_ = setup(project());
        const result = await call(setup_, sample());

        assert.equal(result.details.active, "foo");
        assert.match(text(result), /plan foo 0\/2/);
        assert.match(text(result), /t1 \[todo\] render the widget — where src\/widget\.ts/);
        assert.match(text(result), /t2 \[todo\] wire the tool — blockedBy t1/);
        assert.deepEqual(
            stored(setup_, "foo").tasks.map((task) => task.id),
            ["t1", "t2"],
        );
        assert.deepEqual(setup_.state.widget, ["plan foo 0/2 · next t1"]);
    });

    it("keeps imported statuses and notes", async () => {
        const setup_ = setup(project());
        const result = await call(
            setup_,
            sample({
                tasks: [
                    { title: "a", doneWhen: "x", status: "done", notes: ["Ruling: dropped the cache"] },
                    { title: "b", doneWhen: "y", status: "doing" },
                ],
            }),
        );

        assert.match(text(result), /t1 \[done\] a/);
        assert.match(text(result), / {2}note: Ruling: dropped the cache/);
        assert.deepEqual(setup_.state.widget, ["plan foo 1/2 · doing t2"]);
    });

    it("rejects a plan that already exists", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await assert.rejects(call(setup_, sample()), /already exists/);
    });

    it("rejects a blockedBy id no task has", async () => {
        const setup_ = setup(project());
        await assert.rejects(
            call(setup_, sample({ tasks: [{ title: "a", blockedBy: ["t9"], doneWhen: "x" }] })),
            /lacks/,
        );
        assert.equal(existsSync(join(setup_.ctx.cwd, ".pi", "plans", "foo.json")), false);
    });

    it("rejects a blockedBy id that is not earlier", async () => {
        const setup_ = setup(project());
        await assert.rejects(
            call(
                setup_,
                sample({
                    tasks: [
                        { title: "a", blockedBy: ["t2"], doneWhen: "x" },
                        { title: "b", doneWhen: "y" },
                    ],
                }),
            ),
            /blockedBy takes only earlier ids/,
        );
        await assert.rejects(
            call(setup_, sample({ tasks: [{ title: "a", blockedBy: ["t1"], doneWhen: "x" }] })),
            /blockedBy takes only earlier ids/,
        );
    });

    it("rejects a name that escapes the plans directory", async () => {
        const setup_ = setup(project());
        await assert.rejects(call(setup_, sample({ name: "../evil" })), /kebab-case/);
        await assert.rejects(call(setup_, sample({ name: "a/b" })), /kebab-case/);
        assert.equal(existsSync(join(setup_.ctx.cwd, ".pi", "plans")), false);
    });
});

describe("update", () => {
    it("sets the status and appends notes", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());

        const first = await call(setup_, { action: "update", id: "t1", status: "done", note: "npm test: 1 passed" });
        assert.match(text(first), /t1 \[done\]/);
        assert.match(text(first), /^foo 1\/\d+/m);
        assert.doesNotMatch(text(first), /goal:/);

        await call(setup_, { action: "update", id: "t1", status: "blocked", note: "Ruling: widget moved" });
        assert.deepEqual(stored(setup_, "foo").tasks[0]!.notes, ["npm test: 1 passed", "Ruling: widget moved"]);
        assert.equal(stored(setup_, "foo").tasks[0]!.status, "blocked");
    });

    it("changes only the fields given", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        const result = await call(setup_, { action: "update", id: "t1", note: "delegate reported back" });
        assert.match(text(result), /t1 \[todo\] render the widget/);
        assert.deepEqual(stored(setup_, "foo").tasks[0]!.notes, ["delegate reported back"]);
    });

    it("rejects a missing status or note, or a missing task", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await assert.rejects(call(setup_, { action: "update", id: "t1" }), /needs status or note/);
        await assert.rejects(call(setup_, { action: "update", id: "t9", status: "done" }), /no task t9/);
    });

    it("rejects a call with no active plan", async () => {
        const setup_ = setup(project());
        await assert.rejects(call(setup_, { action: "get" }), /No active plan/);
    });
});

describe("get and list", () => {
    it("returns the whole plan, or one task as a brief slice", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());

        const whole = await call(setup_, { action: "get" });
        assert.match(text(whole), /goal: ship the widget/);
        assert.match(text(whole), /context: src\/widget\.ts renders nothing yet/);

        const slice = await call(setup_, { action: "get", name: "foo", id: "t2" });
        assert.match(text(slice), /t2 \[todo\] wire the tool/);
        assert.match(text(slice), /doneWhen: npm run check: no errors/);
        assert.doesNotMatch(text(slice), /render the widget/);
    });

    it("lists plans with counts and the next task", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await call(setup_, sample({ name: "other", goal: "g", context: "c", tasks: [] }));

        const result = await call(setup_, { action: "list" });
        assert.match(text(result), / {2}foo 0\/2 · next t1/);
        assert.match(text(result), /\* other 0\/0/);
    });

    it("names unreadable plan files instead of failing", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        const dir = join(setup_.ctx.cwd, ".pi", "plans");
        writeFileSync(join(dir, "broken.json"), "{ not json");
        writeFileSync(join(dir, "shape.json"), JSON.stringify({ name: "shape", goal: "g" }));
        const result = await call(setup_, { action: "list" });
        assert.match(text(result), /\? broken unreadable/);
        assert.match(text(result), /\? shape unreadable/);
    });

    it('drops null and "null" optionals, including a task where', async () => {
        const setup_ = setup(project());
        await assert.rejects(call(setup_, sample({ goal: "null" })), /create needs/);
        await call(setup_, sample({ tasks: [{ title: "a", where: "null", doneWhen: "x" }] }));
        assert.equal("where" in stored(setup_, "foo").tasks[0]!, false);
        const result = await call(setup_, { action: "get", name: "null", id: "null", note: null, status: null });
        assert.match(text(result), /plan foo 0\/1/);
        assert.match(text(result), /t1 \[todo\] a/);
        assert.match(text(result), / {2}doneWhen: x/);
    });
});

describe("nextTask", () => {
    function plan(tasks: Array<Partial<PlanTask>>): Plan {
        return {
            name: "p",
            goal: "g",
            context: "c",
            tasks: tasks.map((task, index) => ({
                id: `t${index + 1}`,
                title: "x",
                blockedBy: [],
                doneWhen: "y",
                status: "todo",
                notes: [],
                ...task,
            })),
        };
    }

    it("skips a todo task whose blocker is open", () => {
        assert.equal(nextTask(plan([{ blockedBy: ["t2"] }, {}]))?.id, "t2");
        assert.equal(nextTask(plan([{}, { blockedBy: ["t1"] }]))?.id, "t1");
        assert.equal(nextTask(plan([{ status: "doing" }, { blockedBy: ["t1"] }])), undefined);
    });

    it("unblocks a task after its blocker is marked done", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await call(setup_, { action: "update", id: "t1", status: "done" });
        assert.deepEqual(setup_.state.widget, ["plan foo 1/2 · next t2"]);
    });
});

describe("active plan restore", () => {
    const toolResult = (active: string) => ({
        type: "message",
        message: { role: "toolResult", toolName: "plan", content: [], details: { action: "get", active } },
    });
    const branch = (names: string[]) => names.map(toolResult);

    it("uses the last plan tool result on the branch", async () => {
        const cwd = project();
        const created = setup(cwd);
        await call(created, sample());
        await call(created, sample(second));

        const restored = setup(cwd, branch(["foo", "second"]));
        restored.handlers.session_start!({}, restored.ctx);
        assert.deepEqual(restored.state.widget, ["plan second 0/2 · next t1"]);

        const result = await call(restored, { action: "get" });
        assert.match(text(result), /plan second 0\/2/);
    });

    it("clears the widget when the restored plan is gone", () => {
        const restored = setup(project(), branch(["missing"]));
        restored.handlers.session_tree!({}, restored.ctx);
        assert.equal(restored.state.widget, undefined);
    });

    it("takes the later of a tool result and a /plan selection", async () => {
        const cwd = project();
        const created = setup(cwd);
        await call(created, sample());
        await call(created, sample(second));
        const custom = (data: string) => ({ type: "custom", customType: "plan", data });

        const afterSelection = setup(cwd, [toolResult("second"), custom("foo")]);
        afterSelection.handlers.session_start!({}, afterSelection.ctx);
        assert.deepEqual(afterSelection.state.widget, ["plan foo 0/2 · next t1"]);

        const afterTool = setup(cwd, [custom("foo"), toolResult("second")]);
        afterTool.handlers.session_start!({}, afterTool.ctx);
        assert.deepEqual(afterTool.state.widget, ["plan second 0/2 · next t1"]);
    });
});

describe("/plan", () => {
    it("shows the active plan as text outside the TUI", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        setup_.ctx.mode = "print";
        await setup_.commands.plan!.handler("", setup_.ctx);
        assert.match(setup_.state.notes[0]!, /goal: ship the widget/);
    });

    it("sets a named plan active", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await call(setup_, sample({ ...second, tasks: [] }));
        await setup_.commands.plan!.handler("foo", setup_.ctx);
        assert.match(setup_.state.notes.at(-1)!, /Active plan: foo/);
        assert.deepEqual(setup_.state.widget, ["plan foo 0/2 · next t1"]);
        assert.deepEqual(setup_.entries.at(-1), { type: "custom", customType: "plan", data: "foo" });
    });

    it("opens the picker as a full-screen overlay", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        const keys: any = { matches: () => false, getKeys: () => [] };
        let screen: unknown;
        setup_.ctx.ui.custom = (factory: any, options: any) => {
            screen = options;
            factory({ terminal: { rows: 20 }, requestRender() {} }, setup_.state.theme, keys, () => {});
            return Promise.resolve();
        };
        await setup_.commands.plan!.handler("", setup_.ctx);
        assert.deepEqual(screen, {
            overlay: true,
            overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0 },
        });
    });
});

describe("PlansScreen", () => {
    const foo: Plan = {
        name: "foo",
        goal: "ship the widget",
        context: "c",
        tasks: [
            {
                id: "t1",
                title: "render the widget",
                where: "src/widget.ts",
                blockedBy: [],
                doneWhen: "npm test: 1 passed",
                status: "done",
                notes: ["Ruling: dropped the cache"],
            },
            {
                id: "t2",
                title: "wire the tool",
                blockedBy: ["t1"],
                doneWhen: "npm run check",
                status: "doing",
                notes: [],
            },
        ],
    };
    const bar: Plan = { name: "bar", goal: "other goal", context: "c", tasks: [] };

    function screen(active: string | undefined, height = 16, unreadable: string[] = []) {
        const { theme } = themeStub();
        const keys: any = {
            matches: (data: string, id: string) => data === id,
            getKeys: (id: string) => [id],
        };
        const chosen: string[] = [];
        const drawn = { count: 0 };
        const value = new PlansScreen({
            plans: [foo, bar],
            active,
            unreadable,
            theme,
            keys,
            height: () => height,
            setActive: (name) => chosen.push(name),
            onClose: () => {},
            requestRender: () => (drawn.count += 1),
        });
        return { value, chosen, drawn };
    }

    it("renders the sidebar and the selected plan's detail", () => {
        const { value } = screen("foo");
        const lines = value.render(100);

        assert.equal(lines.length, 16);
        assert.match(lines[0]!, /Plans · 2 in \.pi\/plans/);
        assert.ok(lines.some((line) => line.includes("› foo 1/2 · active")));
        assert.ok(lines.some((line) => line.includes("bar 0/0")));
        assert.ok(lines.some((line) => line.includes("goal: ship the widget")));
        assert.ok(lines.some((line) => line.includes("◐ t2 wire the tool") && !line.includes("blockedBy")));
        assert.ok(lines.some((line) => line.includes("note: Ruling: dropped the cache")));
        for (const line of lines) assert.ok(visibleWidth(line) <= 100);
    });

    it("selects with the keyboard and makes the selection active", () => {
        const { value, chosen, drawn } = screen("foo");
        value.render(100);

        value.handleInput("tui.select.down");
        value.handleInput("tui.select.confirm");

        assert.deepEqual(chosen, ["bar"]);
        assert.equal(drawn.count, 2);
        assert.ok(value.render(100).some((line) => line.includes("goal: other goal")));
    });

    it("names unreadable plan files", () => {
        const { value } = screen("foo", 16, ["broken"]);
        const lines = value.render(100);
        assert.match(lines[0]!, /Plans · 3 in \.pi\/plans/);
        assert.ok(lines.some((line) => line.includes("? broken unreadable")));
    });

    it("selects a plan with a click on its sidebar row", () => {
        const { value, chosen } = screen("foo");
        value.render(100);
        value.handleMouse({ type: "click", button: "left", x: 1, y: 3 } as any);
        value.handleInput("tui.select.confirm");
        assert.deepEqual(chosen, ["bar"]);
    });
});

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

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-plan-test-"));
    dirs.push(dir);
    return dir;
}

function themeStub() {
    const colors: string[] = [];
    const theme: any = {
        fg: (color: string, text: string) => (colors.push(color), text),
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    };
    return { theme, colors };
}

/** The inspector renders markdown with pi's own theme, so strip its colors to compare text. */
function plain(line: string): string {
    return line.replace(/\u001b\[[0-9;]*m/g, "");
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
        plan: "foo",
        title: "ship the widget",
        goal: "the widget ships: npm test -- widget: 1 passed",
        detail: "src/widget.ts renders nothing yet",
        tasks: [
            {
                title: "render the widget",
                goal: "npm test -- widget: 1 passed",
                detail: "Where: src/widget.ts:12",
            },
            {
                title: "wire the tool",
                goal: "npm run check: no errors",
                detail: "Where: src/tool.ts:3",
                dependsOn: ["t1"],
            },
        ],
        ...overrides,
    };
}

const second = { plan: "second", title: "second plan", goal: "g", detail: "d" };

function stored(setup: Setup, id: string): Plan {
    return JSON.parse(readFileSync(join(setup.ctx.cwd, ".pi", "plans", `${id}.json`), "utf8"));
}

describe("create", () => {
    it("assigns ids, writes the plan and fills the widget", async () => {
        const setup_ = setup(project());
        const result = await call(setup_, sample());

        assert.equal(result.details.active, "foo");
        assert.match(text(result), /# Plan foo: ship the widget \(0\/2 done\)/);
        assert.match(text(result), /## Task t1 \[todo\]: render the widget/);
        assert.match(text(result), /## Task t2 \[todo\]: wire the tool\nDepends on: t1/);
        assert.deepEqual(
            stored(setup_, "foo").tasks.map((task) => task.id),
            ["t1", "t2"],
        );
        assert.deepEqual(setup_.state.widget, ["plan ship the widget 0/2"]);
    });

    it("lists every task in progress in the widget", async () => {
        const setup_ = setup(project());
        await call(
            setup_,
            sample({
                tasks: [
                    { title: "a", goal: "x", detail: "src/a.ts", status: "doing" },
                    { title: "b", goal: "y", detail: "src/b.ts", status: "doing" },
                ],
            }),
        );

        assert.deepEqual(setup_.state.widget, ["plan ship the widget 0/2", "  t1 a", "  t2 b"]);
    });

    it("keeps imported statuses, details and notes", async () => {
        const setup_ = setup(project());
        const result = await call(
            setup_,
            sample({
                tasks: [
                    { title: "a", goal: "x", detail: "src/a.ts", status: "done", notes: ["dropped the cache"] },
                    { title: "b", goal: "y", detail: "src/b.ts", status: "doing" },
                ],
            }),
        );

        assert.match(text(result), /## Task t1 \[done\]: a/);
        assert.match(text(result), /### Detail\nsrc\/a\.ts/);
        assert.match(text(result), /### Notes\n- dropped the cache/);
        assert.deepEqual(setup_.state.widget, ["plan ship the widget 1/2", "  t2 b"]);
    });

    it("rejects a plan that already exists", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await assert.rejects(call(setup_, sample()), /already exists/);
    });

    it("rejects a dependsOn id no task has", async () => {
        const setup_ = setup(project());
        await assert.rejects(
            call(setup_, sample({ tasks: [{ title: "a", goal: "x", detail: "src/a.ts", dependsOn: ["t9"] }] })),
            /lacks/,
        );
        assert.equal(existsSync(join(setup_.ctx.cwd, ".pi", "plans", "foo.json")), false);
    });

    it("rejects a dependsOn id that is not earlier", async () => {
        const setup_ = setup(project());
        await assert.rejects(
            call(
                setup_,
                sample({
                    tasks: [
                        { title: "a", goal: "x", detail: "src/a.ts", dependsOn: ["t2"] },
                        { title: "b", goal: "y", detail: "src/b.ts" },
                    ],
                }),
            ),
            /dependsOn takes only earlier ids/,
        );
        await assert.rejects(
            call(setup_, sample({ tasks: [{ title: "a", goal: "x", detail: "src/a.ts", dependsOn: ["t1"] }] })),
            /dependsOn takes only earlier ids/,
        );
    });

    it("rejects an id that escapes the plans directory", async () => {
        const setup_ = setup(project());
        await assert.rejects(call(setup_, sample({ plan: "../evil" })), /kebab-case/);
        await assert.rejects(call(setup_, sample({ plan: "a/b" })), /kebab-case/);
        assert.equal(existsSync(join(setup_.ctx.cwd, ".pi", "plans")), false);
    });
});

describe("update", () => {
    it("sets the status and appends notes", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());

        const first = await call(setup_, { action: "update", task: "t1", status: "done", note: "npm test: 1 passed" });
        assert.match(text(first), /t1 \[done\]/);
        assert.match(text(first), /^foo 1\/2$/m);
        assert.doesNotMatch(text(first), /goal:/);

        await call(setup_, { action: "update", task: "t1", status: "blocked", note: "the seam moved" });
        assert.deepEqual(stored(setup_, "foo").tasks[0]!.notes, ["npm test: 1 passed", "the seam moved"]);
        assert.equal(stored(setup_, "foo").tasks[0]!.status, "blocked");
    });

    it("changes only the fields given", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        const result = await call(setup_, { action: "update", task: "t1", note: "delegate reported back" });
        assert.match(text(result), /t1 \[todo\] render the widget/);
        assert.deepEqual(stored(setup_, "foo").tasks[0]!.notes, ["delegate reported back"]);
    });

    it("appends a plan note when the call names no task", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        const result = await call(setup_, { action: "update", note: "Ruling: widget stays in src" });

        assert.match(text(result), /^note: Ruling: widget stays in src/m);
        assert.deepEqual(stored(setup_, "foo").notes, ["Ruling: widget stays in src"]);
        assert.deepEqual(stored(setup_, "foo").tasks[0]!.notes, []);
    });

    it("rejects a missing status or note, or a missing task", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await assert.rejects(call(setup_, { action: "update", task: "t1" }), /needs status or note/);
        await assert.rejects(call(setup_, { action: "update" }), /needs task, or a note/);
        await assert.rejects(call(setup_, { action: "update", task: "t9", status: "done" }), /no task t9/);
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
        assert.match(text(whole), /# Plan foo: ship the widget \(0\/2 done\)/);
        assert.match(text(whole), /## Goal\nthe widget ships/);
        assert.match(text(whole), /## Detail\nsrc\/widget\.ts renders nothing yet/);

        const slice = await call(setup_, { action: "get", plan: "foo", task: "t2" });
        assert.match(text(slice), /## Task t2 \[todo\]: wire the tool/);
        assert.match(text(slice), /Depends on: t1/);
        assert.match(text(slice), /### Goal\nnpm run check: no errors/);
        assert.doesNotMatch(text(slice), /render the widget/);
    });

    it("keeps a multi-line note inside its list item", async () => {
        const setup_ = setup(project());
        const result = await call(
            setup_,
            sample({ tasks: [{ title: "a", goal: "x", detail: "d", notes: ["first line\nsecond line"] }] }),
        );
        assert.match(text(result), /### Notes\n- first line\n {2}second line/);
    });

    it("lists plans with their title and count", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await call(setup_, sample({ ...second, tasks: [] }));

        const result = await call(setup_, { action: "list" });
        assert.match(text(result), / {2}foo ship the widget 0\/2/);
        assert.match(text(result), /\* second second plan 0\/0/);
    });

    it("names unreadable plan files instead of failing", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        const dir = join(setup_.ctx.cwd, ".pi", "plans");
        writeFileSync(join(dir, "broken.json"), "{ not json");
        writeFileSync(join(dir, "shape.json"), JSON.stringify({ name: "shape", goal: "g" }));
        // An old plan file is not migrated; it is skipped like any other file with the wrong shape.
        writeFileSync(
            join(dir, "old.json"),
            JSON.stringify({
                name: "old",
                goal: "g",
                context: "c",
                tasks: [{ id: "t1", title: "a", blockedBy: [], doneWhen: "x", status: "todo", notes: [] }],
            }),
        );
        // The plan shell is current but the tasks keep the old fields, so the whole file stays unreadable.
        writeFileSync(
            join(dir, "half.json"),
            JSON.stringify({
                id: "half",
                title: "half migrated",
                goal: "g",
                detail: "d",
                notes: [],
                tasks: [{ id: "t1", title: "a", where: "x", blockedBy: [], doneWhen: "y", status: "todo", notes: [] }],
            }),
        );
        // A current shell with an unusable task field is no plan either: the inspector would crash on it.
        for (const [file, task] of [
            ["bad-detail", { title: "a", goal: "g", detail: 5, status: "todo" }],
            ["bad-status", { title: "a", goal: "g", detail: "d", status: "paused" }],
        ] as const)
            writeFileSync(
                join(dir, `${file}.json`),
                JSON.stringify({ id: file, title: "t", goal: "g", detail: "d", notes: [], tasks: [task] }),
            );
        const result = await call(setup_, { action: "list" });
        assert.match(text(result), /\? broken unreadable/);
        assert.match(text(result), /\? shape unreadable/);
        assert.match(text(result), /\? old unreadable/);
        assert.match(text(result), /\? half unreadable/);
        assert.match(text(result), /\? bad-detail unreadable/);
        assert.match(text(result), /\? bad-status unreadable/);
        await assert.rejects(call(setup_, { action: "get", plan: "half" }), /No plan half/);
    });

    it('drops null and "null" optionals, and needs a detail on every task', async () => {
        const setup_ = setup(project());
        await assert.rejects(call(setup_, sample({ goal: "null" })), /create needs/);
        await assert.rejects(call(setup_, sample({ plan: "null" })), /create needs/);
        await assert.rejects(call(setup_, sample({ tasks: [{ title: "a", goal: "x" }] })), /needs a detail/);
        await assert.rejects(call(setup_, sample({ detail: "  " })), /create needs/);
        await assert.rejects(call(setup_, sample({ detail: "null" })), /create needs/);
        await assert.rejects(call(setup_, sample({ goal: " " })), /create needs/);
        await assert.rejects(
            call(setup_, sample({ tasks: [{ title: "a", goal: "null", detail: "d" }] })),
            /needs a goal/,
        );
        await assert.rejects(
            call(setup_, sample({ tasks: [{ title: "a", goal: "x", detail: "  " }] })),
            /needs a detail/,
        );
        await assert.rejects(
            call(setup_, sample({ tasks: [{ title: "a", goal: "x", detail: "d", dependsOn: "t1" }] })),
            /t1 dependsOn must be an array/,
        );
        await assert.rejects(
            call(setup_, sample({ tasks: [{ title: "a", goal: "x", detail: "d", notes: "a note" }] })),
            /t1 notes must be an array/,
        );
        await call(
            setup_,
            sample({ tasks: [{ title: "a", goal: "x", detail: "src/a.ts", dependsOn: ["null"], notes: ["null"] }] }),
        );
        assert.deepEqual(stored(setup_, "foo").tasks[0]!.dependsOn, []);
        assert.deepEqual(stored(setup_, "foo").tasks[0]!.notes, []);
        assert.equal(stored(setup_, "foo").tasks[0]!.detail, "src/a.ts");
        const result = await call(setup_, { action: "get", plan: "null", task: "null", note: null, status: null });
        assert.match(text(result), /# Plan foo: ship the widget \(0\/1 done\)/);
        assert.match(text(result), /## Task t1 \[todo\]: a/);
        assert.match(text(result), /### Goal\nx/);
    });
});

describe("widget", () => {
    it("hides once every task is done and returns when a task reopens", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await call(setup_, { action: "update", task: "t1", status: "done" });
        await call(setup_, { action: "update", task: "t2", status: "done" });
        assert.equal(setup_.state.widget, undefined);

        await call(setup_, { action: "update", task: "t1", status: "todo" });
        assert.deepEqual(setup_.state.widget, ["plan ship the widget 1/2"]);

        await call(setup_, { action: "update", task: "t1", status: "done" });
        assert.equal(setup_.state.widget, undefined);
        await call(setup_, sample({ ...second, tasks: [{ title: "a", goal: "x", detail: "src/a.ts" }] }));
        assert.deepEqual(setup_.state.widget, ["plan second plan 0/1"]);
    });

    it("leaves a task open while its dependency runs", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await call(setup_, { action: "update", task: "t1", status: "doing" });
        assert.deepEqual(setup_.state.widget, ["plan ship the widget 0/2", "  t1 render the widget"]);
    });
});

describe("nextTask", () => {
    function plan(tasks: Array<Partial<PlanTask>>): Plan {
        return {
            id: "p",
            title: "t",
            goal: "g",
            detail: "d",
            notes: [],
            tasks: tasks.map((task, index) => ({
                id: `t${index + 1}`,
                title: "x",
                goal: "y",
                detail: "",
                dependsOn: [],
                status: "todo",
                notes: [],
                ...task,
            })),
        };
    }

    it("skips a todo task whose dependency is open", () => {
        assert.equal(nextTask(plan([{ dependsOn: ["t2"] }, {}]))?.id, "t2");
        assert.equal(nextTask(plan([{}, { dependsOn: ["t1"] }]))?.id, "t1");
        assert.equal(nextTask(plan([{ status: "doing" }, { dependsOn: ["t1"] }])), undefined);
    });
});

describe("active plan restore", () => {
    const toolResult = (active: string) => ({
        type: "message",
        message: { role: "toolResult", toolName: "plan", content: [], details: { action: "get", active } },
    });
    const branch = (ids: string[]) => ids.map(toolResult);

    it("uses the last plan tool result on the branch", async () => {
        const cwd = project();
        const created = setup(cwd);
        await call(created, sample());
        await call(created, sample(second));

        const restored = setup(cwd, branch(["foo", "second"]));
        restored.handlers.session_start!({}, restored.ctx);
        assert.deepEqual(restored.state.widget, ["plan second plan 0/2"]);

        const result = await call(restored, { action: "get" });
        assert.match(text(result), /# Plan second: second plan \(0\/2 done\)/);
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
        assert.deepEqual(afterSelection.state.widget, ["plan ship the widget 0/2"]);

        const afterTool = setup(cwd, [custom("foo"), toolResult("second")]);
        afterTool.handlers.session_start!({}, afterTool.ctx);
        assert.deepEqual(afterTool.state.widget, ["plan second plan 0/2"]);
    });
});

describe("/plan", () => {
    it("shows the active plan as text outside the TUI", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        setup_.ctx.mode = "print";
        await setup_.commands.plan!.handler("", setup_.ctx);
        assert.match(setup_.state.notes[0]!, /## Goal\nthe widget ships/);
    });

    it("sets a named plan active", async () => {
        const setup_ = setup(project());
        await call(setup_, sample());
        await call(setup_, sample({ ...second, tasks: [] }));
        await setup_.commands.plan!.handler("foo", setup_.ctx);
        assert.match(setup_.state.notes.at(-1)!, /Active plan: foo/);
        assert.deepEqual(setup_.state.widget, ["plan ship the widget 0/2"]);
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
        id: "foo",
        title: "ship the widget",
        goal: "ship the widget",
        detail: "c",
        notes: [],
        tasks: [
            {
                id: "t1",
                title: "render the widget",
                goal: "npm test: 1 passed",
                detail: "src/widget.ts",
                dependsOn: [],
                status: "done",
                notes: ["dropped the cache"],
            },
            {
                id: "t2",
                title: "wire the tool",
                goal: "npm run check",
                detail: "src/tool.ts",
                dependsOn: ["t1"],
                status: "doing",
                notes: ["npm run check: no errors", "wired the dispatcher"],
            },
        ],
    };
    const bar: Plan = { id: "bar", title: "other plan", goal: "other goal", detail: "c", notes: [], tasks: [] };

    function screen(active: string | undefined, height = 16, unreadable: string[] = [], theme = themeStub().theme) {
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
            setActive: (id) => chosen.push(id),
            onClose: () => {},
            requestRender: () => (drawn.count += 1),
        });
        return { value, chosen, drawn };
    }

    it("renders the sidebar and the selected plan's detail", () => {
        const { value } = screen("foo");
        const lines = value.render(100);
        assert.equal(lines.length, 16);
        assert.match(lines[0]!, /\[Plans\]  Tasks · 2 in \.pi\/plans/);
        assert.ok(lines.some((line) => line.includes("› ◐ foo 1/2")));
        assert.ok(lines.some((line) => line.includes("active · ship the widget")));
        assert.ok(lines.some((line) => line.includes("○ bar 0/0")));
        assert.ok(
            lines.some((line) => line.includes("· 1 of 2 done")),
            "the progress follows the title",
        );
        const rule = lines.find((line) => line.trimEnd().includes("Tasks ─"))!;
        assert.ok(!/[0-9]+\/[0-9]+/.test(rule), "the count lives in the header, not the rule");
        assert.ok(
            lines.some((line) => line.includes("│ ship the widget")),
            "the goal opens the body",
        );
        assert.ok(lines.some((line) => line.includes("◐ t2 wire the tool") && !line.includes("after")));
        assert.ok(lines.some((line) => line.includes("◐ t2 wire the tool")));
        assert.ok(!lines.some((line) => /wire the tool.*t2$/.test(line.trimEnd())), "the id stays on the left");
        assert.ok(!lines.some((line) => line.includes("dropped the cache")), "a done task is one line");
        // The bottom rule and footer close the screen, so the counter is the third-to-last row.
        assert.ok(lines.at(-3)!.endsWith("1–10/25"), "the tasks scroll under the counter");
        for (const line of lines) assert.ok(visibleWidth(line) <= 100);

        value.handleInput("\x1b[C");
        value.handleInput("tui.altScreen.bottom");
        assert.ok(value.render(100).some((line) => line.trimEnd().includes("Detail ─")));
    });

    it("labels a done task's notes once the details are expanded", () => {
        const { value } = screen("foo", 40);
        assert.ok(!value.render(100).some((line) => line.includes("dropped the cache")));

        value.handleInput("app.tools.expand");
        const expanded = value.render(100).map(plain);
        const label = expanded.findIndex((line) => /│ +Notes$/.test(line.trimEnd()));
        assert.ok(label >= 0, "the notes carry a label");
        assert.ok(expanded[label + 1]!.includes("dropped the cache"));
    });

    it("puts each field label on a line of its own, with its value below it", () => {
        const lines = screen("foo", 40).value.render(100).map(plain);
        const start = lines.findIndex((line) => /│ +Goal$/.test(line.trimEnd()));
        assert.ok(start >= 0);
        assert.match(lines[start + 1]!.trimEnd(), /│ +npm run check$/);
        assert.match(lines[start + 2]!.trimEnd(), /│$/);
        assert.match(lines[start + 3]!.trimEnd(), /│ +Detail$/);
        assert.match(lines[start + 4]!.trimEnd(), /│ +src\/tool\.ts$/);
    });

    it("puts the blockers after the title instead of at the right edge", () => {
        const { value } = screen("foo", 40);
        foo.tasks[0]!.status = "todo";
        try {
            const lines = value.render(100).map(plain);
            assert.match(
                lines.find((line) => line.includes("wire the tool"))!.trimEnd(),
                /│ +◐ t2 wire the tool · after t1$/,
            );
        } finally {
            foo.tasks[0]!.status = "done";
        }
    });

    it("uses the whole width of the right pane", () => {
        const { value } = screen("foo", 40);
        const goal = foo.goal;
        foo.goal = "g".repeat(130);
        try {
            const lines = value.render(200);
            assert.ok(
                lines.some((line) => line.includes(`│ ${"g".repeat(130)}`)),
                "a long line is not capped",
            );
            assert.equal(visibleWidth(lines.at(-3)!), 200, "the counter sits at the right edge");
        } finally {
            foo.goal = goal;
        }
    });

    it("wraps only headings and labels in accent, over text content", () => {
        const marked: any = {
            fg: (color: string, text: string) => `<${color}>${text}`,
            bg: (color: string, text: string) => `<${color}>${text}`,
            bold: (text: string) => text,
        };
        const { value } = screen("foo", 40, [], marked);
        const lines = value.render(100);

        assert.ok(lines.some((line) => line.includes("<accent>Goal")));
        assert.ok(lines.some((line) => line.includes("<accent>Detail")));
        assert.ok(lines.some((line) => line.includes("<accent>Tasks ")));
        assert.ok(
            lines.some((line) => line.includes("<muted>t2")),
            "the task id is muted, on the left",
        );
        assert.ok(lines.some((line) => line.includes("<text>ship the widget")));
        assert.ok(lines.some((line) => line.includes("<text>npm run check")));
        assert.ok(
            lines.some((line) => line.includes("<text>npm run check: no errors")),
            "notes are text",
        );

        value.handleInput("\x1b[C");
        value.handleInput("tui.altScreen.bottom");
        const bottom = value.render(100);
        assert.ok(bottom.some((line) => line.includes("<accent>Detail ")));
        assert.ok(
            bottom.some((line) => /<text>c\b/.test(line)),
            "the detail prose is text",
        );
    });

    it("draws each task as a status-tinted block, header then fields in order", () => {
        const { value } = screen("foo", 40);
        const rows = value
            .render(100)
            .map(plain)
            .map((line) => line.replace(/^\s*│\s+/, "").trimEnd());
        const start = rows.indexOf("◐ t2 wire the tool");
        assert.ok(start > 0);
        assert.deepEqual(rows.slice(start, start + 12), [
            "◐ t2 wire the tool",
            "",
            "Goal",
            "npm run check",
            "",
            "Detail",
            "src/tool.ts",
            "",
            "Notes",
            "npm run check: no errors",
            "",
            "wired the dispatcher",
        ]);
        assert.equal(rows[start - 1], "", "a blank row separates the blocks");
        assert.equal(rows[rows.indexOf("✓ t1 render the widget") + 1], "", "a done task stays one row");

        const marked: any = {
            fg: (color: string, text: string) => `<${color}>${text}`,
            bg: (color: string, text: string) => `<${color}>${text}`,
            bold: (text: string) => text,
        };
        const tinted = screen("foo", 40, [], marked).value.render(100);
        assert.ok(tinted.some((line) => line.includes("<toolSuccessBg>") && line.includes("render the widget")));
        assert.ok(tinted.some((line) => line.includes("<toolPendingBg>") && line.includes("wire the tool")));
    });

    it("renders plan notes as a list under their own section", () => {
        const { value } = screen("foo", 40);
        foo.notes = ["Ruling: widget stays in src", "second ruling"];
        try {
            const lines = value
                .render(100)
                .map(plain)
                .map((line) => line.trimEnd());
            const start = lines.findIndex((line) => line.includes("Notes ─"));
            assert.ok(start >= 0, "the notes carry a section rule");
            assert.match(lines[start + 1]!, /│ - Ruling: widget stays in src$/);
            assert.match(lines[start + 2]!, /│ - second ruling$/);
        } finally {
            foo.notes = [];
        }
    });

    it("renders markdown in the plan detail, code spans and single newlines included", () => {
        const { value } = screen("foo", 40);
        const detail = foo.detail;
        foo.detail = "Uses `Foo.bar` in the seam\nthen a second line";
        try {
            const lines = value.render(100).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
            const start = lines.findIndex((line) => line.includes("Uses Foo.bar in the seam"));
            assert.ok(start >= 0, "the code span renders without backticks");
            assert.ok(!lines.some((line) => line.includes("`Foo.bar`")));
            assert.ok(lines[start + 1]!.includes("then a second line"), "a single newline stays a line break");
        } finally {
            foo.detail = detail;
        }
    });

    it("selects with the keyboard and makes the selection active", () => {
        const { value, chosen, drawn } = screen("foo");
        value.render(100);

        value.handleInput("tui.select.down");
        value.handleInput("tui.select.confirm");

        assert.deepEqual(chosen, ["bar"]);
        assert.equal(drawn.count, 2);
        assert.ok(value.render(100).some((line) => line.includes("other goal")));
    });

    it("names unreadable plan files", () => {
        const { value } = screen("foo", 16, ["broken"]);
        const lines = value.render(100);
        assert.match(lines[0]!, /\[Plans\]  Tasks · 3 in \.pi\/plans/);
        assert.ok(lines.some((line) => line.includes("? broken unreadable")));
    });

    it("selects a plan with a click on its sidebar row", () => {
        const { value, chosen } = screen("foo");
        value.render(100);
        value.handleMouse({ type: "click", button: "left", x: 1, y: 4 } as any);
        value.handleInput("tui.select.confirm");
        assert.deepEqual(chosen, ["bar"]);
    });

    it("moves the focus between the panes with ←/→, and the keys follow it", () => {
        const { value, chosen } = screen("foo");
        assert.match(value.render(100)[0]!, /^\[Plans\]  Tasks/);

        value.handleInput("\x1b[C");
        assert.match(value.render(100)[0]!, /^Plans  \[Tasks\]/);
        value.handleInput("tui.select.down");
        value.handleInput("tui.select.confirm");
        assert.deepEqual(chosen, ["foo"], "↓ scrolled the tasks instead of moving to bar");
        assert.ok(value.render(100).at(-3)!.endsWith("2–11/25"));

        value.handleInput("\x1b[D");
        value.handleInput("tui.select.down");
        value.handleInput("tui.select.confirm");
        assert.deepEqual(chosen, ["foo", "bar"]);
    });

    it("scrolls the tasks on a wheel, and selects a plan when the wheel is over the sidebar", () => {
        const { value, chosen } = screen("foo");
        value.render(100);

        value.handleMouse({ type: "wheel", x: 80, y: 5, wheelDelta: 3 } as any);
        assert.ok(value.render(100).at(-3)!.endsWith("4–13/25"), "three lines down stops at the plan's end");
        value.handleMouse({ type: "wheel", x: 1, y: 4, wheelDelta: 1 } as any);
        value.handleInput("tui.select.confirm");
        assert.deepEqual(chosen, ["bar"]);
    });
});

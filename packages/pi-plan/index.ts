import { StringEnum } from "@earendil-works/pi-ai";
import {
    getMarkdownTheme,
    type ExtensionAPI,
    type ExtensionContext,
    type KeybindingHints,
    type SessionEntry,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { hardBreaks, openPlans } from "./src/inspector.ts";
import {
    doneCount,
    excludePlans,
    fact,
    hanging,
    listPlans,
    listText,
    moreLines,
    planStatus,
    planSummary,
    planText,
    plansDir,
    readPlan,
    repoRoot,
    STATUS,
    statusText,
    STATUSES,
    taskFacts,
    taskLine,
    taskRow,
    taskText,
    widgetLines,
    writePlan,
    type Plan,
    type PlanList,
    type PlanStatus,
} from "./src/store.ts";

type Action = (typeof ACTIONS)[number];

type PlanDetails = {
    action: Action;
    active?: string;
    /** create, get and update: the plan as it stands after the call. */
    plan?: Plan;
    /** get and update: the task the call is about. */
    id?: string;
    /** update: the note this call appended. */
    note?: string;
    /** list: every plan the call found. */
    list?: PlanList;
};

const ACTIONS = ["create", "update", "get", "list"] as const;

const PlanParams = Type.Object({
    action: StringEnum(ACTIONS),
    plan: Type.Optional(
        Type.String({ description: "Plan id in kebab-case; get and update default to the active plan." }),
    ),
    title: Type.Optional(
        Type.String({
            description: "create: a three to eight word summary of the outcome, shown in the widget and list.",
        }),
    ),
    goal: Type.Optional(Type.String({ description: "create: the observable outcome and the check that proves it." })),
    detail: Type.Optional(
        Type.String({
            description:
                "create: markdown sections: current behaviour with path:line, problem, chosen design and rejected alternatives, accepted behaviour changes, out of scope, open questions.",
        }),
    ),
    tasks: Type.Optional(
        Type.Array(
            Type.Object({
                title: Type.String({
                    description: "The deliverable or behaviour in one line; the widget and get show it beside the id.",
                }),
                goal: Type.String({
                    description: "Observable result, with the command to run and its expected output.",
                }),
                detail: Type.String({
                    description: "Approach, interfaces to match, pitfalls, and a Where: line citing path:line.",
                }),
                dependsOn: Type.Optional(
                    Type.Array(Type.String(), { description: "Task ids this task waits on, such as t1." }),
                ),
                status: Type.Optional(StringEnum(STATUSES, { description: "Defaults to todo." })),
                notes: Type.Optional(
                    Type.Array(Type.String(), { description: "Existing notes or log lines for this task." }),
                ),
            }),
            { description: "create: tasks in execution order; ids t1..tn follow this order." },
        ),
    ),
    task: Type.Optional(
        Type.String({
            description: "update: task id to change. get: this task alone, with the plan's goal and detail.",
        }),
    ),
    status: Type.Optional(StringEnum(STATUSES, { description: "update: the task's new state." })),
    note: Type.Optional(
        Type.String({
            description:
                "update: a note appended to the task's notes; without task, to the plan's notes (use for cross-task rulings).",
        }),
    ),
});

const WIDGET_KEY = "plan";
const ACTIVE_ENTRY = "plan";
/** pi caps a collapsed tool result at ten rows; the expansion shows all of them. */
const COLLAPSED_LINES = 10;

function lastActive(entries: SessionEntry[]): string | undefined {
    let active: string | undefined;
    for (const entry of entries) {
        // A /plan selection is a custom entry; a tool call carries the plan it touched in its details.
        if (entry.type === "custom" && entry.customType === ACTIVE_ENTRY && typeof entry.data === "string")
            active = entry.data;
        else if (entry.type === "message" && entry.message.role === "toolResult") {
            if (entry.message.toolName !== "plan") continue;
            const details = entry.message.details as PlanDetails | undefined;
            if (typeof details?.active === "string") active = details.active;
        }
    }
    return active;
}

/** Strict models send literal "null" for optional params they omit; a renderer treats it as absent. */
function argText(value: unknown): string {
    const text = typeof value === "string" ? value.trim() : "";
    return text === "null" ? "" : text;
}

function argStatus(value: unknown): PlanStatus | undefined {
    const text = argText(value);
    return STATUSES.find((status) => status === text);
}

function capLines<T>(lines: readonly T[], max: number): { shown: T[]; hidden: number } {
    return { shown: lines.slice(0, max), hidden: Math.max(0, lines.length - max) };
}

/** A result view capped to ten rows until the user expands it, then in full. */
function resultView(
    rows: (width: number) => string[],
    theme: Theme,
    expanded: boolean,
    keyHint: KeybindingHints["keyHint"],
): Component {
    return {
        render: (width) => {
            // Wrapping turns one long line into many rows, so the cap counts rendered rows.
            const { shown, hidden } = capLines(rows(width), expanded ? Infinity : COLLAPSED_LINES + 1);
            return hidden ? [...shown, truncateToWidth(moreLines(theme, hidden, keyHint), width)] : shown;
        },
        invalidate() {},
    };
}

/** pi styles errors itself, but a custom renderer replaces that default, so keep its look. */
function errorView(body: string, theme: Theme, isError: boolean): Component {
    const mark = statusText(theme, isError ? "blocked" : "done");
    const text = theme.fg(isError ? "error" : "toolOutput", body || "(no output)");
    return new Text(`\n${mark} ${text}`, 0, 0);
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
    return result.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}

/** The whole plan: a summary line, then one row per task; only the expansion carries goal, detail and notes. */
function planLines(plan: Plan, theme: Theme, expanded: boolean, width: number): string[] {
    const tasks = plan.tasks.flatMap((task) =>
        expanded
            ? [...hanging(taskRow(theme, plan, task), width, task.id.length + 3), ...taskFacts(theme, task, width)]
            : [taskRow(theme, plan, task)],
    );
    return [
        "",
        `${theme.fg("accent", "plan")} ${planSummary(theme, plan)}`,
        ...(expanded
            ? [...fact(theme, "Goal: ", plan.goal, width), ...fact(theme, "Detail: ", plan.detail, width, 2, "dim")]
            : []),
        ...tasks,
    ];
}

/** What changed: the task row, the note this call appended, and where the plan now stands. */
function updateLines(
    plan: Plan,
    id: string | undefined,
    note: string | undefined,
    theme: Theme,
    width: number,
): string[] {
    const task = plan.tasks.find((item) => item.id === id);
    return [
        "",
        ...(task ? hanging(taskRow(theme, plan, task), width, task.id.length + 3) : []),
        ...(note ? fact(theme, "", note, width) : []),
        theme.fg("muted", planSummary(theme, plan)),
    ];
}

function listLines(list: PlanList, active: string | undefined, theme: Theme): string[] {
    if (!list.plans.length && !list.unreadable.length) return [];
    return [
        "",
        ...list.plans.map(
            (plan) => `${plan.id === active ? theme.fg("accent", "›") : " "} ${planSummary(theme, plan)}`,
        ),
        ...list.unreadable.map((name) => theme.fg("error", `? ${name} unreadable`)),
    ];
}

/** `plan update t1 done · note`: the action, its target, and the argument that matters. */
function callLine(args: Record<string, unknown>, theme: Theme): Component {
    const action = argText(args.action);
    const update = action === "update";
    const target = update
        ? argText(args.task)
        : [argText(args.plan), action === "get" ? argText(args.task) : ""].filter(Boolean).join(" ");
    const status = update ? argStatus(args.status) : undefined;
    const note = update ? argText(args.note) : "";
    const head = `${theme.fg("toolTitle", theme.bold("plan"))} ${theme.fg("accent", [action || "…", target].filter(Boolean).join(" "))}`;
    const tail = [
        status ? theme.fg(STATUS[status].color, status) : "",
        note ? theme.fg("muted", `· ${note.length > 60 ? `${note.slice(0, 59)}…` : note}`) : "",
    ]
        .filter(Boolean)
        .join(" ");
    return new Text([head, tail].filter(Boolean).join(" "), 0, 0);
}

/** Strict models send "null" for an omitted string or list; anything else that is empty is a bug. */
function blank(value: string | undefined): boolean {
    return !value?.trim() || value === "null";
}

function taskList(value: unknown, field: string): string[] {
    if (value === undefined || value === null || value === "null") return [];
    if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
    // pi coerces a bare "null" for an array param into ["null"] before execute runs.
    return value.length === 1 && value[0] === "null" ? [] : (value as string[]);
}

export default function (pi: ExtensionAPI) {
    // The last plan this session created, updated or read; restored from the active branch.
    let active: string | undefined;

    function refreshWidget(ctx: ExtensionContext) {
        if (!ctx.hasUI) return;
        let plan: Plan | undefined;
        try {
            plan = active ? readPlan(repoRoot(ctx.cwd), active) : undefined;
        } catch {
            // A restored id or a corrupt file must not break the session; the tool reports the real error.
            plan = undefined;
        }
        if (!plan) {
            active = undefined;
            ctx.ui.setWidget(WIDGET_KEY, undefined);
            return;
        }
        // A finished plan clears the widget, like pi-delegate's finished jobs; new work brings it back.
        ctx.ui.setWidget(WIDGET_KEY, planStatus(plan) === "done" ? undefined : widgetLines(ctx.ui.theme, plan));
    }

    function restore(ctx: ExtensionContext) {
        active = lastActive(ctx.sessionManager.getBranch());
        refreshWidget(ctx);
    }

    pi.on("session_start", (_event, ctx) => restore(ctx));
    pi.on("session_tree", (_event, ctx) => restore(ctx));

    pi.registerTool({
        name: "plan",
        label: "Plan",
        description:
            "Read and write the project plan: a plan at .pi/plans/<id>.json with a goal, the detail a cold reader needs, and tasks. Actions: create, update, get, list.",
        promptSnippet: "Write the plan for multi-step work in this project: goal, detail, one task per verifiable step",
        promptGuidelines: [
            "Mark a task `doing` when work on it starts.",
            "When another agent works a task, give it the `get` output for that task and update the plan here from its result; a second writer would overwrite plan state.",
            "Mark a task `done` only after its goal's check passed, and put the result in the note, for example `npm test -- packages/x: 42 passed`.",
            "Leave a task open when its outcome is unproven: `blocked` with a note of what remains, or `todo`.",
            "Record a cross-task ruling as a note on the plan: `update` with a note and no task.",
            'When the user refers to a plan by a loose name ("continue the npc draft"), run `list`, then `get` the matching id; that makes it active.',
        ],
        parameters: PlanParams,

        async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
            // Strict models inject literal "null" for optional params they omit; drop it from those only.
            const params = { ...rawParams } as typeof rawParams & Record<string, unknown>;
            for (const key of ["plan", "title", "goal", "detail", "tasks", "task", "status", "note"]) {
                if (params[key] === null || params[key] === "null") delete params[key];
            }
            const root = repoRoot(ctx.cwd);
            const respond = (text: string, action: Action, extra: Omit<PlanDetails, "action" | "active"> = {}) => {
                refreshWidget(ctx);
                return { content: [{ type: "text" as const, text }], details: { action, active, ...extra } };
            };
            const requireId = () => {
                const id = params.plan ?? active;
                if (!id) throw new Error("No active plan; run list, then pass plan.");
                return id;
            };
            const requirePlan = () => {
                const id = requireId();
                const plan = readPlan(root, id);
                if (!plan) throw new Error(`No plan ${id} in ${plansDir(root)}; run list for the ids.`);
                return plan;
            };

            switch (params.action as Action) {
                case "create": {
                    const { plan: id, title, goal, detail, tasks } = params;
                    if (!id || !title || !goal || !detail || !tasks || blank(goal) || blank(detail))
                        throw new Error("create needs plan, title, goal, detail and tasks.");
                    if (tasks.some((task) => blank(task.goal)))
                        throw new Error("Every task needs a goal and the check that proves it.");
                    if (tasks.some((task) => blank(task.detail)))
                        throw new Error(
                            "Every task needs a detail: the approach, the interfaces and a Where: path:line.",
                        );
                    if (readPlan(root, id)) throw new Error(`Plan ${id} already exists; use get or update.`);
                    const plan: Plan = {
                        id,
                        title,
                        goal,
                        detail,
                        notes: [],
                        tasks: tasks.map((task, index) => ({
                            id: `t${index + 1}`,
                            title: task.title,
                            goal: task.goal,
                            detail: task.detail,
                            dependsOn: taskList(task.dependsOn, `t${index + 1} dependsOn`),
                            status: (task.status ?? "todo") as PlanStatus,
                            notes: taskList(task.notes, `t${index + 1} notes`),
                        })),
                    };
                    const ids = new Map(plan.tasks.map((task, index) => [task.id, index]));
                    for (const [index, task] of plan.tasks.entries())
                        for (const id of task.dependsOn) {
                            const target = ids.get(id);
                            if (target === undefined)
                                throw new Error(`${task.id} dependsOn ${id}, a task this plan lacks.`);
                            if (target >= index)
                                throw new Error(`${task.id} dependsOn ${id}; dependsOn takes only earlier ids.`);
                        }
                    excludePlans(root);
                    writePlan(root, plan);
                    active = plan.id;
                    return respond(planText(plan), "create", { plan });
                }

                case "update": {
                    const plan = requirePlan();
                    if (!params.task) {
                        if (!params.note) throw new Error("update needs task, or a note for the plan.");
                        plan.notes.push(params.note);
                        writePlan(root, plan);
                        active = plan.id;
                        const progress = `${plan.id} ${doneCount(plan)}/${plan.tasks.length}`;
                        return respond(`note: ${params.note}\n${progress}`, "update", { plan, note: params.note });
                    }
                    if (!params.status && !params.note) throw new Error("update needs status or note.");
                    const task = plan.tasks.find((item) => item.id === params.task);
                    if (!task) throw new Error(`Plan ${plan.id} has no task ${params.task}.`);
                    if (params.status) task.status = params.status as PlanStatus;
                    if (params.note) task.notes.push(params.note);
                    writePlan(root, plan);
                    active = plan.id;
                    // The model already holds the plan; echo only what changed and where it now stands.
                    const progress = `${plan.id} ${doneCount(plan)}/${plan.tasks.length}`;
                    return respond(`${taskLine(task)}\n${progress}`, "update", {
                        plan,
                        id: task.id,
                        ...(params.note ? { note: params.note } : {}),
                    });
                }

                case "get": {
                    const plan = requirePlan();
                    const task = params.task ? plan.tasks.find((item) => item.id === params.task) : undefined;
                    if (params.task && !task) throw new Error(`Plan ${plan.id} has no task ${params.task}.`);
                    active = plan.id;
                    return respond(task ? taskText(plan, task) : planText(plan), "get", {
                        plan,
                        ...(task ? { id: task.id } : {}),
                    });
                }

                case "list": {
                    const list = listPlans(root);
                    return respond(listText(root, list, active), "list", { list });
                }
            }
            throw new Error(`Unknown plan action ${params.action}.`);
        },

        renderCall: (args, theme) => callLine(args as Record<string, unknown>, theme),

        renderResult(result, { expanded }, theme, context) {
            const details = context.isError ? undefined : (result.details as PlanDetails | undefined);
            const plan = details?.plan;
            const list = details?.list;
            const active = details?.active;
            const id = details?.id;
            const note = details?.note;
            let rows: ((width: number) => string[]) | undefined;
            if (list) rows = () => listLines(list, active, theme);
            else if (plan && details?.action === "get") {
                const task = plan.tasks.find((item) => item.id === id);
                const markdown = new Markdown(
                    hardBreaks(task ? taskText(plan, task) : planText(plan)),
                    0,
                    0,
                    getMarkdownTheme(),
                );
                rows = (width) => ["", ...markdown.render(Math.max(1, width)).map((line) => line.trimEnd())];
            } else if (plan && details?.action === "update")
                rows = (width) => updateLines(plan, id, note, theme, width);
            else if (plan) rows = (width) => planLines(plan, theme, expanded, width);
            return rows
                ? resultView(rows, theme, expanded, context.keyHint)
                : errorView(resultText(result), theme, context.isError);
        },
    });

    pi.registerCommand("plan", {
        description: "Show every plan and pick the active one; /plan <id> sets it directly",
        handler: async (args, ctx) => {
            const root = repoRoot(ctx.cwd);
            const setActive = (id: string) => {
                active = id;
                pi.appendEntry(ACTIVE_ENTRY, id);
                refreshWidget(ctx);
            };
            const id = args.trim();
            if (id) {
                let plan: Plan | undefined;
                try {
                    plan = readPlan(root, id);
                } catch (error) {
                    ctx.ui.notify((error as Error).message, "error");
                    return;
                }
                if (!plan) {
                    ctx.ui.notify(`No plan ${id} in ${plansDir(root)}.`, "error");
                    return;
                }
                setActive(plan.id);
                ctx.ui.notify(`Active plan: ${plan.id}`, "info");
                return;
            }
            const list = listPlans(root);
            if (ctx.mode !== "tui") {
                const plan = list.plans.find((item) => item.id === active);
                ctx.ui.notify(plan ? planText(plan) : listText(root, list, active), "info");
                return;
            }
            if (!list.plans.length && !list.unreadable.length) {
                ctx.ui.notify(`No plans in ${plansDir(root)}.`, "info");
                return;
            }
            await openPlans(ctx, list, active, setActive);
        },
    });
}

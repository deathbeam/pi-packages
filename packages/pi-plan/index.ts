import { StringEnum } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    KeybindingHints,
    SessionEntry,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { openPlans } from "./src/inspector.ts";
import {
    doneCount,
    excludePlans,
    fact,
    hanging,
    listPlans,
    listText,
    moreLines,
    nextTask,
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
    widgetLine,
    writePlan,
    type Plan,
    type PlanList,
    type PlanStatus,
} from "./src/store.ts";

const ACTIONS = ["create", "update", "get", "list"] as const;

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

const PlanParams = Type.Object({
    action: StringEnum(ACTIONS),
    name: Type.Optional(
        Type.String({ description: "Plan name in kebab-case; get and update default to the active plan." }),
    ),
    goal: Type.Optional(Type.String({ description: "create: the observable outcome." })),
    context: Type.Optional(
        Type.String({ description: "create: current behaviour, seams, decisions, constraints, out of scope." }),
    ),
    tasks: Type.Optional(
        Type.Array(
            Type.Object({
                title: Type.String({ description: "Deliverable or behaviour, one line." }),
                where: Type.Optional(Type.String({ description: "Files or paths the task touches." })),
                blockedBy: Type.Optional(
                    Type.Array(Type.String(), { description: "Task ids this task waits on, such as t1." }),
                ),
                doneWhen: Type.String({
                    description: "Observable result, with the command to run and its expected output.",
                }),
                status: Type.Optional(StringEnum(STATUSES, { description: "Defaults to todo." })),
                notes: Type.Optional(
                    Type.Array(Type.String(), { description: "Existing notes or log lines for this task." }),
                ),
            }),
            { description: "create: tasks in execution order; ids t1..tn follow this order." },
        ),
    ),
    id: Type.Optional(
        Type.String({
            description: "update: task id to change. get: this task alone, with the plan's goal and context.",
        }),
    ),
    status: Type.Optional(StringEnum(STATUSES, { description: "update: the task's new state." })),
    note: Type.Optional(Type.String({ description: "update: text appended to the task's notes." })),
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

/** The whole plan: a summary line, then one row per task; only the expansion carries goal, context and notes. */
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
            ? [...fact(theme, "Goal: ", plan.goal, width), ...fact(theme, "Context: ", plan.context, width, 2, "dim")]
            : []),
        ...tasks,
    ];
}

/** One task of a plan: its row, then the check and notes that make it a brief. */
function focusLines(plan: Plan, id: string, theme: Theme, width: number): string[] {
    const task = plan.tasks.find((item) => item.id === id);
    return task
        ? ["", ...hanging(taskRow(theme, plan, task), width, task.id.length + 3), ...taskFacts(theme, task, width)]
        : [];
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
    if (!task) return [];
    return [
        "",
        ...hanging(taskRow(theme, plan, task), width, task.id.length + 3),
        ...(note ? fact(theme, "", note, width) : []),
        theme.fg("muted", planSummary(theme, plan)),
    ];
}

function listLines(list: PlanList, active: string | undefined, theme: Theme): string[] {
    if (!list.plans.length && !list.unreadable.length) return [];
    return [
        "",
        ...list.plans.map(
            (plan) => `${plan.name === active ? theme.fg("accent", "›") : " "} ${planSummary(theme, plan)}`,
        ),
        ...list.unreadable.map((name) => theme.fg("error", `? ${name} unreadable`)),
    ];
}

/** `plan update t1 done · note`: the action, its target, and the argument that matters. */
function callLine(args: Record<string, unknown>, theme: Theme): Component {
    const action = argText(args.action);
    const update = action === "update";
    const target = update
        ? argText(args.id)
        : [argText(args.name), action === "get" ? argText(args.id) : ""].filter(Boolean).join(" ");
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

export default function (pi: ExtensionAPI) {
    // The last plan this session created, updated or read; restored from the active branch.
    let active: string | undefined;

    function refreshWidget(ctx: ExtensionContext) {
        if (!ctx.hasUI) return;
        let plan: Plan | undefined;
        try {
            plan = active ? readPlan(repoRoot(ctx.cwd), active) : undefined;
        } catch {
            // A restored name or a corrupt file must not break the session; the tool reports the real error.
            plan = undefined;
        }
        if (!plan) {
            active = undefined;
            ctx.ui.setWidget(WIDGET_KEY, undefined);
            return;
        }
        ctx.ui.setWidget(WIDGET_KEY, [widgetLine(ctx.ui.theme, plan)]);
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
            "Read and write the project plan: a task list at .pi/plans/<name>.json. Actions: create, update, get, list.",
        promptSnippet: "Track multi-step work as a plan in this project, one task per verifiable step",
        promptGuidelines: [
            "Mark a task `doing` when work on it starts.",
            "When another agent works a task, give it the `get` output for that task and update the plan here from its result; a second writer would overwrite plan state.",
            "Mark a task `done` only after its doneWhen check passed, and put that check and its result in the note, for example `npm test -- packages/x: 42 passed`.",
            "Leave a task open when its outcome is unproven: `blocked` with a note of what remains, or `todo`.",
            "Record a scope change as a `Ruling:` note giving the change and the reason.",
            'When the user refers to a plan by a loose name ("continue the npc draft"), run `list`, then `get` the matching name; that makes it active.',
        ],
        parameters: PlanParams,

        async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
            // Strict models inject literal "null" for optional params they omit; drop it from those only.
            const params = { ...rawParams } as typeof rawParams & Record<string, unknown>;
            for (const key of ["name", "goal", "context", "tasks", "id", "status", "note"]) {
                if (params[key] === null || params[key] === "null") delete params[key];
            }
            const root = repoRoot(ctx.cwd);
            const respond = (text: string, action: Action, extra: Omit<PlanDetails, "action" | "active"> = {}) => {
                refreshWidget(ctx);
                return { content: [{ type: "text" as const, text }], details: { action, active, ...extra } };
            };
            const requireName = () => {
                const name = params.name ?? active;
                if (!name) throw new Error("No active plan; run list, then pass name.");
                return name;
            };
            const requirePlan = () => {
                const name = requireName();
                const plan = readPlan(root, name);
                if (!plan) throw new Error(`No plan ${name} in ${plansDir(root)}; run list for the names.`);
                return plan;
            };

            switch (params.action as Action) {
                case "create": {
                    const { name, goal, context, tasks } = params;
                    if (!name || !goal || !context || !tasks)
                        throw new Error("create needs name, goal, context and tasks.");
                    if (readPlan(root, name)) throw new Error(`Plan ${name} already exists; use get or update.`);
                    const plan: Plan = {
                        name,
                        goal,
                        context,
                        tasks: tasks.map((task, index) => ({
                            id: `t${index + 1}`,
                            title: task.title,
                            ...(task.where && task.where !== "null" ? { where: task.where } : {}),
                            blockedBy: task.blockedBy ?? [],
                            doneWhen: task.doneWhen,
                            status: (task.status ?? "todo") as PlanStatus,
                            notes: task.notes ?? [],
                        })),
                    };
                    const ids = new Map(plan.tasks.map((task, index) => [task.id, index]));
                    for (const [index, task] of plan.tasks.entries())
                        for (const id of task.blockedBy) {
                            const target = ids.get(id);
                            if (target === undefined)
                                throw new Error(`${task.id} is blockedBy ${id}, a task this plan lacks.`);
                            if (target >= index)
                                throw new Error(`${task.id} is blockedBy ${id}; blockedBy takes only earlier ids.`);
                        }
                    excludePlans(root);
                    writePlan(root, plan);
                    active = plan.name;
                    return respond(planText(plan), "create", { plan });
                }

                case "update": {
                    const plan = requirePlan();
                    if (!params.id) throw new Error("update needs id.");
                    if (!params.status && !params.note) throw new Error("update needs status or note.");
                    const task = plan.tasks.find((item) => item.id === params.id);
                    if (!task) throw new Error(`Plan ${plan.name} has no task ${params.id}.`);
                    if (params.status) task.status = params.status as PlanStatus;
                    if (params.note) task.notes.push(params.note);
                    writePlan(root, plan);
                    active = plan.name;
                    // The model already holds the plan; echo only what changed and where it now stands.
                    const next = nextTask(plan);
                    const progress = `${plan.name} ${doneCount(plan)}/${plan.tasks.length}${next ? ` · next ${next.id}` : ""}`;
                    return respond(`${taskLine(task)}\n${progress}`, "update", {
                        plan,
                        id: task.id,
                        ...(params.note ? { note: params.note } : {}),
                    });
                }

                case "get": {
                    const plan = requirePlan();
                    const task = params.id ? plan.tasks.find((item) => item.id === params.id) : undefined;
                    if (params.id && !task) throw new Error(`Plan ${plan.name} has no task ${params.id}.`);
                    active = plan.name;
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
            else if (plan && details?.action === "update") rows = (width) => updateLines(plan, id, note, theme, width);
            else if (plan && id) rows = (width) => focusLines(plan, id, theme, width);
            else if (plan) rows = (width) => planLines(plan, theme, expanded, width);
            return rows
                ? resultView(rows, theme, expanded, context.keyHint)
                : errorView(resultText(result), theme, context.isError);
        },
    });

    pi.registerCommand("plan", {
        description: "Show every plan and pick the active one; /plan <name> sets it directly",
        handler: async (args, ctx) => {
            const root = repoRoot(ctx.cwd);
            const setActive = (name: string) => {
                active = name;
                pi.appendEntry(ACTIVE_ENTRY, name);
                refreshWidget(ctx);
            };
            const name = args.trim();
            if (name) {
                let plan: Plan | undefined;
                try {
                    plan = readPlan(root, name);
                } catch (error) {
                    ctx.ui.notify((error as Error).message, "error");
                    return;
                }
                if (!plan) {
                    ctx.ui.notify(`No plan ${name} in ${plansDir(root)}.`, "error");
                    return;
                }
                setActive(plan.name);
                ctx.ui.notify(`Active plan: ${plan.name}`, "info");
                return;
            }
            const list = listPlans(root);
            if (ctx.mode !== "tui") {
                const plan = list.plans.find((item) => item.name === active);
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

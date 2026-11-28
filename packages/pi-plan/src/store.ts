import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { KeybindingHints, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type PlanStatus = (typeof STATUSES)[number];

export type PlanTask = {
    id: string;
    title: string;
    goal: string;
    detail: string;
    dependsOn: string[];
    status: PlanStatus;
    notes: string[];
};

export type Plan = {
    id: string;
    title: string;
    goal: string;
    detail: string;
    notes: string[];
    tasks: PlanTask[];
};

export type PlanList = {
    plans: Plan[];
    unreadable: string[];
};

/** One status vocabulary for the widget, the tool results and the /plan overlay. */
export const STATUSES = ["todo", "doing", "done", "blocked"] as const;

export const STATUS = {
    todo: { glyph: "○", color: "muted" },
    doing: { glyph: "◐", color: "warning" },
    done: { glyph: "✓", color: "success" },
    blocked: { glyph: "✗", color: "error" },
} as const satisfies Record<PlanStatus, { glyph: string; color: string }>;

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLANS_IGNORE = ".pi/plans/";

/** Plans live at <repoRoot>/.pi/plans, beside pi-delegate's .pi/worktrees; outside git, the session cwd is the root. */
export function repoRoot(cwd: string): string {
    try {
        return (
            execFileSync("git", ["rev-parse", "--show-toplevel"], {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim() || cwd
        );
    } catch {
        return cwd;
    }
}

export function plansDir(root: string): string {
    return join(root, ".pi", "plans");
}

function planPath(root: string, id: string): string {
    if (!ID.test(id)) throw new Error(`Plan id "${id}" must be kebab-case, for example my-plan.`);
    return join(plansDir(root), `${id}.json`);
}

function isTask(value: unknown): value is PlanTask {
    const task = value as PlanTask;
    return (
        typeof task?.id === "string" &&
        typeof task.title === "string" &&
        typeof task.goal === "string" &&
        typeof task.detail === "string" &&
        Array.isArray(task.dependsOn) &&
        Array.isArray(task.notes) &&
        STATUSES.includes(task.status)
    );
}

/** A file without the current shape is no plan: old files stay unreadable instead of crashing a renderer. */
function isPlan(value: unknown): value is Plan {
    const plan = value as Plan;
    return (
        Array.isArray(plan?.tasks) &&
        plan.tasks.every(isTask) &&
        typeof plan.id === "string" &&
        typeof plan.title === "string" &&
        typeof plan.goal === "string" &&
        typeof plan.detail === "string" &&
        Array.isArray(plan.notes)
    );
}

export function readPlan(root: string, id: string): Plan | undefined {
    try {
        const value: unknown = JSON.parse(readFileSync(planPath(root, id), "utf8"));
        return isPlan(value) ? value : undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export function writePlan(root: string, plan: Plan): void {
    const file = planPath(root, plan.id);
    mkdirSync(dirname(file), { recursive: true });
    // Temp file plus rename: a crash mid-write leaves the previous plan intact.
    // shortcut: one writer, no lock; add one if a second process can write plans
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
    renameSync(tmp, file);
}

export function listPlans(root: string): PlanList {
    let files: string[];
    try {
        files = readdirSync(plansDir(root));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { plans: [], unreadable: [] };
        throw error;
    }
    const plans: Plan[] = [];
    const unreadable: string[] = [];
    for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
        try {
            const value: unknown = JSON.parse(readFileSync(join(plansDir(root), file), "utf8"));
            if (!isPlan(value)) throw new Error("not a plan");
            plans.push(value);
        } catch {
            unreadable.push(file.slice(0, -5));
        }
    }
    return { plans, unreadable };
}

/** Adds .pi/plans/ to the repo's info/exclude once, the way pi-delegate hides .pi/worktrees. */
export function excludePlans(root: string): void {
    try {
        const file = resolve(
            root,
            execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim(),
        );
        const current = existsSync(file) ? readFileSync(file, "utf8") : "";
        if (
            current
                .split("\n")
                .map((line) => line.trim())
                .includes(PLANS_IGNORE)
        )
            return;
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${PLANS_IGNORE}\n`);
    } catch {
        // Not a git repo, or a .git that cannot be written; plans stay untracked either way.
    }
}

export function doneCount(plan: Plan): number {
    return plan.tasks.filter((task) => task.status === "done").length;
}

/** The first todo task whose blockers are all done, the one to dispatch next. */
export function nextTask(plan: Plan): PlanTask | undefined {
    const done = new Set(plan.tasks.filter((task) => task.status === "done").map((task) => task.id));
    return plan.tasks.find((task) => task.status === "todo" && task.dependsOn.every((id) => done.has(id)));
}

export function taskLine(task: PlanTask): string {
    const parts = [`${task.id} [${task.status}] ${task.title}`];
    if (task.dependsOn.length) parts.push(`dependsOn ${task.dependsOn.join(" ")}`);
    return parts.join(" — ");
}

/** Notes as list items; a continuation line indents by two so it stays inside its item. */
export function noteItem(note: string): string[] {
    const [first = "", ...rest] = note.split("\n");
    return [`- ${first}`, ...rest.map((line) => `  ${line}`)];
}

function planBlock(plan: Plan): string {
    return [
        `# Plan ${plan.id}: ${plan.title} (${doneCount(plan)}/${plan.tasks.length} done)`,
        "",
        "## Goal",
        plan.goal,
        "",
        "## Detail",
        plan.detail,
        ...(plan.notes.length ? ["", "## Notes", ...plan.notes.flatMap(noteItem)] : []),
    ].join("\n");
}

function taskBlock(task: PlanTask): string {
    return [
        `## Task ${task.id} [${task.status}]: ${task.title}`,
        ...(task.dependsOn.length ? [`Depends on: ${task.dependsOn.join(", ")}`] : []),
        "",
        "### Goal",
        task.goal,
        "",
        "### Detail",
        task.detail,
        ...(task.notes.length ? ["", "### Notes", ...task.notes.flatMap(noteItem)] : []),
    ].join("\n");
}

/** One `get` result as markdown: the plan, then every task as its own section. */
export function planText(plan: Plan): string {
    return [planBlock(plan), ...plan.tasks.map((task) => taskBlock(task))].join("\n\n");
}

/** The same plan header, then the one task an executor works from. */
export function taskText(plan: Plan, task: PlanTask): string {
    return [planBlock(plan), taskBlock(task)].join("\n\n");
}

export function listText(root: string, list: PlanList, active: string | undefined): string {
    if (!list.plans.length && !list.unreadable.length) return `No plans in ${plansDir(root)}.`;
    return [
        ...list.plans.map((plan) => `${plan.id === active ? "*" : " "} ${plan.id} ${plan.title} ${planCount(plan)}`),
        ...list.unreadable.map((name) => `? ${name} unreadable`),
    ].join("\n");
}

export function statusText(theme: Theme, status: PlanStatus): string {
    return theme.fg(STATUS[status].color, STATUS[status].glyph);
}

export function planCount(plan: Plan): string {
    return `${doneCount(plan)}/${plan.tasks.length}`;
}

/** `id title 1/4`: the line the widget head, the tool result header and the list all lead with. */
export function planSummary(theme: Theme, plan: Plan): string {
    return `${theme.fg("accent", plan.id)} ${plan.title} ${theme.fg("muted", planCount(plan))}`;
}

/** The plan's own status: done when every task is, doing while one is, todo otherwise. */
export function planStatus(plan: Plan): Exclude<PlanStatus, "blocked"> {
    if (plan.tasks.length && plan.tasks.every((task) => task.status === "done")) return "done";
    return plan.tasks.some((task) => task.status === "doing") ? "doing" : "todo";
}

/** A task row: glyph, id, title, and the blockers still open; a done blocker is no noise worth showing. */
export function taskRow(theme: Theme, plan: Plan, task: PlanTask): string {
    const open = task.dependsOn.filter((id) => !plan.tasks.some((item) => item.id === id && item.status === "done"));
    const blocked = open.length ? ` ${theme.fg("muted", `· dependsOn ${open.join(" ")}`)}` : "";
    return `${statusText(theme, task.status)} ${theme.fg("accent", task.id)} ${task.title}${blocked}`;
}

/** Wrapped rows whose continuations sit `indent` columns in, so a wrapped line never reads as a new one. */
export function hanging(text: string, width: number, indent: number): string[] {
    return wrapTextWithAnsi(text, Math.max(1, width - indent)).map(
        (line, index) => (index ? " ".repeat(indent) : "") + line,
    );
}

/** A labelled line under a task row or in the plan header: the label muted so it reads as a key, the value in `color`, wrapping in the label's column. */
export function fact(
    theme: Theme,
    label: string,
    text: string,
    width: number,
    indent = 2,
    color: ThemeColor = label ? "text" : "dim",
): string[] {
    return hanging((label ? theme.fg("muted", label) : "") + theme.fg(color, text), width - indent, label.length).map(
        (line) => " ".repeat(indent) + line,
    );
}

/** The lines under a task row: its goal, its brief as dim text, and its dim notes as written. */
export function taskFacts(theme: Theme, task: PlanTask, width: number): string[] {
    return [
        ...fact(theme, "Goal: ", task.goal, width),
        ...(task.detail ? fact(theme, "Detail: ", task.detail, width, 2, "dim") : []),
        ...task.notes.flatMap((note) => fact(theme, "", note, width)),
    ];
}

/** pi's built-in expand hint; callers place it on its own row, so it carries no leading newline. */
export function moreLines(theme: Theme, hidden: number, keyHint: KeybindingHints["keyHint"]): string {
    return `${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** The widget head, then one line per task in progress: parallel delegates can run several at once. */
export function widgetLines(theme: Theme, plan: Plan): string[] {
    return [
        `${theme.fg("accent", "plan")} ${plan.title} ${theme.fg("muted", planCount(plan))}`,
        ...plan.tasks
            .filter((task) => task.status === "doing")
            .map((task) => `  ${theme.fg("muted", task.id)} ${task.title}`),
    ];
}

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { KeybindingHints, Theme } from "@earendil-works/pi-coding-agent";

export const STATUSES = ["todo", "doing", "done", "blocked"] as const;

export type PlanStatus = (typeof STATUSES)[number];

export type PlanTask = {
    id: string;
    title: string;
    where?: string;
    blockedBy: string[];
    doneWhen: string;
    status: PlanStatus;
    notes: string[];
};

export type Plan = {
    name: string;
    goal: string;
    context: string;
    tasks: PlanTask[];
};

export type PlanList = {
    plans: Plan[];
    unreadable: string[];
};

/** One status vocabulary for the widget, the tool results and the /plan overlay. */
export const STATUS = {
    todo: { glyph: "○", color: "muted" },
    doing: { glyph: "◐", color: "warning" },
    done: { glyph: "✓", color: "success" },
    blocked: { glyph: "✗", color: "error" },
} as const satisfies Record<PlanStatus, { glyph: string; color: string }>;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

function planPath(root: string, name: string): string {
    if (!NAME.test(name)) throw new Error(`Plan name "${name}" must be kebab-case, for example my-plan.`);
    return join(plansDir(root), `${name}.json`);
}

export function readPlan(root: string, name: string): Plan | undefined {
    try {
        return JSON.parse(readFileSync(planPath(root, name), "utf8")) as Plan;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export function writePlan(root: string, plan: Plan): void {
    const file = planPath(root, plan.name);
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
            const plan = JSON.parse(readFileSync(join(plansDir(root), file), "utf8")) as Plan;
            if (!Array.isArray(plan?.tasks)) throw new Error("no tasks");
            plans.push(plan);
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
    return plan.tasks.find((task) => task.status === "todo" && task.blockedBy.every((id) => done.has(id)));
}

export function taskLine(task: PlanTask): string {
    const parts = [`${task.id} [${task.status}] ${task.title}`];
    if (task.blockedBy.length) parts.push(`blockedBy ${task.blockedBy.join(" ")}`);
    if (task.where) parts.push(`where ${task.where}`);
    return parts.join(" — ");
}

/** One task as text: the status line, then the check and notes indented under it. */
export function taskLines(task: PlanTask): string[] {
    return [
        taskLine(task),
        ...[`doneWhen: ${task.doneWhen}`, ...task.notes.map((note) => `note: ${note}`)].map((line) => `  ${line}`),
    ];
}

export function planText(plan: Plan): string {
    return [
        `plan ${plan.name} ${doneCount(plan)}/${plan.tasks.length}`,
        `goal: ${plan.goal}`,
        `context: ${plan.context}`,
        ...plan.tasks.flatMap(taskLines),
    ].join("\n");
}

export function taskText(plan: Plan, task: PlanTask): string {
    return [
        `plan ${plan.name} ${doneCount(plan)}/${plan.tasks.length}`,
        `goal: ${plan.goal}`,
        `context: ${plan.context}`,
        "",
        ...taskLines(task),
    ].join("\n");
}

export function listText(root: string, list: PlanList, active: string | undefined): string {
    if (!list.plans.length && !list.unreadable.length) return `No plans in ${plansDir(root)}.`;
    return [
        ...list.plans.map((plan) => {
            const next = nextTask(plan);
            const mark = plan.name === active ? "*" : " ";
            return `${mark} ${plan.name} ${planCount(plan)}${next ? ` · next ${next.id}` : ""}`;
        }),
        ...list.unreadable.map((name) => `? ${name} unreadable`),
    ].join("\n");
}

export function statusText(theme: Theme, status: PlanStatus): string {
    return theme.fg(STATUS[status].color, STATUS[status].glyph);
}

export function planCount(plan: Plan): string {
    return `${doneCount(plan)}/${plan.tasks.length}`;
}

/** `name 1/4 · doing t2 · next t3`: the line the widget, the tool header and the list all lead with. */
export function planSummary(theme: Theme, plan: Plan): string {
    const stats = [planCount(plan)];
    const doing = plan.tasks.find((task) => task.status === "doing");
    if (doing) stats.push(`doing ${doing.id}`);
    const next = nextTask(plan);
    if (next) stats.push(`next ${next.id}`);
    return `${theme.fg("accent", plan.name)} ${theme.fg("muted", stats.join(" · "))}`;
}

/** The plan's own status: done when every task is, doing while one is, todo otherwise. */
export function planStatus(plan: Plan): Exclude<PlanStatus, "blocked"> {
    if (plan.tasks.length && plan.tasks.every((task) => task.status === "done")) return "done";
    return plan.tasks.some((task) => task.status === "doing") ? "doing" : "todo";
}

/** A task row: glyph, id, title, and the blockers still open; a done blocker is no noise worth showing. */
export function taskRow(theme: Theme, plan: Plan, task: PlanTask): string {
    const open = task.blockedBy.filter((id) => !plan.tasks.some((item) => item.id === id && item.status === "done"));
    const blocked = open.length ? ` ${theme.fg("muted", `· blockedBy ${open.join(" ")}`)}` : "";
    return `${statusText(theme, task.status)} ${theme.fg("accent", task.id)} ${task.title}${blocked}`;
}

/** The muted lines under a task row: where it lives, its check, and its notes. */
export function taskFacts(theme: Theme, task: PlanTask): string[] {
    return [
        ...(task.where ? [`where ${task.where}`] : []),
        `doneWhen: ${task.doneWhen}`,
        ...task.notes.map((note) => `note: ${note}`),
    ].map((line) => `  ${theme.fg("dim", line)}`);
}

/** pi's built-in expand hint; callers place it on its own row, so it carries no leading newline. */
export function moreLines(theme: Theme, hidden: number, keyHint: KeybindingHints["keyHint"]): string {
    return `${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** The one-line widget: the plan summary every other view also leads with. */
export function widgetLine(theme: Theme, plan: Plan): string {
    return `${theme.fg("accent", "plan")} ${planSummary(theme, plan)}`;
}

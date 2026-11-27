import { rawKeyHint, getMarkdownTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
    Markdown,
    type Component,
    type Keybinding,
    type KeybindingsManager,
    matchesKey,
    type TuiMouseEvent,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
    doneCount,
    hanging,
    nextTask,
    planCount,
    planStatus,
    statusText,
    type Plan,
    type PlanList,
    type PlanTask,
} from "./store.ts";

type PlansScreenOptions = {
    plans: Plan[];
    unreadable: string[];
    active?: string;
    theme: Theme;
    keys: KeybindingsManager;
    /** Terminal rows, read per frame. */
    height: () => number;
    setActive: (name: string) => void;
    onClose: () => void;
    requestRender: () => void;
};

/** Fixed rows: title, top rule, bottom rule, footer. */
const CHROME_ROWS = 4;
/** Prose past this width is hard to follow on a wide terminal; the pane leaves the rest empty. */
const MAX_TEXT_WIDTH = 120;
/** Rendered markdown by theme, then width and text; cleared by invalidate() and on a width change. */
const MARKDOWN_CACHE = new WeakMap<Theme, Map<string, string[]>>();

type Focus = "list" | "detail";

function hint(keys: KeybindingsManager, ids: Keybinding[], description: string): string {
    return rawKeyHint(ids.flatMap((id) => keys.getKeys(id)).join("/"), description);
}

/** Markdown reads a lone newline as a space; a planner's one-newline paragraph break is meant as a break. */
function hardBreaks(text: string): string {
    const lines = text.split("\n");
    let fenced = false;
    return lines
        .map((line, index) => {
            const fence = /^\s*(```|~~~)/.test(line);
            const block = fenced || fence || /^\s*([-*+]|\d+\.)\s/.test(line) || /^\s*#/.test(line);
            if (fence) fenced = !fenced;
            return block || !lines[index + 1] ? line : `${line}  `;
        })
        .join("\n");
}

/** Markdown rendered at one width, cached per theme: render() runs every frame and contexts can be long. */
function markdown(theme: Theme, text: string, width: number, indent = 0): string[] {
    let cache = MARKDOWN_CACHE.get(theme);
    if (!cache) MARKDOWN_CACHE.set(theme, (cache = new Map()));
    const key = `${width} ${text}`;
    let lines = cache.get(key);
    if (!lines) {
        const component = new Markdown(hardBreaks(text), 0, 0, getMarkdownTheme(), {
            color: (t) => theme.fg("text", t),
        });
        // Markdown pads every row to its width; the pane pads again, so trim before composing.
        lines = component.render(Math.max(1, width)).map((line) => line.trimEnd());
        while (lines.length && !lines[0]) lines.shift();
        while (lines.length && !lines.at(-1)) lines.pop();
        cache.set(key, lines);
    }
    return lines.map((line) => " ".repeat(indent) + line);
}

/** A section heading: the word in accent, a rule to the pane edge, and the tasks heading's own count. */
function section(theme: Theme, word: string, width: number, trailing = ""): string {
    const head = `${theme.bold(theme.fg("accent", word))} `;
    const rule = "─".repeat(Math.max(0, width - visibleWidth(head) - visibleWidth(trailing)));
    return head + theme.fg("borderMuted", rule) + trailing;
}

/** The title row: the glyph, the title, and the id at the right edge, with the blockers still open after it. */
function taskLines(plan: Plan, task: PlanTask, theme: Theme, width: number, current: boolean): string[] {
    const open = task.blockedBy.filter((id) => !plan.tasks.some((item) => item.id === id && item.status === "done"));
    const id = theme.fg("muted", open.length ? `${task.id} · after ${open.join(", ")}` : task.id);
    // Accent means headings and labels, so the task the reader is on is bold text instead.
    const title = theme.fg("text", task.title);
    const [first = "", ...rest] = hanging(current ? theme.bold(title) : title, width, 2);
    // The id sits beside the first row only, so that row loses the room the id and its gap take.
    const room = Math.max(1, width - 3 - visibleWidth(id));
    return [`${statusText(theme, task.status)} ${truncateToWidth(first, room, "…", true)} ${id}`, ...rest];
}

/** An accent label padded into one column, then its value in the column beside it. */
function field(theme: Theme, label: string, value: string, width: number, prose = false): string[] {
    const lead = `  ${theme.fg("accent", label.padEnd(9))}  `;
    const column = visibleWidth(lead);
    const lines = prose
        ? markdown(theme, value, Math.max(1, width - column))
        : wrapTextWithAnsi(theme.fg("text", value), Math.max(1, width - column));
    const [first = "", ...rest] = lines;
    return [lead + first, ...rest.map((line) => " ".repeat(column) + line)];
}

/** One task: its title row, then the check, where and notes of every task still open. */
function taskBlock(
    plan: Plan,
    task: PlanTask,
    theme: Theme,
    width: number,
    current: boolean,
    expanded: boolean,
): string[] {
    const head = taskLines(plan, task, theme, width, current);
    if (!expanded && task.status === "done") return head;
    return [
        ...head,
        // Both labels pad to nine columns, so the two values start in one column.
        ...field(theme, "Done when", task.doneWhen, width, true),
        ...(task.where ? field(theme, "Where", task.where, width) : []),
        ...task.notes.flatMap((note) => ["", ...markdown(theme, note, Math.max(1, width - 2), 2)]),
        "",
    ];
}

/** Goal, tasks and context as three sections; the headings show where the reader is in a long plan. */
function taskRows(plan: Plan, theme: Theme, width: number, expanded: boolean): string[] {
    const current = plan.tasks.find((task) => task.status === "doing") ?? nextTask(plan);
    const blocks = plan.tasks.flatMap((task) => taskBlock(plan, task, theme, width, task === current, expanded));
    // The next heading brings its own leading blank line, so a task's trailing one would double it.
    if (blocks.at(-1) === "") blocks.pop();
    return [
        ...markdown(theme, plan.goal, width),
        "",
        section(theme, "Tasks", width, theme.fg("muted", ` ${planCount(plan)}`)),
        ...blocks,
        "",
        section(theme, "Context", width),
        ...markdown(theme, plan.context, width),
    ].map((line) => truncateToWidth(line, width, "…", true));
}

/** Two rows per plan, like pi-delegate's job rows: cursor, status glyph, name and count, then the goal. */
function sidebarRows(
    plans: Plan[],
    unreadable: string[],
    selected: number,
    active: string | undefined,
    focus: Focus,
    theme: Theme,
    width: number,
    height: number,
): { lines: string[]; indexes: (number | undefined)[] } {
    const all: { lines: string[]; index?: number }[] = [
        ...plans.map((plan, planIndex) => {
            const chosen = planIndex === selected;
            // The cursor dims while the detail pane takes the keys, so the user sees which pane is live.
            const cursor = chosen ? theme.fg(focus === "list" ? "accent" : "muted", "›") : " ";
            return {
                lines: [
                    `${cursor} ${statusText(theme, planStatus(plan))} ${theme.fg(chosen ? "accent" : "text", plan.name)} ${theme.fg("muted", planCount(plan))}`,
                    theme.fg("dim", `  ${plan.name === active ? "active · " : ""}${plan.goal}`),
                ],
                index: planIndex,
            };
        }),
        ...unreadable.map((name) => ({ lines: [theme.fg("error", `  ? ${name} unreadable`)] })),
    ];
    const rows = all.flatMap((entry) => entry.lines.map((line, at) => ({ line, index: entry.index, head: at === 0 })));
    const selectedRow = rows.findIndex((row) => row.index === selected);
    let start = Math.max(0, Math.min(selectedRow - Math.floor(height / 2), rows.length - height));
    // A window never opens on a plan's second row, which would show a goal with no name above it.
    while (start > 0 && !rows[start]!.head) start--;
    const shown = rows.slice(start, start + height);
    return {
        lines: [
            ...shown.map(
                (row) => truncateToWidth(row.line, Math.max(0, width - 1), "…", true) + theme.fg("borderMuted", "│"),
            ),
            ...Array(Math.max(0, height - shown.length)).fill(
                " ".repeat(Math.max(0, width - 1)) + theme.fg("borderMuted", "│"),
            ),
        ],
        indexes: shown.map((row) => row.index),
    };
}

/** The /plan screen, laid out like pi-delegate's: the plans on the left, the selected one's tasks on the right. */
export class PlansScreen implements Component {
    private readonly options: PlansScreenOptions;
    private index: number;
    private active: string | undefined;
    private focus: Focus = "list";
    private top = 0;
    private expanded = false;
    private lastBody = { height: 0, total: 0 };
    private lastIndexes: (number | undefined)[] = [];
    private lastSidebar = 0;
    private lastTextWidth = 0;

    constructor(options: PlansScreenOptions) {
        this.options = options;
        this.active = options.active;
        const found = options.active ? options.plans.findIndex((plan) => plan.name === options.active) : -1;
        this.index = Math.max(0, found);
    }

    invalidate() {
        MARKDOWN_CACHE.delete(this.options.theme);
    }

    render(width: number): string[] {
        const { plans, unreadable, theme, height, keys } = this.options;
        const rows = Math.max(0, height());
        const body = Math.max(0, rows - CHROME_ROWS);
        const sidebarWidth = Math.min(40, Math.max(16, Math.floor(width * 0.35)), Math.max(1, width - 2));
        const detailWidth = Math.max(1, width - sidebarWidth - 1);
        this.lastSidebar = sidebarWidth;
        const row = (text: string, columns = width) => truncateToWidth(text, columns, "…", true);
        const list = this.focus === "list";
        const title = row(
            `${theme.fg(list ? "accent" : "muted", list ? "[Plans]" : "Plans")}  ` +
                `${theme.fg(list ? "muted" : "accent", list ? "Tasks" : "[Tasks]")}` +
                theme.fg("dim", ` · ${plans.length + unreadable.length} in .pi/plans`),
        );
        const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
        // Always-on keys first, so the pane's own hints can spill off a narrow line.
        const paneHints = list
            ? hint(keys, ["tui.select.up", "tui.select.down"], "select plan")
            : `${hint(keys, ["tui.select.up", "tui.select.down"], "scroll")} · ${hint(keys, ["tui.altScreen.pageUp", "tui.altScreen.pageDown"], "page")}`;
        const footer = row(
            theme.fg(
                "dim",
                [
                    rawKeyHint("←/→", "pane"),
                    hint(keys, ["tui.select.confirm"], "make active"),
                    hint(keys, ["tui.select.cancel"], "close"),
                    hint(keys, ["app.tools.expand"], this.expanded ? "collapse" : "expand"),
                    paneHints,
                ].join(" · "),
            ),
        );
        const plan = plans[this.index];
        const sidebar = sidebarRows(plans, unreadable, this.index, this.active, this.focus, theme, sidebarWidth, body);
        this.lastIndexes = sidebar.indexes;
        const detail = plan
            ? this.detail(plan, Math.min(detailWidth, MAX_TEXT_WIDTH), detailWidth, body)
            : [row(theme.fg("muted", "No readable plans."), detailWidth)];
        return [title, rule, ...sidebar.lines.map((line, index) => `${line} ${detail[index] ?? ""}`), rule, footer];
    }

    handleInput(data: string): void {
        const { keys, onClose, setActive } = this.options;
        const detail = this.focus === "detail";
        if (keys.matches(data, "tui.select.cancel")) onClose();
        else if (matchesKey(data, "left")) this.focus = "list";
        else if (matchesKey(data, "right")) this.focus = "detail";
        else if (keys.matches(data, "tui.select.confirm")) {
            const plan = this.options.plans[this.index];
            if (!plan) return;
            this.active = plan.name;
            setActive(plan.name);
        } else if (keys.matches(data, "app.tools.expand")) {
            this.expanded = !this.expanded;
            this.top = 0;
        } else if (detail && keys.matches(data, "tui.altScreen.pageUp")) this.scroll(-this.pageSize());
        else if (detail && keys.matches(data, "tui.altScreen.pageDown")) this.scroll(this.pageSize());
        else if (detail && keys.matches(data, "tui.altScreen.top")) this.top = 0;
        else if (detail && keys.matches(data, "tui.altScreen.bottom")) this.top = Infinity;
        else if (keys.matches(data, "tui.select.up")) this.move(-1);
        else if (keys.matches(data, "tui.select.down")) this.move(1);
        this.options.requestRender();
    }

    // Fullscreen turns on mouse tracking, so the wheel arrives here instead of as arrow keys.
    handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) {
            if (event.x < this.lastSidebar) this.select(event.wheelDelta < 0 ? -1 : 1);
            else this.scroll(event.wheelDelta);
        } else if (event.type === "click" && event.button === "left" && event.x < this.lastSidebar) {
            const target = this.lastIndexes[event.y - 2];
            if (event.y < 2 || event.y - 2 >= this.lastBody.height || target === undefined) return;
            this.index = target;
            this.top = 0;
        } else if (event.type === "click" && event.button === "left") this.focus = "detail";
        else return;
        this.options.requestRender();
        return { handled: true };
    }

    /** The right pane: the plan's name stays put over the goal, tasks and context, with a counter below. */
    private detail(plan: Plan, textWidth: number, width: number, body: number): string[] {
        const { theme } = this.options;
        if (this.lastTextWidth !== textWidth) {
            this.lastTextWidth = textWidth;
            MARKDOWN_CACHE.delete(theme);
        }
        const blocked = plan.tasks.some((task) => task.status === "blocked") ? " · blocked" : "";
        const progress = theme.fg("muted", `${doneCount(plan)} of ${plan.tasks.length} done${blocked}`);
        const name = theme.fg("accent", plan.name);
        const header = [
            name + " ".repeat(Math.max(0, textWidth - visibleWidth(name) - visibleWidth(progress))) + progress,
        ];
        const height = Math.max(0, body - header.length - 1);
        const all = taskRows(plan, theme, textWidth, this.expanded);
        const start = Math.min(this.top, Math.max(0, all.length - height));
        this.top = start;
        this.lastBody = { height, total: all.length };
        const shown = all.slice(start, start + height);
        const counter = theme.fg(
            "muted",
            shown.length ? `${start + 1}–${start + shown.length}/${all.length}` : `0/${all.length}`,
        );
        // Right-aligned like pi-delegate's counter; every row is padded so the pane's right edge holds still.
        const tail = " ".repeat(Math.max(0, width - visibleWidth(counter))) + counter;
        return [...header, ...shown, ...Array(Math.max(0, height - shown.length)).fill(""), tail].map((line) =>
            truncateToWidth(line, width, "…", true),
        );
    }

    // Detail focus scrolls by a line; list focus moves the cursor.
    private move(step: number) {
        if (this.focus === "detail") this.scroll(step);
        else this.select(step);
    }

    private select(step: number) {
        this.index = Math.max(0, Math.min(this.options.plans.length - 1, this.index + step));
        this.top = 0;
    }

    // pi's alt-screen viewport pages by a window height minus a small overlap.
    private pageSize() {
        return Math.max(1, this.lastBody.height - 4);
    }

    private scroll(delta: number) {
        const maxTop = Math.max(0, this.lastBody.total - this.lastBody.height);
        this.top = Math.max(0, Math.min(maxTop, this.top + delta));
    }
}

export function openPlans(
    ctx: ExtensionContext,
    list: PlanList,
    active: string | undefined,
    setActive: (name: string) => void,
): Promise<void> {
    const screen = { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0 } } as const;
    return ctx.ui.custom<void>(
        (tui, theme, keys, done) =>
            new PlansScreen({
                plans: list.plans,
                unreadable: list.unreadable,
                active,
                theme,
                keys,
                height: () => tui.terminal.rows,
                setActive,
                onClose: () => done(undefined),
                requestRender: () => tui.requestRender(),
            }),
        screen,
    );
}

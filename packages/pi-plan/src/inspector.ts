import { rawKeyHint, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
    type Component,
    type Keybinding,
    type KeybindingsManager,
    type TuiMouseEvent,
    truncateToWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { planCount, planStatus, planSummary, STATUS, taskFacts, taskRow, type Plan, type PlanList } from "./store.ts";

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

function hint(keys: KeybindingsManager, ids: Keybinding[], description: string): string {
    return rawKeyHint(ids.flatMap((id) => keys.getKeys(id)).join("/"), description);
}

function sidebarRows(
    plans: Plan[],
    unreadable: string[],
    selected: number,
    active: string | undefined,
    theme: Theme,
    width: number,
    height: number,
): { lines: string[]; indexes: (number | undefined)[] } {
    const all: { line: string; index?: number }[] = [
        ...plans.map((plan, planIndex) => {
            const chosen = planIndex === selected;
            // pi-delegate's cursor column: the matched glyph, then the name, like its job rows.
            const name = theme.fg(chosen ? "accent" : "text", plan.name);
            const count = theme.fg(STATUS[planStatus(plan)].color, planCount(plan));
            const mark = plan.name === active ? theme.fg("muted", " · active") : "";
            const line = `${chosen ? theme.fg("accent", "›") : " "} ${name} ${count}${mark}`;
            return { line, index: planIndex };
        }),
        ...unreadable.map((name) => ({ line: theme.fg("error", `  ? ${name} unreadable`) })),
    ];
    const start = Math.max(0, Math.min(selected - Math.floor(height / 2), all.length - height));
    const shown = all.slice(start, start + height);
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

function detailRows(plan: Plan, theme: Theme, width: number): string[] {
    const lines = [
        ...wrapTextWithAnsi(planSummary(theme, plan), width),
        "",
        ...wrapTextWithAnsi(theme.fg("muted", `goal: ${plan.goal}`), width),
        ...(plan.context ? ["", ...wrapTextWithAnsi(theme.fg("muted", `context: ${plan.context}`), width)] : []),
        "",
    ];
    for (const task of plan.tasks) {
        lines.push(...wrapTextWithAnsi(taskRow(theme, plan, task), width));
        for (const fact of taskFacts(theme, task)) lines.push(...wrapTextWithAnsi(fact, width));
        lines.push("");
    }
    return lines.map((line) => truncateToWidth(line, width, "…", true));
}

/** The /plan screen: every plan in the sidebar, the selected one's tasks on the right. */
export class PlansScreen implements Component {
    private readonly options: PlansScreenOptions;
    private index: number;
    private active: string | undefined;
    private top = 0;
    private lastBody = { height: 0, total: 0 };
    private lastIndexes: (number | undefined)[] = [];
    private lastSidebar = 0;

    constructor(options: PlansScreenOptions) {
        this.options = options;
        this.active = options.active;
        const found = options.active ? options.plans.findIndex((plan) => plan.name === options.active) : -1;
        this.index = Math.max(0, found);
    }

    invalidate() {}

    render(width: number): string[] {
        const { plans, unreadable, theme, height, keys } = this.options;
        const rows = Math.max(0, height());
        const body = Math.max(0, rows - CHROME_ROWS);
        const sidebarWidth = Math.min(40, Math.max(16, Math.floor(width * 0.35)), Math.max(1, width - 2));
        const detailWidth = Math.max(1, width - sidebarWidth - 1);
        this.lastSidebar = sidebarWidth;
        const row = (text: string, columns = width) => truncateToWidth(text, columns, "…", true);
        const title = row(
            `${theme.fg("accent", "Plans")}${theme.fg("dim", ` · ${plans.length + unreadable.length} in .pi/plans`)}`,
        );
        const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
        const footer = row(
            theme.fg(
                "dim",
                [
                    hint(keys, ["tui.select.up", "tui.select.down"], "select plan"),
                    hint(keys, ["tui.select.confirm"], "make active"),
                    hint(keys, ["tui.altScreen.pageUp", "tui.altScreen.pageDown"], "scroll"),
                    hint(keys, ["tui.select.cancel"], "close"),
                ].join(" · "),
            ),
        );
        const plan = plans[this.index];
        const sidebar = sidebarRows(plans, unreadable, this.index, this.active, theme, sidebarWidth, body);
        this.lastIndexes = sidebar.indexes;
        const detail = plan
            ? detailRows(plan, theme, detailWidth)
            : [row(theme.fg("muted", "No readable plans."), detailWidth)];
        const start = Math.min(this.top, Math.max(0, detail.length - body));
        this.top = start;
        this.lastBody = { height: body, total: detail.length };
        const shown = detail.slice(start, start + body);
        const right = [...shown, ...Array(Math.max(0, body - shown.length)).fill("")];
        return [title, rule, ...sidebar.lines.map((line, index) => `${line} ${right[index] ?? ""}`), rule, footer];
    }

    handleInput(data: string): void {
        const { keys, onClose, setActive } = this.options;
        if (keys.matches(data, "tui.select.cancel")) onClose();
        else if (keys.matches(data, "tui.select.up")) this.select(-1);
        else if (keys.matches(data, "tui.select.down")) this.select(1);
        else if (keys.matches(data, "tui.select.confirm")) {
            const plan = this.options.plans[this.index];
            if (!plan) return;
            this.active = plan.name;
            setActive(plan.name);
        } else if (keys.matches(data, "tui.altScreen.pageUp")) this.scroll(-this.pageSize());
        else if (keys.matches(data, "tui.altScreen.pageDown")) this.scroll(this.pageSize());
        this.options.requestRender();
    }

    // Fullscreen turns on mouse tracking, so the wheel arrives here instead of as arrow keys.
    handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) this.scroll(event.wheelDelta);
        else if (event.type === "click" && event.button === "left" && event.x < this.lastSidebar) {
            const target = this.lastIndexes[event.y - 2];
            if (event.y < 2 || event.y - 2 >= this.lastBody.height || target === undefined) return;
            this.index = target;
            this.top = 0;
        } else return;
        this.options.requestRender();
        return { handled: true };
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

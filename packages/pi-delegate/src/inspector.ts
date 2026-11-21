import {
    AssistantMessageComponent,
    type ExtensionAPI,
    rawKeyHint,
    type Theme,
    UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
    Box,
    compositeTuiLine,
    type Component,
    type Keybinding,
    matchesKey,
    Spacer,
    Text,
    truncateToWidth,
    type TuiMouseEvent,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type ChildMessage, sessionMessages } from "./child.ts";
import {
    elapsedMs,
    formatDuration,
    formatTools,
    jobIdentity,
    resultPreview,
    STATUS_COLORS,
    statusText,
    tally,
    textParts,
    toolCallDetail,
    toolLines,
    usageFromMessages,
    usageLine,
    usageStats,
} from "./format.ts";
import type { InspectJob, JobStore } from "./store.ts";

type Entry = { component: Component; lines?: string[] };

// pi's chat components prefix lines with OSC 133 prompt markers; past the sidebar the terminal would read one as a new prompt.
const OSC133 = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

/** Rendered transcript rows, cached per width so a frame only renders rows it has never seen. */
export class History {
    private readonly entries: Entry[] = [];
    private width = 0;

    add(component: Component): Entry {
        const entry: Entry = { component };
        this.entries.push(entry);
        return entry;
    }

    invalidate() {
        for (const entry of this.entries) {
            entry.component.invalidate?.();
            entry.lines = undefined;
        }
    }

    window(width: number, top: number | undefined, height: number) {
        if (this.width !== width) {
            this.width = width;
            for (const entry of this.entries) entry.lines = undefined;
        }
        const all = this.entries.flatMap(
            (entry) => (entry.lines ??= entry.component.render(width).map((line) => line.replace(OSC133, ""))),
        );
        const start = Math.min(top ?? Infinity, Math.max(0, all.length - height));
        return { lines: all.slice(start, start + height), start, total: all.length };
    }
}

/** One tool call as a compact pi-style box: the call row plus its first result line, or the whole output when expanded. */
class ToolRow implements Component {
    private readonly theme: Theme;
    private readonly name: string;
    private readonly detail: string;
    private readonly expanded: () => boolean;
    private result?: string;
    private output?: string;
    private done = false;
    private error = false;

    constructor(theme: Theme, name: string, detail: string, expanded: () => boolean) {
        this.theme = theme;
        this.name = name;
        this.detail = detail;
        this.expanded = expanded;
    }

    invalidate() {}

    setResult(message: Extract<ChildMessage, { role: "toolResult" }>) {
        this.result = resultPreview(message);
        this.output = textParts(message.content).join("\n").trim();
        this.done = true;
        this.error = message.isError === true;
    }

    render(width: number) {
        const theme = this.theme;
        // The box's own horizontal padding leaves width - 2 for each truncated row.
        const inner = Math.max(1, width - 2);
        const full = this.expanded() ? this.output : undefined;
        const text = toolLines(theme, this.name, this.detail, full ? undefined : this.result, this.error)
            .flatMap((line, index) =>
                index === 0 && full
                    ? [line, ...full.split("\n").map((row) => theme.fg(this.error ? "error" : "toolOutput", row))]
                    : [line],
            )
            .map((line) => truncateToWidth(line, inner))
            .join("\n");
        const bg = this.error ? "toolErrorBg" : this.done ? "toolSuccessBg" : "toolPendingBg";
        // pi's own tool box and spacing; only the content is compact.
        const box = new Box(1, 1, (line) => theme.bg(bg, line));
        box.addChild(new Text(text, 0, 0));
        return ["", ...box.render(width)];
    }
}

/** One job's transcript, built from pi's chat components and kept in sync as messages arrive. */
export class Transcript {
    private history = new History();
    private messages?: ChildMessage[];
    private count = 0;
    private readonly expanded: () => boolean;
    private readonly pending = new Map<string, Entry>();
    private readonly theme: Theme;

    constructor(theme: Theme, expanded: () => boolean = () => false) {
        this.theme = theme;
        this.expanded = expanded;
    }

    sync(messages: ChildMessage[]) {
        // The store swaps a finished job's live array for the session file's, so a different array is a new transcript.
        if (messages !== this.messages) {
            this.messages = messages;
            this.history = new History();
            this.count = 0;
            this.pending.clear();
        }
        while (this.count < messages.length) this.add(messages[this.count++]!);
    }

    window(width: number, top: number | undefined, height: number) {
        return this.history.window(width, top, height);
    }

    invalidate() {
        this.history.invalidate();
    }

    private add(message: ChildMessage) {
        if (message.role === "user") {
            const text = textParts(message.content).join("");
            if (!text) return;
            // pi's chat spaces user messages itself; the component carries no margin.
            this.history.add(new Spacer(1));
            this.history.add(new UserMessageComponent(text));
            return;
        }
        if (message.role === "assistant") {
            // Thinking blocks are the child's scratchpad; the inspector shows what it said and did.
            this.history.add(new AssistantMessageComponent(message, true, undefined, ""));
            for (const part of message.content) {
                if (part.type !== "toolCall") continue;
                const row = new ToolRow(
                    this.theme,
                    part.name,
                    toolCallDetail(part.name, part.arguments),
                    this.expanded,
                );
                this.pending.set(part.id, this.history.add(row));
            }
            return;
        }
        if (message.role === "toolResult") {
            const entry = this.pending.get(message.toolCallId);
            if (!entry) return;
            (entry.component as ToolRow).setResult(message);
            entry.lines = undefined;
            return;
        }
        // display: false marks model-only context (e.g. pi-archive's recent sessions); pi's chat hides it too.
        if ((message as { display?: boolean }).display === false) return;
        const text =
            message.role === "compactionSummary"
                ? message.summary
                : textParts((message as { content?: unknown }).content).join("");
        if (!text) return;
        this.history.add(new Spacer(1));
        this.history.add(new Text(text, 1, 0));
    }
}

/** The /delegate command: a full-screen inspector over the job store. */
export function registerInspector(pi: ExtensionAPI, store: JobStore, sessionDir: string) {
    pi.registerCommand("delegate", {
        description: "Inspect live and recent delegate activity",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") return;
            if (!store.all().length) {
                ctx.ui.notify("No delegates in this session yet.", "info");
                return;
            }
            const screen = {
                overlay: true,
                overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0 },
            } as const;
            let stopRedraw: (() => void) | undefined;
            try {
                await ctx.ui.custom((tui, theme, keys, done) => {
                    let selectedId = store.all()[0]!.id;
                    let focus: "list" | "history" = "list";
                    let top: number | undefined;
                    let lastWindow = { height: 0, total: 0 };
                    let expanded = false;
                    let lastSidebar = 0;
                    let lastJobsStart = 0;
                    const transcripts = new Map<string, Transcript>();
                    const loaded = new Set<string>();
                    function jobs() {
                        return store.all();
                    }
                    function selectJob(step: number) {
                        const items = jobs();
                        const index = Math.max(
                            0,
                            items.findIndex((item) => item.id === selectedId),
                        );
                        selectedId = items[Math.max(0, Math.min(items.length - 1, index + step))]?.id ?? selectedId;
                        top = undefined;
                    }
                    // Format hints from the injected manager; an imported copy would not see the user's keybindings.
                    function hint(id: Keybinding | Keybinding[], description: string) {
                        const ids = Array.isArray(id) ? id : [id];
                        return rawKeyHint(ids.flatMap((one) => keys.getKeys(one)).join("/"), description);
                    }
                    /** pi's Jump-to-latest pill, drawn over the last transcript row of a fullscreen chat. */
                    function jumpPill() {
                        const key = keys
                            .getKeys("tui.altScreen.bottom")
                            .map((one) =>
                                one
                                    .split("+")
                                    .map((part) => {
                                        const shown =
                                            process.platform === "darwin" && part.toLowerCase() === "alt"
                                                ? "option"
                                                : part;
                                        return shown.charAt(0).toUpperCase() + shown.slice(1);
                                    })
                                    .join("+"),
                            )
                            .join("/");
                        return theme.bg(
                            "selectedBg",
                            theme.fg("text", ` ↓ Jump to latest message${key ? ` · ${key}` : ""} `),
                        );
                    }
                    // Fixed rows: title, top rule, bottom rule, footer.
                    function bodyHeight() {
                        return Math.max(0, tui.terminal.rows - 4);
                    }
                    // pi's alt-screen viewport pages by a window height minus a small overlap.
                    function pageSize() {
                        return Math.max(1, lastWindow.height - 4);
                    }
                    function scroll(delta: number) {
                        const maxTop = Math.max(0, lastWindow.total - lastWindow.height);
                        const position = Math.max(0, Math.min(maxTop, top ?? maxTop) + delta);
                        top = position >= maxTop ? undefined : position;
                    }
                    function toolsLines(job: InspectJob, width: number) {
                        return wrapTextWithAnsi(formatTools(job.tools), Math.max(1, width)).map((line) =>
                            theme.fg("dim", line),
                        );
                    }
                    function transcript(job: InspectJob) {
                        let value = transcripts.get(job.id);
                        if (!value) {
                            value = new Transcript(theme, () => expanded);
                            transcripts.set(job.id, value);
                        }
                        return value;
                    }
                    // Restored jobs carry no messages: the child's session file is their history.
                    function messagesOf(job: InspectJob) {
                        if (!job.messages.length && job.status !== "running" && !loaded.has(job.id)) {
                            loaded.add(job.id);
                            job.messages = sessionMessages(sessionDir, job.id);
                        }
                        return job.messages;
                    }
                    function renderJobs(width: number, items: InspectJob[], selectedIndex: number): string[] {
                        function row(text: string) {
                            return (
                                truncateToWidth(text, Math.max(0, width - 1), "…", true) + theme.fg("borderMuted", "│")
                            );
                        }
                        const visible = Math.max(1, Math.floor((bodyHeight() - 1) / 3));
                        const start = Math.max(
                            0,
                            Math.min(selectedIndex - Math.floor(visible / 2), items.length - visible),
                        );
                        lastJobsStart = start;
                        const lines = items
                            .slice(start, start + visible)
                            .flatMap((item, index) => [
                                row(
                                    `${theme.fg(start + index === selectedIndex && focus === "list" ? "accent" : "text", start + index === selectedIndex ? "›" : " ")} ${statusText(theme, item.status)} ${jobIdentity(theme, item)}`,
                                ),
                                row(theme.fg("muted", `    ${item.description}`)),
                                row(theme.fg("muted", `    ${usageStats(item, elapsedMs(item))}`)),
                            ]);
                        return [
                            ...lines,
                            ...Array(Math.max(0, bodyHeight() - 1 - lines.length)).fill(row("")),
                            row(theme.fg("dim", `${selectedIndex + 1}/${items.length}`)),
                        ].slice(0, bodyHeight());
                    }
                    function renderHistory(width: number, job: InspectJob): string[] {
                        const tools = toolsLines(job, width);
                        // Fixed rows: header, model, rule, footer, plus the failure detail.
                        const height = Math.max(0, bodyHeight() - 4 - tools.length - (job.detail ? 1 : 0));
                        const view = transcript(job);
                        const messages = messagesOf(job);
                        view.sync(messages);
                        // A finished job keeps the totals captured at finish; a restored one recounts its transcript.
                        const usage = theme.fg(
                            "dim",
                            usageLine(
                                theme,
                                job.usage ?? usageFromMessages(messages, job.contextTokens),
                                job.contextWindow,
                            ),
                        );
                        const window = view.window(width, top, height);
                        lastWindow = { height, total: window.total };
                        const shown = window.lines.length
                            ? window.lines
                            : height
                              ? [
                                    theme.fg(
                                        "muted",
                                        job.status === "interrupted"
                                            ? "Interrupted by a crash before activity was recorded."
                                            : "Waiting for activity…",
                                    ),
                                ]
                              : [];
                        const counterText = window.lines.length
                            ? `${window.start + 1}–${window.start + window.lines.length}/${window.total}`
                            : `0/${window.total}`;
                        const rows = [
                            truncateToWidth(
                                `${statusText(theme, job.status)} ${jobIdentity(theme, job)} ${job.description} ${theme.fg("muted", `· ${formatDuration(elapsedMs(job))}`)}`,
                                width,
                            ),
                            truncateToWidth(theme.fg("dim", job.model), width),
                            ...tools,
                            theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
                            ...shown,
                            ...Array(Math.max(0, height - shown.length)).fill(""),
                            ...(job.detail ? [truncateToWidth(theme.fg(STATUS_COLORS.failed, job.detail), width)] : []),
                            `${truncateToWidth(usage, Math.max(0, width - visibleWidth(counterText) - 2), "…")}  ${theme.fg("dim", counterText)}`,
                        ]
                            .slice(0, bodyHeight())
                            // Pad every row so the pane's right edge holds still while the transcript scrolls.
                            .map((line) => truncateToWidth(line, width, "…", true));
                        // The pill sits on the last transcript row of the right pane.
                        if (top !== undefined && shown.length && window.total > height) {
                            const pill = truncateToWidth(jumpPill(), width, "");
                            const row = rows.length - 2 - (job.detail ? 1 : 0);
                            rows[row] = compositeTuiLine(
                                rows[row] ?? "",
                                pill,
                                Math.floor((width - visibleWidth(pill)) / 2),
                                visibleWidth(pill),
                                width,
                            );
                        }
                        return rows;
                    }
                    stopRedraw = store.subscribe(() => tui.requestRender());
                    return {
                        render(width: number) {
                            const items = jobs();
                            const selectedIndex = Math.max(
                                0,
                                items.findIndex((item) => item.id === selectedId),
                            );
                            const selected = items[selectedIndex];
                            const title = truncateToWidth(
                                `${theme.fg(focus === "list" ? "accent" : "muted", focus === "list" ? "[Jobs]" : "Jobs")}  ` +
                                    `${theme.fg(focus === "history" ? "accent" : "muted", focus === "history" ? "[Activity]" : "Activity")}` +
                                    theme.fg("dim", ` · ${tally(store.live().length, items)}`),
                                width,
                                "…",
                                true,
                            );
                            // Always-on keys first, so the pane's own hints can spill off a narrow line.
                            const paneHints =
                                focus === "list"
                                    ? `${hint(["tui.select.up", "tui.select.down"], "select")} · ${hint("tui.select.confirm", "activity")}`
                                    : `${hint(["tui.altScreen.pageUp", "tui.altScreen.pageDown"], "page")} · ${hint("tui.altScreen.top", "top")} · ${hint("tui.altScreen.bottom", "bottom")}`;
                            const footer = truncateToWidth(
                                theme.fg(
                                    "dim",
                                    [
                                        rawKeyHint("←/→", "pane"),
                                        hint("app.tools.expand", "expand"),
                                        hint("tui.select.cancel", "close"),
                                        paneHints,
                                    ].join(" · "),
                                ),
                                width,
                                "…",
                                true,
                            );
                            const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
                            if (!selected)
                                return [
                                    title,
                                    theme.fg("muted", "No delegates in this session."),
                                    ...Array(Math.max(0, tui.terminal.rows - 4)).fill(" ".repeat(Math.max(0, width))),
                                    footer,
                                ].slice(0, tui.terminal.rows);
                            const sidebarWidth = Math.min(
                                40,
                                Math.max(16, Math.floor(width * 0.35)),
                                Math.max(1, width - 2),
                            );
                            const historyWidth = Math.max(1, width - sidebarWidth - 1);
                            lastSidebar = sidebarWidth;
                            // HStack measures a child at the full width first, so composing the panes here keeps one render per frame.
                            const left = renderJobs(sidebarWidth, items, selectedIndex);
                            const right = renderHistory(historyWidth, selected);
                            const body = left.map((line, index) => `${line} ${right[index] ?? ""}`);
                            return [title, rule, ...body, rule, footer].slice(0, tui.terminal.rows);
                        },
                        invalidate() {
                            for (const value of transcripts.values()) value.invalidate();
                        },
                        handleInput(data: string) {
                            if (keys.matches(data, "tui.select.cancel")) done(undefined);
                            else if (keys.matches(data, "app.tools.expand")) {
                                expanded = !expanded;
                                for (const value of transcripts.values()) value.invalidate();
                            } else if (matchesKey(data, "left")) focus = "list";
                            else if (
                                matchesKey(data, "right") ||
                                (focus === "list" && keys.matches(data, "tui.select.confirm"))
                            )
                                focus = "history";
                            else if (focus === "history" && keys.matches(data, "tui.altScreen.pageUp"))
                                scroll(-pageSize());
                            else if (focus === "history" && keys.matches(data, "tui.altScreen.pageDown"))
                                scroll(pageSize());
                            else if (focus === "history" && keys.matches(data, "tui.altScreen.top"))
                                top = lastWindow.total > lastWindow.height ? 0 : undefined;
                            else if (focus === "history" && keys.matches(data, "tui.altScreen.bottom")) top = undefined;
                            else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
                                const up = keys.matches(data, "tui.select.up");
                                if (focus === "list") selectJob(up ? -1 : 1);
                                else scroll(up ? -1 : 1);
                            }
                            tui.requestRender();
                        },
                        // Fullscreen turns on mouse tracking, so the wheel arrives here instead of as arrow keys.
                        handleMouse(event: TuiMouseEvent) {
                            if (event.x < lastSidebar && event.type === "wheel" && event.wheelDelta) {
                                selectJob(event.wheelDelta < 0 ? -1 : 1);
                            } else if (event.type === "wheel" && event.wheelDelta) {
                                scroll(event.wheelDelta);
                            } else if (event.type === "click" && event.button === "left" && event.x < lastSidebar) {
                                const items = jobs();
                                const target = items[lastJobsStart + Math.floor((event.y - 2) / 3)];
                                if (event.y < 2 || !target) return;
                                selectedId = target.id;
                                top = undefined;
                            } else return;
                            tui.requestRender();
                            return { handled: true };
                        },
                    };
                }, screen);
            } finally {
                stopRedraw?.();
            }
        },
    });
}

import { type ExtensionAPI, getMarkdownTheme, keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { HStack, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ChildActivity } from "./child.ts";
import { formatTools, jobIdentity, STATUS_COLORS, statusText, usageStats } from "./format.ts";
import type { InspectJob, JobStore } from "./store.ts";

/** The /delegate command: a full-screen inspector over the job store. */
export function registerInspector(pi: ExtensionAPI, store: JobStore) {
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
                    let historyWidth = 1;
                    let markdown = new WeakMap<ChildActivity, Markdown>();
                    const jobs = () => store.all();
                    // Fixed rows: title, top rule, bottom rule, footer.
                    const bodyHeight = () => Math.max(0, tui.terminal.rows - 4);
                    const toolsLines = (job: InspectJob, width: number) =>
                        wrapTextWithAnsi(formatTools(job.tools), Math.max(1, width)).map((line) =>
                            theme.fg("dim", line),
                        );
                    // Fixed rows: header, model, description, rule, counter.
                    const historyHeight = (job: InspectJob, width: number) =>
                        Math.max(0, bodyHeight() - 5 - toolsLines(job, width).length);
                    // ScrollView needs fullscreen layout; window the history in regular TUI too.
                    const renderJobs = (width: number, items: InspectJob[], selectedIndex: number): string[] => {
                        const row = (text: string) =>
                            truncateToWidth(text, Math.max(0, width - 1), "…", true) + theme.fg("borderMuted", "│");
                        const visible = Math.max(1, Math.floor((bodyHeight() - 1) / 3));
                        const start = Math.max(
                            0,
                            Math.min(selectedIndex - Math.floor(visible / 2), items.length - visible),
                        );
                        const lines = items
                            .slice(start, start + visible)
                            .flatMap((item, index) => [
                                row(
                                    `${theme.fg(start + index === selectedIndex && focus === "list" ? "accent" : "text", start + index === selectedIndex ? "›" : " ")} ${statusText(theme, item.status)} ${jobIdentity(theme, item)}`,
                                ),
                                row(theme.fg("muted", `    ${item.description}`)),
                                row(
                                    theme.fg(
                                        "muted",
                                        `    ${usageStats(item, (item.endedAt ?? Date.now()) - item.startedAt)}`,
                                    ),
                                ),
                            ]);
                        return [
                            ...lines,
                            ...Array(Math.max(0, bodyHeight() - 1 - lines.length)).fill(row("")),
                            row(theme.fg("dim", `${selectedIndex + 1}/${items.length}`)),
                        ].slice(0, bodyHeight());
                    };
                    const renderEntry = (entry: ChildActivity, width: number): string[] => {
                        if (entry.kind === "assistant" || entry.kind === "user") {
                            let md = markdown.get(entry);
                            if (!md) {
                                md = new Markdown(entry.text, 0, 0, getMarkdownTheme());
                                markdown.set(entry, md);
                            }
                            return [theme.fg("accent", entry.kind), ...md.render(width), ""];
                        }
                        if (entry.kind === "tool")
                            return [
                                truncateToWidth(
                                    theme.fg("toolTitle", entry.text) +
                                        (entry.detail ? ` ${theme.fg("accent", entry.detail)}` : ""),
                                    width,
                                ),
                            ];
                        if (entry.kind === "result") return [truncateToWidth(theme.fg("text", entry.text), width)];
                        // Only failure detail still says anything; the header icon carries the status.
                        if (!entry.text) return [];
                        return [truncateToWidth(theme.fg(STATUS_COLORS.failed, entry.text), width)];
                    };
                    const renderHistory = (width: number, job: InspectJob): string[] => {
                        historyWidth = width;
                        const tools = toolsLines(job, width);
                        const height = historyHeight(job, width);
                        const history = job.activity.flatMap((entry) => renderEntry(entry, width));
                        const maxTop = Math.max(0, history.length - height);
                        const start = Math.min(top ?? maxTop, maxTop);
                        const visible = history.slice(start, start + height);
                        const shown = visible.length
                            ? visible
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
                        return [
                            truncateToWidth(`${statusText(theme, job.status)} ${jobIdentity(theme, job)}`, width),
                            truncateToWidth(theme.fg("dim", job.model), width),
                            ...tools,
                            truncateToWidth(theme.fg("text", theme.bold(job.description)), width),
                            theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
                            ...shown,
                            ...Array(Math.max(0, height - shown.length)).fill(""),
                            truncateToWidth(
                                theme.fg(
                                    "dim",
                                    `${visible.length ? `${start + 1}–${start + visible.length}` : "0"}/${history.length}`,
                                ),
                                width,
                            ),
                        ].slice(0, bodyHeight());
                    };
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
                                    theme.fg("dim", ` · ${store.live().length} running · ${items.length} total`),
                                width,
                            );
                            const footer = truncateToWidth(
                                theme.fg(
                                    "dim",
                                    `${keyHint("tui.select.up", "up")} · ${keyHint("tui.select.down", "down")} · ${rawKeyHint("←/→", "switch pane")} · ${keyHint("tui.select.cancel", "close")}`,
                                ),
                                width,
                            );
                            if (!selected)
                                return [
                                    title,
                                    theme.fg("muted", "No delegates in this session."),
                                    // Fixed rows: title, top rule, bottom rule, footer.
                                    ...Array(Math.max(0, tui.terminal.rows - 4)).fill(""),
                                    footer,
                                ].slice(0, tui.terminal.rows);
                            const sidebarWidth = Math.min(
                                40,
                                Math.max(16, Math.floor(width * 0.35)),
                                Math.max(1, width - 2),
                            );
                            const body = new HStack(
                                [
                                    {
                                        component: {
                                            render: (w) => renderJobs(w, items, selectedIndex),
                                            invalidate() {},
                                        },
                                        basis: sidebarWidth,
                                        shrink: 0,
                                    },
                                    {
                                        component: { render: (w) => renderHistory(w, selected), invalidate() {} },
                                        basis: 0,
                                        grow: 1,
                                    },
                                ],
                                { gap: 1 },
                            ).render(width);
                            return [
                                title,
                                theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
                                ...body,
                                theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
                                footer,
                            ].slice(0, tui.terminal.rows);
                        },
                        invalidate() {
                            markdown = new WeakMap();
                        },
                        handleInput(data: string) {
                            if (keys.matches(data, "tui.select.cancel")) done(undefined);
                            else if (matchesKey(data, "left")) focus = "list";
                            else if (
                                matchesKey(data, "right") ||
                                (focus === "list" && keys.matches(data, "tui.select.confirm"))
                            )
                                focus = "history";
                            else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
                                const up = keys.matches(data, "tui.select.up");
                                const items = jobs();
                                if (focus === "list") {
                                    const index = Math.max(
                                        0,
                                        items.findIndex((item) => item.id === selectedId),
                                    );
                                    selectedId =
                                        items[Math.max(0, Math.min(items.length - 1, index + (up ? -1 : 1)))]?.id ??
                                        selectedId;
                                    top = undefined;
                                } else {
                                    const selected = items.find((item) => item.id === selectedId) ?? items[0];
                                    const length =
                                        selected?.activity.reduce(
                                            (sum, entry) => sum + renderEntry(entry, historyWidth).length,
                                            0,
                                        ) ?? 0;
                                    const maxTop = Math.max(
                                        0,
                                        length - (selected ? historyHeight(selected, historyWidth) : 0),
                                    );
                                    const position = Math.max(0, Math.min(maxTop, top ?? maxTop) + (up ? -1 : 1));
                                    top = position >= maxTop ? undefined : position;
                                }
                            }
                            tui.requestRender();
                        },
                    };
                }, screen);
            } finally {
                stopRedraw?.();
            }
        },
    });
}

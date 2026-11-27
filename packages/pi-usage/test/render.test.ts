import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, it } from "vitest";
import { displayName, fitLabel, hitPct, padWidth, ratePct, shareBar } from "../src/format.ts";
import { heatmap, summaryLines, summaryModel } from "../src/summary.ts";
import { dayKey, type DailyCost, type Stats, type UsageRecord } from "../src/usage.ts";

// getAgentDir() is read when the command runs, so the temp agent dir only has to be set before mounting.
const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-render-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// A flat custom session dir: no per-project subdirectories, as with --session-dir.
const sessionDir = mkdtempSync(join(tmpdir(), "pi-usage-render-sessions-"));

initTheme("dark");

const { default: extension } = await import("../index.ts");

/** Colour stubs keep the frames readable; they never change a line's visible width. */
const theme: any = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
};

function sessionHeader(id: string, cwd: string): string {
    return JSON.stringify({ type: "session", version: 3, id, cwd });
}

/** Every message calls `bash` and reads one skill, so the tool and skill lists have data. */
const skillPath = "/home/deathbeam/.agents/skills/codebase-design/SKILL.md";

function messageLine(provider: string, model: string, ts: number, cost: number, tokens: number): string {
    return JSON.stringify({
        type: "message",
        message: {
            role: "assistant",
            provider,
            model,
            timestamp: ts,
            content: [
                { type: "toolCall", id: `call-${ts}`, name: "bash", arguments: { command: "ls" } },
                { type: "toolCall", id: `read-${ts}`, name: "read", arguments: { path: skillPath } },
            ],
            usage: {
                input: tokens,
                output: Math.round(tokens / 10),
                cacheRead: Math.round(tokens / 2),
                cacheWrite: Math.round(tokens / 20),
                cost: { total: cost },
            },
        },
    });
}

/** Realistic corpus: many days, providers, models and projects, one very long model and a wide-char path. */
function writeSessions(): void {
    const dir = sessionDir;
    const projects = ["/home/deathbeam/git/pi-packages", "/tmp/日本語のプロジェクト", "/tmp/x"];
    const providers = ["anthropic", "openai", "google-gemini-cli"];
    const models = ["claude-opus-4-5-very-long-model-identifier", "gpt-5.1", "gemini-3-pro"];
    for (const [p, cwd] of projects.entries()) {
        const lines = [sessionHeader(`s${p}`, cwd)];
        for (let day = 0; day < 60; day++) {
            const ts = Date.now() - day * 86_400_000;
            lines.push(messageLine(providers[day % 3]!, models[day % 3]!, ts, 0.5 * day + 0.004, day * 1_000));
            lines.push(messageLine(providers[(day + 1) % 3]!, models[(day + 1) % 3]!, ts, day === 0 ? 1200 : 0.1, 500));
        }
        writeFileSync(join(dir, `s${p}.jsonl`), lines.join("\n"));
    }
}

type View = { render(width: number): string[]; handleInput(data: string): void; handleMouse(event: any): any };

function mount(
    sessionDirOverride: string = sessionDir,
    rows = 24,
    bindings: Record<string, string> = {},
    paint: any = theme,
): View {
    let view: View | undefined;
    let command: any;
    extension({ registerCommand: (_name: string, registered: any) => (command = registered) } as any);
    const keys = { matches: (data: string, name: string) => bindings[data] === name };
    const tui = { terminal: { rows }, requestRender() {} };
    const ui = {
        theme,
        custom(factory: any) {
            view = factory(tui, paint, keys, () => {});
            return new Promise(() => {}); // stays open: the harness drives render directly
        },
    };
    const ctx = {
        mode: "tui",
        sessionManager: { getSessionDir: () => sessionDirOverride },
        ui,
    };
    void command.handler("", ctx);
    assert.ok(view, "custom factory mounted a component");
    return view!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The scan is async, so render until the component leaves the "Scanning" splash. */
async function loaded(view: View): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
        const lines = view.render(100);
        if (!lines.some((line) => line.includes("Scanning"))) return;
        await sleep(10);
    }
    throw new Error("usage scan did not finish");
}

function assertFits(view: View, width: number): void {
    const lines = view.render(width);
    assert.ok(lines.length <= 24, `width ${width}: rendered more lines than the terminal has`);
    for (const [i, line] of lines.entries()) {
        const actual = visibleWidth(line);
        assert.ok(actual <= width, `width ${width}: line ${i} is ${actual} wide: ${JSON.stringify(line)}`);
    }
}

beforeAll(() => writeSessions());

afterAll(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
});

describe("usage dashboard render", () => {
    it("keeps every line inside the width from 1 to 200", async () => {
        const view = mount();
        await loaded(view);
        const lines = view.render(80);
        assert.ok(!lines.some((line) => line.includes("No usage")), "the custom session dir was scanned");
        for (let width = 1; width <= 200; width++) assertFits(view, width);
    });

    it("survives a shrink and grow sequence between frames", async () => {
        const view = mount();
        await loaded(view);
        const widths = [200, 120, 80, 40, 20, 10, 5, 3, 2, 1, 1, 2, 5, 10, 20, 40, 80, 120, 200];
        for (const width of widths) assertFits(view, width);
    });

    it("opens on the summary view and renders every section", async () => {
        const tall = mount(sessionDir, 80);
        await loaded(tall);
        for (const width of [40, 60, 80, 100, 160]) {
            const lines = tall.render(width);
            for (const [i, line] of lines.entries())
                assert.ok(visibleWidth(line) <= width, `width ${width}: line ${i} is ${visibleWidth(line)} wide`);
            const text = lines.join("\n");
            for (const part of [
                "[Summary]",
                "Total",
                "Delegates",
                "Trends",
                "Projected",
                "Streaks",
                "Activity",
                "Models",
                "Providers",
                "Projects",
                "Sessions",
                "Tools",
                "Skills",
            ])
                assert.ok(text.includes(part), `width ${width}: missing ${part}`);
        }
        const view = mount();
        await loaded(view);
        for (const width of [40, 60, 100, 160]) assertFits(view, width);
        // Enter does nothing on a view without rows, and the tab bar keeps Summary selected.
        view.handleInput("\r");
        assert.ok(view.render(100)[0]!.includes("[Summary]"));
    });

    it("keeps the active tab visible on a narrow terminal", async () => {
        const view = mount(sessionDir, 80, KEYS);
        await loaded(view);
        for (let tab = 0; tab < 5; tab++) {
            for (const width of [40, 50, 60])
                assert.ok(activeTab(view.render(width)) !== undefined, `width ${width}: active tab is on screen`);
            view.handleInput("\t");
        }
    });

    it("advertises only the keys the current view uses", async () => {
        const view = mount(sessionDir, 24, KEYS);
        await loaded(view);
        const summary = view.render(100).at(-1)!;
        assert.ok(!summary.includes("enter open") && !summary.includes("[ ] day"), summary);
        view.handleInput("\t");
        assert.ok(view.render(100).at(-1)!.includes("enter open"));
    });

    it("scrolls with the mouse wheel", async () => {
        const paint = { ...theme, bg: (color: string, text: string) => (color === "selectedBg" ? `[${text}]` : text) };
        const view = mount(sessionDir, 24, KEYS, paint);
        await loaded(view);
        view.handleInput("\t"); // the Day view
        const selected = () => view.render(100).find((line) => line.startsWith("[") && line.endsWith("]"));
        const first = selected();
        assert.ok(first, "no selected row");
        const wheel = (wheelDelta: number) =>
            view.handleMouse({
                type: "wheel",
                button: "none",
                x: 10,
                y: 10,
                screenX: 10,
                screenY: 10,
                width: 100,
                height: 24,
                shift: false,
                alt: false,
                ctrl: false,
                wheelDelta,
            });
        assert.ok(wheel(1), "the wheel was not handled");
        assert.notEqual(selected(), first, "the wheel did not move the selection");
        wheel(-100);
        assert.equal(selected(), first, "the wheel did not scroll back to the top");
    });

    it("counts every project when getSessionDir returns a single project dir", async () => {
        // getSessionDir() returns <root>/--proj-a-- under the default layout; the scan must cover its parent.
        const root = mkdtempSync(join(tmpdir(), "pi-usage-render-projects-"));
        try {
            for (const [project, cost] of [
                ["--proj-a--", 0.5],
                ["--proj-b--", 0.25],
            ] as const) {
                mkdirSync(join(root, project));
                writeFileSync(
                    join(root, project, "s.jsonl"),
                    [
                        sessionHeader(project, `/tmp/${project}`),
                        messageLine("anthropic", "claude-opus-4-5", Date.now(), cost, 1000),
                    ].join("\n"),
                );
            }
            const view = mount(join(root, "--proj-a--"));
            await loaded(view);
            const total = view.render(100).find((line) => line.includes("Total"));
            assert.ok(total?.includes("$0.75"), `proj-b usage is counted: ${total}`);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

const KEYS: Record<string, string> = {
    "\r": "tui.select.confirm",
    "\x1b": "tui.select.cancel",
    "\x1b[A": "tui.select.up",
    "\x1b[B": "tui.select.down",
};

function activeTab(lines: string[]): string | undefined {
    return lines[0]?.match(/\[(\w+)\]/)?.[1];
}

/** First table row: the first line below the summary that carries a cost. */
function firstRow(lines: string[]): string {
    const row = lines.find((line) => !line.startsWith("Cost ") && /^\S.*\$\d/.test(line));
    assert.ok(row, `no table row in:\n${lines.join("\n")}`);
    return row;
}

describe("usage dashboard drill-down", () => {
    it("opens the selected day in the next grouping instead of an empty day view", async () => {
        const view = mount(sessionDir, 80, KEYS);
        await loaded(view);
        view.handleInput("\t");
        const days = view.render(100);
        assert.equal(activeTab(days), "Day");
        const cost = firstRow(days).match(/\$[\d,.]+/)![0];
        assert.notEqual(cost, "$0.00", "the busiest day is on top");
        view.handleInput("\r");
        const drilled = view.render(100);
        assert.equal(activeTab(drilled), "Provider");
        const text = drilled.join("\n");
        assert.ok(!text.includes("No usage"), `drill-down has rows:\n${text}`);
        assert.ok(text.includes(`Cost ${cost} ·`), "the drilled view totals the selected day");
        assert.ok(text.includes("openai"), "the drilled view lists the day's providers");
    });

    it("keeps rows when drilling from every table view", async () => {
        for (const tabs of [2, 3, 4]) {
            const view = mount(sessionDir, 80, KEYS);
            await loaded(view);
            for (let i = 0; i < tabs; i++) view.handleInput("\t");
            const before = view.render(100);
            const tab = activeTab(before);
            const cost = firstRow(before).match(/\$[\d,.]+/)![0];
            view.handleInput("\r");
            const after = view.render(100);
            assert.notEqual(activeTab(after), tab, `a drill-down changes the grouping from ${tab}`);
            const text = after.join("\n");
            assert.ok(!text.includes("No usage"), `${tab} drill-down keeps rows:\n${text}`);
            assert.ok(text.includes(`Cost ${cost} `), `${tab} drill-down totals ${cost}`);
        }
    });
});

describe("fault rates", () => {
    it("shows the share of the base and colors a high one", () => {
        const seen: [string, string][] = [];
        const recorder: any = {
            fg: (color: string, text: string) => {
                seen.push([color, text]);
                return text;
            },
        };
        assert.deepEqual(
            [ratePct(0, 100, recorder), ratePct(3, 100, recorder), ratePct(6, 100, recorder)],
            ["0%", "3%", "6%"],
        );
        assert.deepEqual(seen, [
            ["success", "0%"],
            ["warning", "3%"],
            ["error", "6%"],
        ]);
        assert.equal(ratePct(3, 0, recorder), "-");
        assert.equal(seen.length, 3, "no base stays uncolored");
    });
});

describe("failure rate columns", () => {
    /** One day: four requests, one aborted and one failed, and three tool calls with one failure. */
    function faultsDir(): string {
        const dir = mkdtempSync(join(tmpdir(), "pi-usage-render-faults-"));
        const assistant = (stopReason: string, offset: number) =>
            JSON.stringify({
                type: "message",
                message: {
                    role: "assistant",
                    provider: "anthropic",
                    model: "claude",
                    timestamp: Date.now() + offset,
                    stopReason,
                    content: [{ type: "toolCall", id: `call-${offset}`, name: "bash", arguments: { command: "ls" } }],
                    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
                },
            });
        writeFileSync(
            join(dir, "s.jsonl"),
            [
                sessionHeader("f1", "/tmp/faults"),
                assistant("toolUse", 1),
                assistant("aborted", 2),
                assistant("error", 3),
                assistant("toolUse", 4),
                JSON.stringify({
                    type: "message",
                    message: {
                        role: "toolResult",
                        toolName: "bash",
                        isError: true,
                        timestamp: Date.now(),
                        content: [],
                    },
                }),
            ].join("\n"),
        );
        return dir;
    }

    it("shows the abort, API error and tool failure shares with one decimal", async () => {
        const dir = faultsDir();
        try {
            const seen: [string, string][] = [];
            const paint: any = {
                ...theme,
                fg: (color: string, text: string) => {
                    seen.push([color, text]);
                    return text;
                },
            };
            const view = mount(dir, 80, KEYS, paint);
            await loaded(view);
            view.handleInput("\t"); // the Day view
            const row = view.render(200).find((line) => line.includes("25.0%"))!;
            assert.ok(row, "the day row carries the rates");
            // One abort and one API error of four requests; the aborted call never ran, so one of three.
            assert.equal(row.match(/25\.0%/g)?.length, 2, row);
            assert.ok(row.includes("33.3%"), row);
            for (const text of ["25.0%", "33.3%"])
                assert.ok(
                    seen.some(([color, value]) => color === "error" && value === text),
                    `${text} is red`,
                );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("drops the three failure columns first on a narrow terminal", async () => {
        const dir = faultsDir();
        try {
            const view = mount(dir, 80, KEYS);
            await loaded(view);
            view.handleInput("\t"); // the Day view
            const header = (width: number) => view.render(width).find((line) => line.startsWith("Day"))!;
            const wide = header(200);
            for (const label of ["Abort%", "Err%", "Tool%"]) assert.ok(wide.includes(label), wide);
            const narrow = header(70);
            for (const label of ["Abort%", "Err%", "Tool%"]) assert.ok(!narrow.includes(label), narrow);
            assert.ok(narrow.includes("Hit%"), `the cheaper columns survive: ${narrow}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("summary layout", () => {
    const now = new Date(2025, 4, 21, 12).getTime(); // Wednesday 2025-05-21
    function record(ts: number, cost: number): UsageRecord {
        return {
            provider: "anthropic",
            model: "claude-opus-4-5",
            ts,
            cost,
            input: 1000,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            cwd: "/home/deathbeam/git/pi-packages",
            sessionId: "01a05b",
            requests: 1,
            aborts: 0,
            apiErrors: 0,
            tools: {},
            toolErrors: 0,
            skills: {},
        };
    }
    // Four days, so the heatmap has one cell per level and 2025-05-21 is the busiest.
    const records = [0, 1, 2, 3].map((offset) => record(now - offset * 86_400_000, 5 - offset));

    it("lays the KPI blocks into cost, request, token and error columns under their headers", () => {
        const lines = summaryLines(summaryModel(records, true, now), 100, theme);
        const header = lines[0]!;
        for (const title of ["Cost", "Requests", "Tokens", "Errors"]) assert.ok(header.includes(title), header);
        assert.ok(lines[1]!.includes("Total") && lines[1]!.includes("Reqs") && lines[1]!.includes("In"));
        assert.ok(lines[1]!.includes("Aborted"), lines[1]);
        // Each value starts under its own header, one indent in.
        assert.equal(lines[1]!.indexOf("Reqs"), header.indexOf("Requests") + 2);
        assert.equal(lines[1]!.indexOf("In"), header.indexOf("Tokens") + 2);
        assert.equal(lines[1]!.indexOf("Aborted"), header.indexOf("Errors") + 2);
        assert.ok(lines[2]!.includes("Per day") && lines[2]!.includes("Sessions") && lines[2]!.includes("Out"));
        assert.ok(lines[3]!.includes("Per session") && lines[3]!.includes("Cache R"));
        assert.ok(lines[5]!.includes("Hit"));
        assert.equal(new Set(lines.slice(1, 4).map((line) => line.indexOf("$"))).size, 1, "cost values line up");
        // The four blocks do not fit in 40, so they wrap and drop the Errors block.
        const narrow = summaryLines(summaryModel(records, true, now), 40, theme);
        for (const label of [
            "Total",
            "Per day",
            "Per session",
            "Reqs",
            "Sessions",
            "Active days",
            "Out",
            "Cache R",
            "Cache W",
            "Hit",
        ])
            assert.ok(
                narrow.some((line) => line.includes(label)),
                `narrow KPI keeps ${label}`,
            );
    });

    it("drops the trend comparison suffix when it does not fit", () => {
        const model = summaryModel(records, true, now);
        assert.ok(summaryLines(model, 100, theme).some((line) => line.includes("vs last week")));
        const narrow = summaryLines(model, 40, theme).join("\n");
        assert.ok(!narrow.includes("vs last week") && !narrow.includes("las…"), narrow);
    });

    it("puts trends and streaks on one row when wide and stacks them when narrow", () => {
        const model = summaryModel(records, true, now);
        const wide = summaryLines(model, 100, theme).find((line) => line.includes("Trends"))!;
        assert.ok(wide.includes("Streaks"), `wide: ${wide}`);
        const narrow = summaryLines(model, 60, theme);
        assert.ok(narrow.some((line) => line.includes("Trends")));
        assert.ok(narrow.some((line) => line.includes("Streaks")));
        assert.ok(
            !narrow.some((line) => line.includes("Trends") && line.includes("Streaks")),
            "narrow terminals stack the two sections",
        );
    });

    it("labels the busiest day with its short date and weekday", () => {
        const text = summaryLines(summaryModel(records, false, now), 100, theme).join("\n");
        assert.ok(text.includes("05-21 Wed"), text);
    });

    it("prefixes each session with its start date", () => {
        const text = summaryLines(summaryModel(records, false, now), 100, theme).join("\n");
        assert.ok(text.includes("05-18 01a05b pi-packages"), text);
    });

    it("projects the month and splits the delegate cost out of the totals", () => {
        const delegates = [...records, { ...record(now, 5), sessionId: "delegate-cee55d71" }];
        const text = summaryLines(summaryModel(delegates, true, now), 100, theme).join("\n");
        assert.ok(text.includes("Delegates") && text.includes("26%"), text); // 5 of 19 dollars
        assert.ok(text.includes("Projected") && text.includes("$"), text);
        const narrow = summaryLines(summaryModel(records, true, now), 24, theme).find((line) =>
            line.includes("Projected"),
        );
        assert.ok(narrow?.includes("$"), `projection row at 24: ${narrow}`);
        assert.ok(!narrow?.includes("last month"), `no room for the wording at 24: ${narrow}`);
        assert.ok(
            !summaryLines(summaryModel(records, false, now), 100, theme)
                .join("\n")
                .includes("Projected"),
        );
    });

    it("pairs models with providers and projects with sessions when wide", () => {
        const model = summaryModel(records, false, now);
        const rows = summaryLines(model, 120, theme);
        assert.ok(
            rows.some((line) => line.includes("Models") && line.includes("Providers")),
            rows.join("\n"),
        );
        assert.ok(
            rows.some((line) => line.includes("Projects") && line.includes("Sessions")),
            rows.join("\n"),
        );
        const narrow = summaryLines(model, 60, theme);
        for (const title of ["Models", "Providers", "Projects", "Sessions"])
            assert.ok(
                narrow.some((line) => line.trim() === title),
                `narrow keeps ${title} on its own row`,
            );
    });

    it("ranks tools and skills by call count next to each other", () => {
        const called = records.map((record, index) => ({
            ...record,
            tools: { bash: 100 - index * 10, read: 20, edit: 5 },
            skills: { "codebase-design": 3, ponytail: 1 },
        }));
        const model = summaryModel(called, false, now);
        assert.deepEqual(
            model.top.tools.map((row) => [row.name, row.requests]),
            [
                ["bash", 340],
                ["read", 80],
                ["edit", 20],
            ],
        );
        assert.equal(model.top.toolCalls, 440);
        assert.deepEqual(
            model.top.skills.map((row) => [row.name, row.requests]),
            [
                ["codebase-design", 12],
                ["ponytail", 4],
            ],
        );
        for (const width of [40, 60, 100]) {
            const lines = summaryLines(model, width, theme);
            for (const [i, line] of lines.entries())
                assert.ok(visibleWidth(line) <= width, `width ${width}: line ${i} is ${visibleWidth(line)} wide`);
            const text = lines.join("\n");
            for (const part of ["Tools", "Skills", "bash", "codebase"])
                assert.ok(text.includes(part), `width ${width}: missing ${part}`);
        }
        const wide = summaryLines(model, 120, theme);
        assert.ok(
            wide.some((line) => line.includes("Tools") && line.includes("Skills")),
            wide.join("\n"),
        );
        const bash = wide.find((line) => line.includes("bash"))!;
        assert.ok(bash.includes("77%") && bash.includes(" 340 "), `share of calls and count: ${bash}`);
    });

    it("puts the period total before the per-day average", () => {
        const week = summaryLines(summaryModel(records, true, now), 100, theme).find((line) =>
            line.includes("This week"),
        )!;
        assert.ok(week.indexOf("$12.00") < week.indexOf("/day"), week); // $12 spent, $4.00 per day
        assert.ok(week.indexOf("/day") < Math.max(week.indexOf("▲"), week.indexOf("▼")), week);
        assert.ok(week.includes("vs last week"), week);
    });

    it("aligns the trend labels, totals, averages and changes", () => {
        const rows = summaryLines(summaryModel(records, true, now), 100, theme).filter((line) =>
            ["Today", "This week", "This month", "Projected"].some((label) => line.trim().startsWith(label)),
        );
        assert.equal(rows.length, 4, rows.join("\n"));
        assert.equal(new Set(rows.map((line) => line.indexOf("$"))).size, 1, "the totals share a column");
        const averaged = rows.filter((line) => line.includes("/day"));
        assert.equal(new Set(averaged.map((line) => line.indexOf("/day"))).size, 1, "the averages share a column");
        const deltas = averaged.map((line) => Math.max(line.indexOf("▲"), line.indexOf("▼")));
        assert.equal(new Set(deltas).size, 1, `the changes share a column: ${averaged.join("\n")}`);
    });

    it("compares the projection with last month's total", () => {
        const april = [...records, record(new Date(2025, 3, 15, 12).getTime(), 8)];
        const line = summaryLines(summaryModel(april, true, now), 100, theme).find((row) => row.includes("Projected"))!;
        assert.ok(line.includes("vs $8.00 last month"), line);
        assert.ok(!line.includes("%"), "the per-day change already carries the percentage");
    });

    it("keeps side-by-side blocks at their content width on a wide terminal", () => {
        // Narrow enough for the pairs, so this reads on the two-block rule the content widths come from.
        const wide = summaryLines(summaryModel(records, false, now), 120, theme);
        const streaks = wide.find((line) => line.includes("Streaks"))!;
        assert.ok(streaks.indexOf("Streaks") < 80, `streaks at ${streaks.indexOf("Streaks")}: ${streaks}`);
        const providers = wide.find((line) => line.includes("Providers"))!;
        const sessions = wide.find((line) => line.includes("Projects") && line.includes("Sessions"))!;
        assert.ok(providers.indexOf("Providers") < 80, `providers at ${providers.indexOf("Providers")}`);
        assert.equal(providers.indexOf("Providers"), sessions.indexOf("Sessions"), "the pairs share a column");
    });

    it("stacks the top lists on a narrow terminal so names stay readable", async () => {
        const view = mount(sessionDir, 80);
        await loaded(view);
        const text = view.render(60).join("\n");
        assert.ok(text.includes("gemini-3-pro"), `model names are cut:\n${text}`);
        assert.ok(text.includes("日本語のプロジェクト"), `project names are cut:\n${text}`);
    });

    it("draws one glyph and hue per heat level", () => {
        const seen: [string, string][] = [];
        const recorder: any = {
            fg: (color: string, text: string) => {
                seen.push([color, text]);
                return text;
            },
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
        };
        // Over a max of 400 the spread lands on levels 1, 1, 3 and 4.
        const spread = [0.01, 1, 20, 400].map((cost, offset) => record(now - offset * 86_400_000, cost));
        const lines = summaryLines(summaryModel(spread, false, now), 100, recorder);
        assert.deepEqual(
            seen.filter(([, text]) => ["·", "▪", "■"].includes(text)),
            [
                ["borderMuted", "·"],
                ["muted", "▪"],
                ["text", "■"],
                ["warning", "■"],
                ["error", "■"],
            ],
            "the legend lists every level in its own hue",
        );
        const cells = new Set(seen.map(([, text]) => text).filter((text) => text === "▪ " || text === "■ "));
        assert.deepEqual([...cells].sort(), ["■ ", "▪ "], "active cells carry the level glyph");
        const activity = lines.slice(lines.findIndex((line) => line.includes("Activity")));
        assert.ok(activity.some((line) => line.includes("less") && line.includes("more")));
    });

    it("lists the failure rates in their own Errors block", () => {
        const fault = (row: UsageRecord) => ({
            ...row,
            requests: 100,
            aborts: 25,
            apiErrors: 1,
            tools: { edit: 200 },
            toolErrors: 4,
        });
        const seen: [string, string][] = [];
        const recorder: any = {
            fg: (color: string, text: string) => {
                seen.push([color, text]);
                return text;
            },
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
        };
        const rows = summaryLines(summaryModel(records.map(fault), false, now), 120, recorder);
        const header = rows[0]!;
        // 100 of 400 requests aborted, 4 of 400 failed, 16 of 800 tool calls failed.
        const [aborted, apiErrors, toolErrors] = [1, 2, 3].map((step) => rows[step]!);
        assert.ok(aborted.includes("Aborted") && aborted.includes("25.0%") && aborted.includes("100"), aborted);
        assert.equal(aborted.indexOf("Aborted"), header.indexOf("Errors") + 2, "the block starts under its header");
        assert.ok(apiErrors.includes(" API ") && apiErrors.includes("1.0%") && apiErrors.includes("4"), apiErrors);
        assert.ok(toolErrors.includes(" Tool ") && toolErrors.includes("2.0%"), toolErrors);
        assert.ok(toolErrors.includes("16"), toolErrors);
        // The other blocks keep their own height and content.
        assert.ok(rows[4]!.includes("Delegates") && rows[4]!.includes("Cache W"), rows[4]);
        assert.ok(rows[5]!.includes("Hit"), rows[5]);
        // The rate carries the colour; the count behind it is the muted second value.
        assert.ok(
            seen.some(([color, text]) => color === "error" && text === "25.0%"),
            "a rate at 5% and up is red",
        );
        assert.ok(
            seen.some(([color, text]) => color === "muted" && text === "100"),
            "the count is muted",
        );
    });

    it("drops a failure cell without a base, and the Errors block without any", () => {
        // No requests, so Aborted and API vanish and Tool takes the first row.
        const callsOnly = records.map((row) => ({ ...row, requests: 0, tools: { bash: 10 }, toolErrors: 2 }));
        const rows = summaryLines(summaryModel(callsOnly, false, now), 100, theme);
        const header = rows[0]!;
        assert.ok(header.includes("Errors"), header);
        assert.equal(rows[1]!.indexOf("Tool"), header.indexOf("Errors") + 2, "the cell keeps its column");
        assert.ok(!rows.some((row) => row.includes("Aborted") || /\bAPI\b/.test(row)), rows.join("\n"));
        assert.ok(rows.some((row) => row.includes("Hit")) && rows.some((row) => row.includes("Reqs")));
        // Nothing at all when every base is empty.
        const empty = summaryLines(summaryModel([], false, now), 100, theme);
        assert.ok(!empty.some((row) => row.includes("Errors") || /\bTool\b/.test(row)), empty.join("\n"));
    });

    it("drops the whole Errors block when the four blocks do not fit", () => {
        const fault = (row: UsageRecord) => ({ ...row, requests: 100, aborts: 25, toolErrors: 1 });
        const faulty = records.map(fault);
        const wide = summaryLines(summaryModel(faulty, false, now), 120, theme);
        assert.ok(wide[0]!.includes("Errors") && wide.some((row) => row.includes("Aborted")), "four blocks fit here");
        for (const width of [40, 70]) {
            const narrow = summaryLines(summaryModel(faulty, false, now), width, theme);
            assert.ok(!narrow.some((row) => row.includes("Errors") || row.includes("Aborted")), narrow.join("\n"));
            assert.ok(narrow[0]!.includes("Cost"), narrow[0]);
        }
    });

    it("puts three ranking blocks in a row while they fit, and pairs below that", () => {
        const called = records.map((row) => ({ ...row, tools: { bash: 3, read: 2 }, skills: { ponytail: 1 } }));
        const model = summaryModel(called, false, now);
        const wide = summaryLines(model, 200, theme);
        assert.ok(
            wide.some((line) => line.includes("Models") && line.includes("Providers") && line.includes("Projects")),
            wide.join("\n"),
        );
        assert.ok(
            wide.some((line) => line.includes("Sessions") && line.includes("Tools") && line.includes("Skills")),
            wide.join("\n"),
        );
        const narrow = summaryLines(model, 120, theme);
        assert.ok(
            narrow.some((line) => line.includes("Models") && line.includes("Providers") && !line.includes("Projects")),
            narrow.join("\n"),
        );
        assert.ok(
            narrow.some((line) => line.includes("Projects") && line.includes("Sessions") && !line.includes("Tools")),
            narrow.join("\n"),
        );
    });

    it("drops a month label that would sit one space from the next one", () => {
        // The history starts on the last day of April, so an April label would touch May's.
        const end = new Date(2026, 5, 10, 12).getTime();
        const daily: DailyCost[] = Array.from({ length: 42 }, (_, i) => ({
            label: dayKey(end - (41 - i) * 86_400_000),
            cost: i % 4 === 0 ? 1 : 0,
        }));
        assert.equal(heatmap(daily, 53, end).header, "      May     Jun");
    });
});

describe("share bars", () => {
    it("keeps tiny shares empty and fills the bar for large ones", () => {
        assert.equal(shareBar(0, 10, theme), "────────   0%");
        assert.equal(shareBar(1, 1000, theme), "────────   0%");
        assert.equal(shareBar(1, 32, theme), "╸───────   3%");
        assert.equal(shareBar(3, 32, theme), "━───────   9%");
        assert.equal(shareBar(10, 10, theme), "━━━━━━━━ 100%");
        for (const [cost, total] of [
            [0, 10],
            [1, 32],
            [10, 10],
        ] as const)
            assert.equal(visibleWidth(shareBar(cost, total, theme)), 13);
    });
});

describe("cache hit rate", () => {
    it("colors the rate by how much of the input the cache carried", () => {
        const seen: [string, string][] = [];
        const recorder: any = {
            fg: (color: string, text: string) => {
                seen.push([color, text]);
                return text;
            },
        };
        const stats = (cacheRead: number): Stats => ({
            cost: 0,
            input: 100 - cacheRead,
            output: 0,
            cacheRead,
            cacheWrite: 0,
            aborts: 0,
            apiErrors: 0,
            tools: {},
            toolErrors: 0,
        });
        assert.deepEqual(
            [99, 90, 89, 75, 74].map((pct) => hitPct(stats(pct), recorder)),
            ["99%", "90%", "89%", "75%", "74%"],
        );
        assert.deepEqual(seen, [
            ["success", "99%"],
            ["success", "90%"],
            ["warning", "89%"],
            ["warning", "75%"],
            ["error", "74%"],
        ]);
        assert.equal(
            hitPct(
                {
                    cost: 0,
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    aborts: 0,
                    apiErrors: 0,
                    tools: {},
                    toolErrors: 0,
                },
                recorder,
            ),
            "-",
        );
        assert.equal(seen.length, 5, "no data stays uncolored");
    });
});

describe("day table", () => {
    const accent = (text: string) => `\x1b[36m${text}\x1b[39m`;
    const painted: any = { ...theme, fg: (color: string, text: string) => (color === "accent" ? accent(text) : text) };

    it("colors only the weekday suffix of a weekend row", async () => {
        const view = mount(sessionDir, 80, KEYS, painted);
        await loaded(view);
        view.handleInput("\t"); // the Day view
        const rows = view.render(200);
        const weekend = rows.find((line) => /^\d{4}-\d{2}-\d{2} \x1b\[36m(?:Sat|Sun)\x1b\[39m/.test(line));
        assert.ok(weekend, "the day table colors weekend names");
        assert.ok(
            rows.some((line) => /^\d{4}-\d{2}-\d{2} (?:Mon|Tue|Wed|Thu|Fri) /.test(line)),
            "weekdays stay plain",
        );
        assert.ok(visibleWidth(weekend!) <= 200, "the escapes do not break the row width");
    });

    it("keeps the colored day name the same width", () => {
        const name = displayName("day", "2026-11-15", painted);
        assert.equal(name, "2026-11-15 \x1b[36mSun\x1b[39m");
        assert.equal(visibleWidth(name), 14);
        assert.equal(visibleWidth(fitLabel(name, 10)), 10);
        assert.equal(visibleWidth(padWidth(name, 20)), 20);
    });
});

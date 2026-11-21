import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { SPINNER_INTERVAL_MS } from "../src/format.ts";
import {
    agentDir,
    baseCtx,
    cleanup,
    fakePi,
    keyHint,
    overlayHarness,
    registerExtension,
    sessionDir,
    spawnedChildren,
    themeStub,
    withTimeout,
} from "./helpers.ts";

vi.setConfig({ testTimeout: 60000 });

const { theme, colored } = themeStub();
const guidance = "Parent guidance\n\nKeep both paragraphs.";
const longTask =
    "Trace delegates and collect their activity across the workspace.\nReport a detailed note after every step, including all found paths and why they matter. Finish with a final regression signal.";
const argv = process.argv;
let pi: ReturnType<typeof fakePi>;

beforeAll(() => {
    pi = fakePi();
});

afterAll(() => {
    process.argv = argv;
    pi.remove();
    cleanup();
});

/**
 * A fresh extension instance plus a TUI: its own job store, saved entries and report queue, so tests start clean.
 * Every test cancels the jobs it leaves running.
 */
function tuiSession() {
    const app = registerExtension();
    const screen = overlayHarness(theme);
    return {
        ...app,
        ...screen,
        delegate: app.tool("delegate"),
        steer: app.tool("delegate_steer"),
        list: app.tool("delegate_list"),
        cancel: app.tool("delegate_cancel"),
        tuiCtx: { ...baseCtx, mode: "tui", hasUI: true, ui: screen.ui },
    };
}

type TuiSession = ReturnType<typeof tuiSession>;

async function startJob(app: TuiSession, description = "a run", task = "trace it"): Promise<any> {
    return app.delegate.execute("call", { agent: "explore", description, task }, undefined, () => {}, app.tuiCtx);
}

async function steerJob(app: TuiSession, job: any, message = guidance): Promise<any> {
    return app.steer.execute("call", { id: job.details.id, message });
}

async function findSpawn(sessionId: string): Promise<string[] | undefined> {
    for (let i = 0; i < 300; i++) {
        const spawn = spawnedChildren(pi.dir).find((args) => args.includes(sessionId));
        if (spawn) return spawn;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
}

async function cancelJob(app: TuiSession, job: any): Promise<void> {
    await app.cancel.execute("call", { id: job.details.id }, undefined, () => {}, app.tuiCtx);
}

/** Two steers settle the fake child; returns the report the extension sent to pi. */
async function finishJob(app: TuiSession, job: any, finalMessage = "second"): Promise<any> {
    const report = app.nextMessage();
    await steerJob(app, job, guidance);
    await steerJob(app, job, finalMessage);
    return withTimeout(report);
}

function reportCard(app: TuiSession, entry: any): string {
    return app.renderReport(entry.message, { expanded: false }, theme).render(120).join("\n");
}

describe("launch", () => {
    it("starts the job in the background and renders its widget row", async () => {
        const app = tuiSession();
        const job = await startJob(app, "first run");
        assert.equal(job.details.background, true);
        assert.match(job.content[0].text, /no-op bash commands.*end your turn/);
        assert.match(app.state.widgetLines.join("\n"), /1 running · 1 total/);
        assert.match(app.state.widgetLines.join("\n"), new RegExp(`${job.details.id} explore first run`));
        // The launch entry is written at spawn, before the job produces any output.
        assert.ok(
            app.savedEntries.some((entry) => entry.data?.id === job.details.id && entry.data?.status === "running"),
            "launch entry missing",
        );
        const card = app.delegate.renderResult(job, { expanded: false }, theme, { isError: false, keyHint });
        assert.match(card.render(120).join("\n"), new RegExp(`${job.details.id} explore started in background`));
        assert.match(card.render(120).join("\n"), /✓/, "background launch missing its call-success mark");
        await cancelJob(app, job);
    });

    it("renders the launch and steer cards without repeating the text", async () => {
        const app = tuiSession();
        const job = await startJob(app, "first run");
        const launch = app.delegate
            .renderCall({ agent: "explore", description: "first run", task: "trace it" }, theme, {
                expanded: true,
                keyHint,
            })
            .render(120)
            .join("\n");
        const launchResult = app.delegate
            .renderResult(job, { expanded: true }, theme, { isError: false, keyHint })
            .render(120)
            .join("\n");
        assert.match(launchResult, /Model:[\s\S]*Tools:/);
        // Display-only suffix: the session thinking (off) shows on the model, --model stays raw.
        assert.match(job.details.model, /:off$/, "inherited thinking must suffix the model display");
        assert.equal(launch.concat(launchResult).match(/trace it/g)?.length, 1, "launch task shown twice");
        assert.equal(launch.concat(launchResult).match(/first run/g)?.length, 1, "launch description shown twice");
        assert.match(
            app.delegate
                .renderResult(
                    { ...job, content: [{ type: "text", text: "Launch failed" }] },
                    { expanded: false },
                    theme,
                    { isError: true },
                )
                .render(120)
                .join("\n"),
            /Launch failed/,
        );
        const steerArgs = { id: `job ${job.details.id}`, message: guidance };
        const callRows = app.steer
            .renderCall(steerArgs, theme, { expanded: true, keyHint })
            .render(120)
            .map((row: string) => stripVTControlCharacters(row).trimEnd());
        assert.match(callRows[0], new RegExp(`^delegate_steer ${job.details.id} explore`));
        assert.doesNotMatch(callRows[0], /Parent guidance/);
        assert.match(callRows.slice(1).join("\n"), /Parent guidance\n\s*\nKeep both paragraphs\./);
        const steered = await steerJob(app, job);
        const steerResult = app.steer
            .renderResult(steered, { expanded: true }, theme, { isError: false, keyHint })
            .render(120);
        assert.equal([...callRows, ...steerResult].join("\n").match(/Parent guidance/g)?.length, 1);
        await cancelJob(app, job);
    });

    it("reports the finished job with the child's tool calls", async () => {
        const app = tuiSession();
        const job = await startJob(app, "first run");
        const report = await finishJob(app, job);
        assert.equal(report.message.details.error, undefined);
        assert.equal(report.message.details.toolCalls, 106);
        assert.doesNotMatch(report.message.content, /\b\d+ tool calls?\b/);
        assert.equal(report.message.customType, "delegate-result");
        assert.deepEqual(report.options, { triggerTurn: true, deliverAs: "steer" });
        assert.match(
            stripVTControlCharacters(
                app.steer
                    .renderCall({ id: `job ${job.details.id}`, message: guidance }, theme, {
                        expanded: false,
                        keyHint,
                    })
                    .render(120)[0],
            ),
            new RegExp(`^delegate_steer ${job.details.id} explore`),
            "finished delegate identity lost from call header",
        );
        assert.match(reportCard(app, report), new RegExp(`✓ ${job.details.id} explore first run`));
    });

    // A child must never be able to delegate further, whatever tools its agent asks for.
    it("never gives the child the delegate tools", async () => {
        const agentsDir = mkdtempSync(join(tmpdir(), "pi-delegate-agents-"));
        writeFileSync(
            join(agentsDir, "probe.md"),
            "---\nname: probe\ndescription: probe agent\ntools: read, delegate, delegate_steer\n---\nYou probe.\n",
        );
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ delegate: { agentDirs: [agentsDir] } }));
        try {
            const app = tuiSession();
            const job = await app.delegate.execute(
                "call",
                { agent: "probe", description: "denylist", task: "trace it" },
                undefined,
                () => {},
                app.tuiCtx,
            );
            assert.deepEqual(job.details.tools, ["read"]);
            await cancelJob(app, job);
        } finally {
            rmSync(join(agentDir, "settings.json"), { force: true });
            rmSync(agentsDir, { recursive: true, force: true });
        }
    });

    it("spawns the child on the pinned session with the resolved model and tools", async () => {
        const app = tuiSession();
        const job = await startJob(app);
        // The child writes its argv when it starts, just after execute returns.
        const spawn = await findSpawn(`delegate-${job.details.id}`);
        assert.ok(spawn, "child never spawned");
        assert.deepEqual(spawn.slice(0, 6), [
            "--mode",
            "rpc",
            "--session-id",
            `delegate-${job.details.id}`,
            "--session-dir",
            sessionDir,
        ]);
        assert.deepEqual(spawn.slice(6, 10), ["--model", "anthropic/m", "--tools", job.details.tools.join(",")]);
        assert.ok(!spawn.includes("--no-session"), "child would start a fresh session");
        await cancelJob(app, job);
    });
});

describe("inspector", () => {
    it("opens the observer on a live job", async () => {
        const app = tuiSession();
        const first = await startJob(app, "first run");
        await finishJob(app, first);
        const second = await startJob(app, "second run", longTask);
        assert.match(app.state.widgetLines.join("\n"), /1 running · 2 total/);
        assert.match(app.state.widgetLines.join("\n"), new RegExp(`${second.details.id} explore second run`));

        const observing = app.inspect.handler("", { mode: "tui", ui: app.ui });
        const view = await withTimeout(app.viewerReady);
        const renderCount = app.state.renders;
        await withTimeout(new Promise<void>((resolve) => (app.state.onRender = resolve)));
        assert.ok(app.state.renders > renderCount, "ticker did not redraw the observer");
        colored.length = 0;
        const rows = view.render(80);
        const opened = rows.join("\n");
        assert.ok(
            rows.some((row: string) => row.split("│")[1]?.includes("Trace delegates")),
            "initial user message missing from inspector",
        );
        assert.match(rows[0], /\[Jobs\]  Activity · 1 running · 2 total/);
        assert.doesNotMatch(rows[0], /Jobs \(/);
        assert.doesNotMatch(rows[0], /Delegates/);
        assert.match(opened, /second run/);
        assert.match(opened, /signal\./);
        assert.ok(rows.some((row: string) => row.includes(second.details.model)));
        assert.ok(
            rows.findIndex((row: string) => row.includes(second.details.model)) <
                rows.findIndex((row: string) => row.includes("Trace delegates")),
        );
        assert.match(opened, new RegExp(`✓ ${first.details.id} explore`));
        assert.match(opened, new RegExp(`${second.details.id} explore`));
        assert.match(rows[2].split("│")[0], new RegExp(`${second.details.id} explore`));
        assert.match(rows[2].split("│")[1], new RegExp(`${second.details.id} explore`));
        assert.ok(colored.some(([color, text]) => color === "muted" && text === second.details.id));
        assert.ok(colored.some(([color, text]) => color === "toolTitle" && text === "explore"));
        const toolsRow = rows.findIndex((row: string) => row.includes("read, grep, find, ls"));
        const titleRow = rows.findIndex((row: string) => row.split("│")[1]?.includes("second run"));
        assert.ok(rows.findIndex((row: string) => row.includes(second.details.model)) < toolsRow);
        assert.match(rows[toolsRow + 1].split("│")[1], /─{20}/);
        assert.equal(titleRow, 2);
        assert.ok(titleRow < rows.findIndex((row: string) => row.includes("Trace delegates")));
        assert.doesNotMatch(rows[toolsRow].split("│")[1], /Tools:/);
        const narrow = view.render(32).join("\n");
        assert.match(narrow, /read, grep/);
        assert.match(narrow, /find, ls/);
        assert.equal(view.render(32).length, app.tui.terminal.rows, "long task must not grow the pane");
        assert.match(rows[4].split("│")[0], /\d+s/);
        // The task reaches the pane only as the child's first user message.
        assert.match(opened, /Trace delegates/);
        assert.ok(
            rows.every((row: string) => !row.split("│")[0]?.includes("Trace")),
            "task leaked into the sidebar",
        );
        assert.doesNotMatch(opened, /Model:|Task:/);

        // What the overlay stub saw while opening.
        assert.equal(app.state.overlay?.overlay, true);
        assert.deepEqual(app.state.overlay?.overlayOptions, {
            width: "100%",
            maxHeight: "100%",
            row: 0,
            col: 0,
        });
        assert.equal(app.state.overlay?.height, app.tui.terminal.rows);
        assert.deepEqual(
            app.state.overlay?.historyWidths.second,
            app.state.overlay?.historyWidths.first,
            "the history width changed between frames",
        );
        assert.equal(app.state.overlay?.historyWidths.first.length, 1, "the history rendered more than once per frame");
        assert.ok(
            rows.every((row: string) => visibleWidth(row) === 80),
            "inspector rows must fill the width",
        );

        const originalNow = Date.now;
        try {
            Date.now = () => 0;
            const frozen = view.render(80)[2];
            Date.now = () => SPINNER_INTERVAL_MS;
            assert.notEqual(view.render(80)[2], frozen, "running status spinner stayed frozen");
        } finally {
            Date.now = originalNow;
        }

        view.handleInput("down");
        assert.match(view.render(80).join("\n"), /first run/);
        assert.match(view.render(80).join("\n"), /Count/);
        assert.match(view.render(80).join("\n"), /a\.ts/);
        assert.match(view.render(80).join("\n"), /read, grep, find, ls/);
        const recentRows = view.render(80);
        const recentStats = recentRows[7].split("│")[0].match(/37k\/1\.0M · \d+s/)?.[0];
        assert.ok(recentStats, "finished job tokens and time missing from list");
        assert.doesNotMatch(recentRows.join("\n"), /\b\d+ tool calls?\b/);
        const now = Date.now;
        try {
            Date.now = () => now() + 60000;
            assert.ok(view.render(80).join("\n").includes(recentStats!), "finished job elapsed time kept ticking");
        } finally {
            Date.now = now;
        }
        view.handleInput("up");
        assert.match(view.render(80).join("\n"), /second run/);
        view.handleInput("\x1b");
        await observing;
        await cancelJob(app, second);
    });
    it("pages, jumps and expands the activity pane from its keybindings", async () => {
        const app = tuiSession();
        await finishJob(app, await startJob(app, "first run"));
        const second = await startJob(app, "second run", longTask);
        const observing = app.inspect.handler("", { mode: "tui", ui: app.ui });
        const view = await withTimeout(app.viewerReady);
        await steerJob(app, second, guidance);
        view.handleInput("\x1b[C");
        assert.match(view.render(80)[0], /\[Activity\]/);
        const rows = () => view.render(80).map((row: string) => stripVTControlCharacters(row));
        // The pane's counter reports the visible window: first–last/total.
        const counter = () => {
            const match = rows()[21]
                ?.split("│")[1]
                ?.match(/(\d+)–(\d+)\/(\d+)/);
            assert.ok(match, "the activity pane lost its scroll counter");
            return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
        };
        const follow = counter();
        assert.ok(follow.start > 1, "the transcript must be taller than the pane to page it");

        view.handleInput("pageUp");
        assert.equal(counter().start, follow.start - 11, "page up did not move the window back by a page");
        view.handleInput("ctrl+home");
        assert.equal(counter().start, 1);
        view.handleInput("ctrl+end");
        assert.deepEqual(counter(), follow);

        // Expanded tool rows drop the one-line ↳ preview and print the result in full.
        assert.match(rows().join("\n"), /↳/);
        view.handleInput("ctrl+o");
        assert.doesNotMatch(rows().join("\n"), /↳/, "expand did not show the full tool output");

        // The wheel scrolls the pane under the pointer; over the sidebar it moves the selection.
        view.handleInput("ctrl+home");
        const wheel = (x: number, wheelDelta: number) =>
            view.handleMouse({
                type: "wheel",
                button: "none",
                x,
                y: 5,
                screenX: x,
                screenY: 5,
                width: 80,
                height: 24,
                shift: false,
                alt: false,
                ctrl: false,
                wheelDelta,
            });
        assert.ok(wheel(60, -3));
        assert.match(rows().join("\n"), /Jump to latest message · Ctrl\+End/);
        wheel(60, 1000);
        assert.doesNotMatch(rows().join("\n"), /Jump to latest message/, "the pill stayed at the bottom");
        wheel(5, 1);
        assert.match(rows()[2].split("│")[1] ?? "", /first run/, "the wheel over the sidebar did not move");
        assert.doesNotMatch(rows().join("\n"), /↳/, "a transcript built after expanding must render expanded");

        // A click on a job row selects it, like pi's select list.
        view.handleMouse({
            type: "click",
            button: "left",
            x: 5,
            y: 2,
            screenX: 5,
            screenY: 2,
            width: 80,
            height: 24,
            shift: false,
            alt: false,
            ctrl: false,
        });
        assert.match(rows()[2].split("│")[1] ?? "", /second run/, "a click on a job row did not select it");

        view.handleInput("ctrl+o");
        assert.match(rows().join("\n"), /↳/, "collapse did not restore the preview");

        view.handleInput("\x1b");
        await observing;
        await cancelJob(app, second);
    });

    it("follows a live steer in the activity pane", async () => {
        const app = tuiSession();
        await finishJob(app, await startJob(app, "first run"));
        const second = await startJob(app, "second run", longTask);
        const observing = app.inspect.handler("", { mode: "tui", ui: app.ui });
        const view = await withTimeout(app.viewerReady);
        const before = app.state.renders;
        const steered = await steerJob(app, second, guidance);
        assert.equal(steered.details.toolCalls, 105);
        assert.match(
            app.steer
                .renderResult(steered, { expanded: false }, theme, { isError: false, keyHint })
                .render(120)
                .join("\n"),
            new RegExp(`✓ ${second.details.id} explore second run`),
        );
        assert.ok(app.state.renders > before, "live activity did not redraw the observer");
        await withTimeout(new Promise<void>((resolve) => (app.state.onRender = resolve)));
        assert.match(app.state.widgetLines.join("\n"), /37k\/1\.0M/);
        assert.doesNotMatch(app.state.widgetLines.join("\n"), /\b\d+ tool calls?\b/);
        view.handleInput("\x1b[C");
        assert.match(view.render(80)[0], /\[Activity\]/);
        assert.doesNotMatch(view.render(80)[0], /\[Jobs/);
        assert.match(view.render(80).join("\n"), /src\/104\.ts/);
        const liveRows = view.render(80).map(stripVTControlCharacters);
        assert.ok(
            liveRows.some((row: string) => row.split("│")[1]?.includes("Parent guidance")),
            "steer message missing from the history pane",
        );
        const guidanceRow = liveRows.findIndex((row: string) => row.includes("Parent guidance"));
        assert.ok(guidanceRow >= 0, "steer text missing from live inspector");
        assert.equal(liveRows[guidanceRow + 1]?.split("│")[1]?.trim(), "", "steer paragraph break lost");
        assert.match(liveRows[guidanceRow + 2], /Keep both paragraphs\./);
        assert.match(
            liveRows.at(-3)?.split("│")[1] ?? "",
            /3\.7%\/1\.0M  \d+(–\d+)?\/\d+\b/,
            "the pane's footer line lost the usage totals or the scroll counter",
        );
        assert.doesNotMatch(liveRows[0] ?? "", /3\.7%\/1\.0M/, "the footer owns context, not the header");
        assert.match(liveRows[0] ?? "", / · \d+s\s*$/, "the header keeps the elapsed time");
        assert.match(view.render(80)[4].split("│")[0], /    37k\/1\.0M · \d+s/);
        assert.doesNotMatch(view.render(80).join("\n"), /\b\d+ tool calls?\b/);
        view.handleInput("\x1b");
        await observing;
        await cancelJob(app, second);
    });

    it("keeps a scrolled-back history in place while the job finishes", async () => {
        const app = tuiSession();
        await finishJob(app, await startJob(app, "first run"));
        const second = await startJob(app, "second run", longTask);
        const observing = app.inspect.handler("", { mode: "tui", ui: app.ui });
        const view = await withTimeout(app.viewerReady);
        await steerJob(app, second, guidance);
        view.handleInput("\x1b[C");
        const toolsRow = view.render(80).findIndex((row: string) => row.includes("read, grep, find, ls"));
        for (let i = 0; i < 3; i++) view.handleInput("up");
        const scrolledLine = view.render(80)[toolsRow + 3];
        const report = app.nextMessage();
        await steerJob(app, second, "Final parent guidance");
        assert.equal(view.render(80)[toolsRow + 3], scrolledLine, "new events moved the scrolled-back history");
        const secondReport = await withTimeout(report);
        assert.equal(secondReport.message.details.error, undefined);
        assert.match(reportCard(app, secondReport), new RegExp(`✓ ${second.details.id} explore second run`));
        view.handleInput("\x1b");
        await observing;
    });

    it("reopens with the finished transcript", async () => {
        const app = tuiSession();
        const job = await startJob(app, "second run", longTask);
        await finishJob(app, job, "Final parent guidance");
        const observing = app.inspect.handler("", { mode: "tui", ui: app.ui });
        const view = await withTimeout(app.viewerReady);
        for (let i = 0; i < 30; i++) view.handleInput("down");
        assert.match(view.render(80).join("\n"), /Count/);
        view.invalidate();
        assert.match(view.render(80).join("\n"), /a\.ts/);
        view.handleInput("\x1b");
        await observing;
        assert.equal(app.state.screens, 1);

        // A fresh inspector must retain both steer messages after the job finishes.
        app.tui.terminal.rows = 40;
        const reopenedReady = new Promise<any>((resolve) => (app.state.showViewer = resolve));
        const reopening = app.inspect.handler("", { mode: "tui", ui: app.ui });
        const reopened = await withTimeout(reopenedReady);
        const text = reopened.render(80).join("\n");
        assert.match(text, /Parent guidance/);
        assert.match(text, /Keep both paragraphs\./);
        assert.match(text, /Final parent guidance/);
        assert.match(text, /Count/);
        assert.match(stripVTControlCharacters(reopened.render(80).at(-3) ?? ""), /3\.7%\/1\.0M/);
        reopened.handleInput("\x1b");
        await reopening;
        assert.equal(app.state.screens, 2);
    });

    it("lists running and finished jobs", async () => {
        const app = tuiSession();
        const first = await startJob(app, "first run");
        await finishJob(app, first);
        const second = await startJob(app, "second run", longTask);
        await steerJob(app, second, guidance);
        const listed = await app.list.execute();
        assert.doesNotMatch(listed.content[0].text, /\b\d+ tool calls?\b/);
        // The list result renders job identity rows from details, not the model-facing text; the call line is Pi's.
        assert.equal(typeof app.list.renderCall, "undefined");
        assert.ok(
            listed.details.jobs.some((job: any) => job.id === second.details.id && job.agent === "explore"),
            "running job missing from list details",
        );
        assert.ok(
            listed.details.jobs.every((job: any) => job.messages.length === 0),
            "delegate_list copied the transcript into its result",
        );
        // The list shows finished jobs too, each with its terminal status.
        assert.ok(
            listed.details.jobs.some((job: any) => job.id === first.details.id && job.status === "done"),
            "finished job missing from list details",
        );
        assert.match(listed.content[0].text, new RegExp(`${first.details.id} explore · done`));
        colored.length = 0;
        const listCard = app.list
            .renderResult(listed, { expanded: false }, theme, { isError: false, keyHint })
            .render(120)
            .map(stripVTControlCharacters);
        assert.equal(listCard[0].trim(), "", "list rows missing their footer separator");
        assert.match(
            listCard.slice(1).join("\n"),
            new RegExp(`${second.details.id} explore second run · 37k/1\\.0M · \\d+s`),
        );
        assert.ok(colored.some(([color, text]) => color === "toolTitle" && text === "explore"));
        assert.match(
            app.list
                .renderResult(
                    { content: [{ type: "text", text: "No delegates yet." }], details: undefined },
                    { expanded: false },
                    theme,
                    { isError: false, keyHint },
                )
                .render(80)
                .join("\n"),
            /No delegates yet\./,
        );
        // Statuses, identity and previews all render through the shared color vocabulary.
        assert.deepEqual([...new Set(colored.map(([color]) => color))].sort(), [
            "muted",
            "success",
            "toolOutput",
            "toolTitle",
            "warning",
        ]);
        await cancelJob(app, second);
    });
});

describe("session restore", () => {
    // pi --continue loads a fresh extension; finished jobs come back from the session branch.
    it("rebuilds the finished jobs from the session branch", async () => {
        const app = tuiSession();
        const job = await startJob(app, "second run", longTask);
        await finishJob(app, job, "Final parent guidance");
        const handlers: Record<string, any> = {};
        const restored = registerExtension({ on: (event, handler) => (handlers[event] = handler) });
        // A restored job has no messages in memory: the inspector reads the session file the child wrote.
        assert.ok(
            readdirSync(sessionDir).some((name) => name.endsWith(`_delegate-${job.details.id}.jsonl`)),
            "the fake child did not persist its session",
        );
        handlers.session_start({}, { sessionManager: { getBranch: () => app.savedEntries } });
        app.tui.terminal.rows = 40;
        const restoredReady = new Promise<any>((resolve) => (app.state.showViewer = resolve));
        const restoring = restored.inspect.handler("", { mode: "tui", ui: app.ui });
        const view = await withTimeout(restoredReady);
        const text = view.render(80).join("\n");
        assert.match(text, /second run/);
        assert.match(text, /Final parent guidance/);
        assert.match(text, /Count/);
        // Launch plus completion entries restore as one job per id, not two rows.
        assert.match(text, /0 running · 1 total/, "restored jobs listed more than once");
        view.handleInput("\x1b");
        await restoring;
        assert.equal(app.state.screens, 1);
    });
});

describe("cancel and strict parameters", () => {
    it("keeps the cancelled job identity in the call header", async () => {
        const app = tuiSession();
        const job = await startJob(app, "cancelled run");
        await cancelJob(app, job);
        assert.match(
            stripVTControlCharacters(
                app.cancel.renderCall({ id: job.details.id }, theme, { expanded: false, keyHint }).render(120)[0],
            ),
            new RegExp(`^delegate_cancel ${job.details.id} explore`),
            "cancelled delegate identity lost from call header",
        );
    });

    // Strict models inject literal null and "null" for optional params they omit.
    it("treats null optional params as absent", async () => {
        const app = tuiSession();
        const nulled = await app.delegate.execute(
            "call",
            { agent: "explore", description: "null params", task: "trace it", model: null },
            undefined,
            () => {},
            app.tuiCtx,
        );
        assert.match(nulled.details.id, /^[0-9a-f]{8}$/);
        assert.match(nulled.details.model, /^anthropic\/m/);
        const stringy = await app.delegate.execute(
            "call",
            { agent: "explore", description: "string null params", task: "trace it", model: "null", isolated: "null" },
            undefined,
            () => {},
            app.tuiCtx,
        );
        assert.match(stringy.details.model, /^anthropic\/m/);
        assert.equal(stringy.details.isolation, undefined);
        await cancelJob(app, nulled);
        await cancelJob(app, stringy);
    });
});

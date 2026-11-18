import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import {
    baseCtx,
    cleanup,
    fakePi,
    jobEntry,
    keyHint,
    overlayHarness,
    registerExtension,
    sessionDir,
    themeStub,
    withTimeout,
} from "./helpers.ts";

vi.setConfig({ testTimeout: 60000 });

const { theme } = themeStub();
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

/** A fresh extension instance, its TUI, and the session events it registers. */
function recoverySession() {
    const handlers: Record<string, any> = {};
    const app = registerExtension({ on: (event, handler) => (handlers[event] = handler) });
    const screen = overlayHarness(theme);
    return {
        ...app,
        ...screen,
        handlers,
        launch: app.tool("delegate"),
        steer: app.tool("delegate_steer"),
        cancel: app.tool("delegate_cancel"),
        list: app.tool("delegate_list"),
        tuiCtx: { ...baseCtx, mode: "tui", hasUI: true, ui: screen.ui },
    };
}

type RecoverySession = ReturnType<typeof recoverySession>;

/** Restores one orphaned running job, as a crashed session would. */
function restoreOrphan(app: RecoverySession, id: string, description: string) {
    const orphan = { ...jobEntry(id, "running"), agent: "explore", description };
    app.handlers.session_start(
        {},
        {
            sessionManager: {
                getBranch: () => [{ type: "custom", customType: "delegate-job", data: orphan }],
            },
        },
    );
    return orphan;
}

/** Writes the pinned transcript a child would have left behind. */
function writePinnedSession(id: string, text: string): void {
    writeFileSync(
        join(sessionDir, `2026-01-01T00-00-00-000Z_delegate-${id}.jsonl`),
        `${JSON.stringify({ type: "session", id: `delegate-${id}` })}\n${JSON.stringify({
            type: "message",
            message: { role: "user", content: text },
        })}\n`,
    );
}

function revive(app: RecoverySession, id: string) {
    return app.steer.execute("call", { id: `job ${id}`, message: "revive: finish it" }, undefined, () => {}, baseCtx);
}

function childCommands(): string[] {
    try {
        return readFileSync(join(pi.dir, "commands.log"), "utf8").trimEnd().split("\n");
    } catch {
        return [];
    }
}

describe("crash recovery", () => {
    it("interrupts an orphaned running job and announces it", () => {
        const app = recoverySession();
        const orphan = restoreOrphan(app, "orphan1", "orphaned run");
        assert.equal(orphan.status, "running", "restore mutated the session's own entry");
        assert.equal(app.savedEntries.at(-1)!.data.status, "interrupted");
        assert.equal(app.savedEntries.at(-1)!.data.id, "orphan1");
        const notice = app.messages.at(-1)!.message;
        assert.equal(notice.customType, "delegate-interrupted");
        assert.match(notice.content, /orphan1 .*explore: orphaned run/);
        assert.match(notice.content, /delegate_steer/);
    });

    // The pinned transcript replays into the revived job's activity, so the inspector keeps the old history.
    it("revives an interrupted job from its pinned transcript", async () => {
        const app = recoverySession();
        restoreOrphan(app, "orphan1", "orphaned run");
        writePinnedSession("orphan1", "orphan task");
        const revived = await revive(app, "orphan1");
        assert.match(revived.content[0].text, /Revived and finished\./);
        assert.equal(revived.details.id, "orphan1");
        assert.equal(revived.details.background, false);
        assert.match(
            stripVTControlCharacters(
                app.steer
                    .renderResult(revived, { expanded: false }, theme, { isError: false, keyHint })
                    .render(120)
                    .join("\n"),
            ),
            new RegExp(`✓ orphan1 explore revived[\\s\\S]*Revived and finished\\.`),
            "foreground revive missing its mark and child output",
        );
        const launchEntry = app.savedEntries.find(
            (entry) => entry.data?.id === "orphan1" && entry.data.status === "running",
        );
        assert.ok(launchEntry, "revived launch entry missing");
        assert.deepEqual(launchEntry.data.messages, [], "revived job persisted its transcript");
        assert.equal("activity" in launchEntry.data, false, "store entries still carry the old activity field");
        assert.deepEqual(
            app.savedEntries.filter((entry) => entry.data?.id === "orphan1").map((entry) => entry.data.status),
            ["interrupted", "running", "done"],
        );
    });

    // A done job revives too, and a model override reaches the relaunched child.
    it("revives a finished job with a model override", async () => {
        const app = recoverySession();
        restoreOrphan(app, "orphan1", "orphaned run");
        writePinnedSession("orphan1", "orphan task");
        await revive(app, "orphan1");
        const revivedAgain = await app.steer.execute(
            "call",
            { id: "job orphan1", message: "revive: once more", model: "anthropic/flash:high" },
            undefined,
            () => {},
            baseCtx,
        );
        assert.match(revivedAgain.content[0].text, /Revived and finished\./);
        assert.equal(revivedAgain.details.model, "anthropic/flash:high");
    });

    // A foreground revive inherits the tool's abort signal, so Esc can stop it mid-run.
    it("aborts a foreground revive", async () => {
        const app = recoverySession();
        restoreOrphan(app, "orphan1", "orphaned run");
        writePinnedSession("orphan1", "orphan task");
        await revive(app, "orphan1");
        const aborting = new AbortController();
        aborting.abort();
        await assert.rejects(
            app.steer.execute(
                "call",
                { id: "job orphan1", message: "revive: abort me" },
                aborting.signal,
                () => {},
                baseCtx,
            ),
            /aborted/,
        );
    });

    // A running job swaps its model live: set_model (and set_thinking_level for an explicit level) reach
    // the child over the RPC, without a restart, before the steer message is queued.
    it("swaps the model of a running job live", async () => {
        const app = recoverySession();
        const job = await app.launch.execute(
            "call",
            { agent: "explore", description: "live swap", task: "trace it" },
            undefined,
            () => {},
            app.tuiCtx,
        );
        const before = childCommands().length;
        const swapped = await app.steer.execute(
            "call",
            { id: job.details.id, message: "use a cheaper model", model: "anthropic/flash:high" },
            undefined,
            () => {},
            app.tuiCtx,
        );
        assert.match(swapped.content[0].text, /delivered/);
        assert.deepEqual(
            childCommands()
                .slice(before)
                .map((line) => line.replace(/\s+/g, " ")),
            ["set_model anthropic flash", "set_thinking_level high"],
        );
        // A rejected live swap surfaces the child's error; the job stays live and cancellable.
        await assert.rejects(
            app.steer.execute(
                "call",
                { id: job.details.id, message: "no swap", model: "nope/x" },
                undefined,
                () => {},
                app.tuiCtx,
            ),
            /Model not found/,
        );
        await app.cancel.execute("call", { id: job.details.id }, undefined, () => {}, app.tuiCtx);
    });

    // A swap without an explicit level leaves the level to pi, so the display shows the bare model.
    it("keeps the bare model for a level-less swap", async () => {
        const app = recoverySession();
        const job = await app.launch.execute(
            "call",
            { agent: "explore", description: "level-less swap", task: "trace it" },
            undefined,
            () => {},
            app.tuiCtx,
        );
        const before = childCommands().length;
        await app.steer.execute(
            "call",
            { id: job.details.id, message: "swap without level", model: "anthropic/flash" },
            undefined,
            () => {},
            app.tuiCtx,
        );
        const listed = await app.list.execute();
        assert.equal(
            listed.details.jobs.find((entry: any) => entry.id === job.details.id).model,
            "anthropic/flash",
            "a level-less swap invented a thinking suffix",
        );
        assert.deepEqual(childCommands().slice(before), ["set_model anthropic flash"]);
        await app.cancel.execute("call", { id: job.details.id }, undefined, () => {}, app.tuiCtx);
    });

    // A mid-run session_tree rebuild restores the live job's launch entry. The restore must not double it, and
    // finishing the job must not leave a phantom running row behind.
    it("keeps a session rebuild from doubling a live job", async () => {
        const app = recoverySession();
        const job = await app.launch.execute(
            "call",
            { agent: "explore", description: "phantom run", task: "trace it" },
            undefined,
            () => {},
            app.tuiCtx,
        );
        app.handlers.session_tree({}, { sessionManager: { getBranch: () => app.savedEntries } });
        app.tui.terminal.rows = 40;
        const ready = new Promise<any>((resolve) => (app.state.showViewer = resolve));
        const opening = app.inspect.handler("", { mode: "tui", ui: app.ui });
        const view = await withTimeout(ready);
        assert.match(view.render(80).join("\n"), /1 running · 1 total/, "restored launch entry doubled the live job");
        await app.cancel.execute("call", { id: job.details.id }, undefined, () => {}, app.tuiCtx);
        view.invalidate();
        const done = view.render(80).join("\n");
        assert.match(done, /0 running · 1 total/, "finished job left a phantom running row");
        assert.match(done, /✗/);
        view.handleInput("\x1b");
        await opening;
    });

    // Reviving a recreated (empty) pinned transcript must fail instead of prompting into a blank session.
    it("refuses to revive an empty transcript and revives the failed job", async () => {
        const app = recoverySession();
        restoreOrphan(app, "orphan2", "empty revive");
        writeFileSync(join(pi.dir, "empty"), "");
        await assert.rejects(
            app.steer.execute(
                "call",
                { id: "job orphan2", message: "revive: try again" },
                undefined,
                () => {},
                baseCtx,
            ),
            /transcript is empty[\s\S]*delegate_steer with id orphan2/,
        );
        rmSync(join(pi.dir, "empty"), { force: true });
        assert.equal(app.savedEntries.filter((entry) => entry.data?.id === "orphan2").at(-1)!.data.status, "failed");
        // A failed job is revivable: the pinned transcript reopens and the continuation prompt settles it.
        const revived = await app.steer.execute(
            "call",
            { id: "job orphan2", message: "revive: try again" },
            undefined,
            () => {},
            baseCtx,
        );
        assert.match(revived.content[0].text, /Revived and finished\./);
        assert.equal(revived.details.id, "orphan2");
        assert.deepEqual(
            app.savedEntries.filter((entry) => entry.data?.id === "orphan2").map((entry) => entry.data.status),
            ["interrupted", "running", "failed", "running", "done"],
        );
    });
});

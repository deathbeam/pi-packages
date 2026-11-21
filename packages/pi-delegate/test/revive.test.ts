import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import {
    baseCtx,
    cleanup,
    fakePi,
    keyHint,
    overlayHarness,
    registerExtension,
    tempGitRepo,
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

/** A fresh extension instance with its tools and a TUI that renders widgets. */
function delegateSession() {
    const app = registerExtension();
    const screen = overlayHarness(theme);
    return {
        ...app,
        ...screen,
        launch: app.tool("delegate"),
        steer: app.tool("delegate_steer"),
        cancel: app.tool("delegate_cancel"),
        apply: app.tool("delegate_apply"),
        discard: app.tool("delegate_discard"),
        tuiCtx: { ...baseCtx, mode: "tui", hasUI: true, ui: screen.ui },
    };
}

type DelegateSession = ReturnType<typeof delegateSession>;

async function launch(app: DelegateSession, ctx: any, fields: Record<string, unknown> = {}) {
    return app.launch.execute(
        "call",
        { agent: "explore", description: "a run", task: "trace it", ...fields },
        undefined,
        () => {},
        ctx,
    );
}

async function cancelJob(app: DelegateSession, ctx: any, job: any) {
    await app.cancel.execute("call", { id: job.details.id }, undefined, () => {}, ctx);
}

describe("background revive", () => {
    // Steering a finished job revives it in the background under the same id, with a fresh report to come.
    it("revives a cancelled job in the background", async () => {
        const app = delegateSession();
        const cancelled = await launch(app, app.tuiCtx, { description: "cancelled run" });
        await cancelJob(app, app.tuiCtx, cancelled);
        const report = app.nextMessage();
        const revivedLaunch = await app.steer.execute(
            "call",
            { id: `job ${cancelled.details.id}`, message: "revive: finish it" },
            undefined,
            () => {},
            app.tuiCtx,
        );
        assert.equal(revivedLaunch.details.id, cancelled.details.id);
        assert.match(revivedLaunch.content[0].text, /^Revived delegate "explore" in the background/);
        assert.match(
            stripVTControlCharacters(
                app.steer
                    .renderResult(revivedLaunch, { expanded: false }, theme, { isError: false, keyHint })
                    .render(120)
                    .join("\n"),
            ),
            new RegExp(`${cancelled.details.id} explore revived in background`),
            "revived launch missing its mark in the result header",
        );
        const revivedReport = await withTimeout(report);
        assert.equal(revivedReport.message.details.id, cancelled.details.id);
        assert.equal(revivedReport.message.details.error, undefined);
    });

    // Both revives pass the idle-clone checks, so only the first may spawn on the finished job's id.
    it("refuses a second revive of the same job", async () => {
        const app = delegateSession();
        const job = await launch(app, app.tuiCtx, { description: "twin revive" });
        await cancelJob(app, app.tuiCtx, job);
        const first = app.steer.execute(
            "call",
            { id: job.details.id, message: "revive: first" },
            undefined,
            () => {},
            app.tuiCtx,
        );
        const second = app.steer.execute(
            "call",
            { id: job.details.id, message: "revive: second" },
            undefined,
            () => {},
            app.tuiCtx,
        );
        await assert.rejects(second, /is already running/);
        assert.match((await first).content[0].text, /^Revived delegate/);
    });
});

describe("cancel and revive race", () => {
    // Cancel then steer at once: the revive waits for the cancelled child to exit instead of double-spawning its session.
    it("waits for the cancelled child to exit before reviving", async () => {
        const app = delegateSession();
        const raceCliDir = mkdtempSync(join(tmpdir(), "pi-delegate-race-"));
        try {
            const raceCli = join(raceCliDir, "pi.mjs");
            writeFileSync(
                raceCli,
                `
import { appendFileSync } from "node:fs";
const LOG = '${join(raceCliDir, "spawn.log")}';
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
appendFileSync(LOG, "start " + process.pid + "\\n");
process.on("exit", () => appendFileSync(LOG, "exit " + process.pid + "\\n"));
process.stdin.on("data", (data) => {
    for (const line of data.toString().trim().split("\\n")) {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
            send({ type: "response", command: "get_state", id: command.id, success: true, data: { messageCount: 5 } });
        } else if (command.type === "prompt") {
            send({ type: "response", command: "prompt", id: command.id, success: true });
            if (command.message.startsWith("revive")) {
                send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Revived and finished." }], timestamp: Date.now() } });
                send({ type: "agent_settled" });
            }
        } else if (command.type === "abort") {
            // A slow exit is the window in which a revive that does not wait would overlap this child.
            setTimeout(() => {
                send({ type: "response", command: "abort", id: command.id, success: true });
                send({ type: "agent_settled", aborted: true });
            }, 300);
        }
    }
});
`,
            );
            const raceLog = () => {
                try {
                    return readFileSync(join(raceCliDir, "spawn.log"), "utf8").trim().split("\n").filter(Boolean);
                } catch {
                    return [];
                }
            };
            process.argv = [argv[0], raceCli];
            try {
                const raced = await launch(app, app.tuiCtx, { description: "cancel race" });
                await cancelJob(app, app.tuiCtx, raced);
                const racedSteer = await app.steer.execute(
                    "call",
                    { id: raced.details.id, message: "revive: finish it" },
                    undefined,
                    () => {},
                    app.tuiCtx,
                );
                assert.equal(racedSteer.details.id, raced.details.id);
                assert.match(racedSteer.content[0].text, /^Revived delegate/);
            } finally {
                process.argv = [argv[0], pi.cli];
            }
            let events: string[] = [];
            for (let i = 0; i < 300; i++) {
                events = raceLog();
                if (events.length >= 4) break;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.deepEqual(
                events.map((event) => event.split(" ")[0]),
                ["start", "exit", "start", "exit"],
                "revive spawned before the cancelled child exited",
            );
        } finally {
            rmSync(raceCliDir, { recursive: true, force: true });
        }
    });
});

describe("shared clone", () => {
    // A clone belongs to no single job: any id that ran in it can apply it once, and only one job runs in it at a time.
    it("applies a clone that two jobs shared", async () => {
        const repo = tempGitRepo({ "seed.txt": "seed\n" });
        try {
            const app = delegateSession();
            const isoCtx = { ...app.tuiCtx, cwd: repo.dir };
            const owner = await launch(app, isoCtx, { description: "clone owner", isolated: true });
            const clone = owner.details.isolation.clone;
            // The refusal names the job holding the clone.
            await assert.rejects(
                launch(app, isoCtx, { description: "clone guest", clone: `job ${owner.details.id}` }),
                new RegExp(`"${owner.details.id}" is running in this clone`),
            );
            // clone implies isolation even though the explore agent is not isolated.
            await assert.rejects(
                launch(app, isoCtx, { description: "clone guest", clone: owner.details.id, isolated: false }),
                /clone always runs isolated/,
            );
            await cancelJob(app, isoCtx, owner);
            const guest = await launch(app, isoCtx, { description: "clone guest", clone: owner.details.id });
            assert.equal(guest.details.isolation.clone, clone, "the guest did not share the clone");
            // Apply refuses while another job in the clone is still running.
            await assert.rejects(
                app.apply.execute("call", { id: owner.details.id }, undefined, () => {}),
                new RegExp(`"${guest.details.id}" is running in this clone`),
            );
            await cancelJob(app, isoCtx, guest);
            writeFileSync(join(clone, "guest.txt"), "guest work\n");
            const applied = await app.apply.execute("call", { id: guest.details.id }, undefined, () => {});
            assert.match(applied.content[0].text, /Applied the changes/);
            assert.equal(
                readFileSync(join(repo.dir, "guest.txt"), "utf8"),
                "guest work\n",
                "apply via the guest id missed",
            );
            assert.equal(existsSync(clone), false, "the shared clone was not removed");
            for (const id of [owner.details.id, guest.details.id]) {
                const last = app.savedEntries.filter((entry) => entry.data?.id === id).at(-1)!.data;
                assert.equal(last.isolation, undefined, `${id} still points at the closed clone`);
                assert.equal(last.cloneClosed, true, `${id} did not record the closed clone`);
            }
            await assert.rejects(
                app.steer.execute("call", { id: owner.details.id, message: "continue" }, undefined, () => {}, isoCtx),
                /already applied or discarded/,
            );
        } finally {
            repo.remove();
        }
    });

    it("discards a clone without applying it", async () => {
        const repo = tempGitRepo({ "seed.txt": "seed\n" });
        try {
            const app = delegateSession();
            const isoCtx = { ...app.tuiCtx, cwd: repo.dir };
            const owner = await launch(app, isoCtx, { description: "discard me", isolated: true });
            await cancelJob(app, isoCtx, owner);
            const discarded = await app.discard.execute("call", { id: owner.details.id }, undefined, () => {});
            assert.match(discarded.content[0].text, /Discarded the isolated clone/);
            assert.equal(discarded.details.discarded, true);
            assert.equal(existsSync(owner.details.isolation.clone), false, "discard kept the clone");
            assert.equal(
                app.savedEntries.filter((entry) => entry.data?.id === owner.details.id).at(-1)!.data.cloneClosed,
                true,
            );

            // A parallel discard can close the clone while a revive waits for the cancelled child; re-check before spawning.
            const closing = await launch(app, isoCtx, {
                description: "close during revive",
                task: "close during revive",
                isolated: true,
            });
            await cancelJob(app, isoCtx, closing);
            // The refusal can land while the discard is still removing the clone, so attach the check before starting it.
            const reviving = assert.rejects(
                app.steer.execute(
                    "call",
                    { id: closing.details.id, message: "revive: finish it" },
                    undefined,
                    () => {},
                    isoCtx,
                ),
                /applied or discarded/,
            );
            await app.discard.execute("call", { id: closing.details.id }, undefined, () => {});
            await reviving;
        } finally {
            repo.remove();
        }
    });

    // Git now runs off the event loop, so a second apply or discard can arrive while the first still owns the clone.
    it("refuses an operation on a clone another one is applying", async () => {
        const repo = tempGitRepo({ "seed.txt": "seed\n" });
        try {
            const app = delegateSession();
            const isoCtx = { ...app.tuiCtx, cwd: repo.dir };
            const job = await launch(app, isoCtx, {
                description: "double claim",
                task: "double claim",
                isolated: true,
            });
            await cancelJob(app, isoCtx, job);
            const applied = app.apply.execute("call", { id: job.details.id }, undefined, () => {});
            const discarded = app.discard.execute("call", { id: job.details.id }, undefined, () => {});
            await assert.rejects(discarded, /being applied or discarded/);
            assert.match((await applied).content[0].text, /clone was removed/);
        } finally {
            repo.remove();
        }
    });
});

describe("apply while a cancelled child still writes", () => {
    // delegate_cancel drops the job at once, but the child keeps writing in its clone until SIGTERM or the 5s SIGKILL.
    it("waits for the child to exit before applying", async () => {
        const repo = tempGitRepo({ "seed.txt": "seed\n" });
        try {
            const app = delegateSession();
            const isoCtx = { ...app.tuiCtx, cwd: repo.dir };
            const job = await launch(app, isoCtx, { description: "late writer", task: "late writer", isolated: true });
            await cancelJob(app, isoCtx, job);
            const applied = await app.apply.execute("call", { id: job.details.id }, undefined, () => {});
            assert.match(applied.content[0].text, /Applied the changes/);
            assert.equal(readFileSync(join(repo.dir, "late.txt"), "utf8"), "late\n", "apply raced the exiting child");
        } finally {
            repo.remove();
        }
    });
});

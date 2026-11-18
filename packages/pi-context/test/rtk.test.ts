import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { cleanup, fire, loadExtension, result, rtkExec } from "./helpers.ts";

afterAll(cleanup);

describe("rtk command rewriting", () => {
    it("leaves commands untouched when rtk is not installed", async () => {
        const { handlers, commands } = await loadExtension();
        const event = { toolName: "bash", input: { command: "ls" } };
        assert.equal(await fire(handlers, "tool_call", event), undefined);
        assert.equal(event.input.command, "ls");
        assert.ok(commands.has("gain"), "the rest of the extension still loads");
    });

    describe("with rtk installed", () => {
        let handlers: Awaited<ReturnType<typeof loadExtension>>["handlers"];

        beforeAll(async () => {
            handlers = (await loadExtension(rtkExec(result(0, "rtk 0.40.0")))).handlers;
        });

        const run = async (command: string) => {
            const event = { toolName: "bash", input: { command } };
            const outcome = await fire(handlers, "tool_call", event, {});
            return { outcome, command: event.input.command };
        };

        // Exit 0 and 3 carry a rewritten command.
        for (const [command, expected] of [
            ["ls", "rtk ls"],
            ["grep", "rtk grep"],
        ]) {
            it(`rewrites ${command} to the condensed command`, async () => {
                assert.deepEqual(await run(command), { outcome: undefined, command: expected });
            });
        }

        // Exit 1, an exit 2 without a message, a killed run and a throwing rtk pass the command through.
        for (const command of ["cat", "noop", "killed", "boom"]) {
            it(`passes ${command} through unmodified`, async () => {
                assert.deepEqual(await run(command), { outcome: undefined, command });
            });
        }

        it("blocks a command rtk denies and hands the reason to the model", async () => {
            assert.deepEqual(await run("deny"), {
                outcome: { block: true, reason: "rtk pipeline denied rm -rf" },
                command: "deny",
            });
        });

        it("leaves a non-bash tool call untouched", async () => {
            const event = { toolName: "read", input: { command: "ls" } };
            assert.equal(await fire(handlers, "tool_call", event), undefined);
            assert.equal(event.input.command, "ls");
        });

        it("does not spawn rtk again for a command already in RTK form", async () => {
            let rewriteCalls = 0;
            const counting = await loadExtension(async (command, args) => {
                if (args[1] !== "--help") rewriteCalls++;
                return rtkExec(result(0, "rtk 0.40.0"))(command, args);
            });
            const event = { toolName: "bash", input: { command: "rtk ls" } };
            assert.equal(await fire(counting.handlers, "tool_call", event), undefined);
            assert.equal(event.input.command, "rtk ls");
            assert.equal(rewriteCalls, 0, "no second rtk subprocess");
        });

        it("adds the RTK usage instructions to their own system prompt section", () => {
            const prompt: any = { systemPromptOptions: { sections: {} } };
            fire(handlers, "before_agent_start", prompt);
            assert.match(prompt.systemPromptOptions.sections.command_output, /rtk bypass/);
        });
    });
});

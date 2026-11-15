// Run: node check.mjs (Node >=22.19 supports TypeScript type stripping).
import assert from "node:assert/strict";
import extension from "./index.ts";

const result = (code, stdout = "") => ({ code, stdout, stderr: "", killed: false });
const replies = { ls: result(0, "rtk ls\n"), grep: result(3, "rtk grep\n"), cat: result(1), rm: result(2, "deny") };

const host = (handlers, version) => ({
    exec: async (_command, args) => {
        if (args[0] === "--version") return version;
        if (args[1] === "boom") throw new Error("spawn failed");
        return replies[args[1]];
    },
    on: (event, handler) => (handlers[event] = handler),
    registerCommand: () => {},
    registerEntryRenderer: () => {},
});

// Missing rtk loads nothing.
const missing = {};
await extension(host(missing, result(127)));
assert.deepEqual(missing, {});

const handlers = {};
await extension(host(handlers, result(0, "rtk 0.40.0")));

// Exit 0/3 rewrite; 1, 2 and a throwing rtk pass the command through.
for (const [command, expected] of [
    ["ls", "rtk ls"],
    ["grep", "rtk grep"],
    ["cat", "cat"],
    ["rm", "rm"],
    ["boom", "boom"],
]) {
    const event = { toolName: "bash", input: { command } };
    await handlers.tool_call(event, {});
    assert.equal(event.input.command, expected);
}

console.log("pi-rtk: all checks passed");

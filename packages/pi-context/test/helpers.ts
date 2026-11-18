import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";

// An isolated agent dir keeps the gain file and the global settings lookup deterministic.
export const agentDir = mkdtempSync(join(tmpdir(), "pi-context-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

/** A cwd that exists for the whole file; project settings live in `<dir>/.pi`. */
export const dir = mkdtempSync(join(tmpdir(), "pi-context-test-"));

export function cleanup(): void {
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
}

export function tempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

/** An ExecResult, as pi.exec returns it. */
export const result = (code: number, stdout = "") => ({ code, stdout, stderr: "", killed: false });

/** What the stubbed `rtk rewrite <command>` returns, keyed by command. */
export const rtkReplies: Record<string, any> = {
    ls: result(0, "rtk ls\n"),
    grep: result(3, "rtk grep\n"),
    cat: result(1),
    noop: result(2),
    deny: result(2, "  rtk pipeline denied rm -rf  \n"),
    killed: { ...result(0, "rtk ls\n"), killed: true },
};

/** A stub of the ExtensionAPI members the extension registers. */
export const host = (exec: (command: string, args: string[]) => Promise<any>) => {
    const handlers = new Map<string, Array<(payload: any, ctx: any) => any>>();
    const commands = new Map<string, any>();
    const pi: any = {
        exec,
        on: (event: string, handler: (payload: any, ctx: any) => any) =>
            handlers.set(event, [...(handlers.get(event) ?? []), handler]),
        registerCommand: (name: string, command: any) => commands.set(name, command),
    };
    return { handlers, commands, pi };
};

/** `pi.exec` for rtk: `probe` answers the `--help` call, `rtkReplies` answer the rewrite calls. */
export const rtkExec = (probe: any) => async (_command: string, args: string[]) => {
    if (args[1] === "--help") return probe;
    if (args[1] === "boom") throw new Error("spawn failed");
    return rtkReplies[args[1]];
};

/** Loads the extension against a fresh stub host; the default host has no rtk. */
export async function loadExtension(exec = rtkExec(result(127))) {
    const stub = host(exec);
    await extension(stub.pi);
    return stub;
}

export const fire = (
    handlers: Map<string, Array<(payload: any, ctx: any) => any>>,
    event: string,
    payload: any,
    ctx: any = {},
) => {
    let outcome: any;
    for (const handler of handlers.get(event) ?? []) outcome = handler(payload, ctx) ?? outcome;
    return outcome;
};

export type Call = [id: string, name: string, args: any];

export const turn = (calls: Call[]) => ({
    role: "assistant",
    content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
});

export const toolResult = (id: string, isError = false, details?: any) => ({
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text: "x" }],
    isError,
    details,
});

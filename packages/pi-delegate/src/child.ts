import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, type MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { answerTokens, limitOutput, textParts, usageTokens } from "./format.ts";

type Child = ChildProcessWithoutNullStreams;

/** A child message in the shape pi's chat components render. */
export type ChildMessage = MessageEndEvent["message"];
export type ChildUpdate = {
    toolCalls?: number;
    contextTokens?: number;
    /** A message the child finished; the store appends it to the job's transcript. */
    message?: ChildMessage;
};
type ChildUpdateHandler = (update: ChildUpdate) => void;

type ChildRun = {
    done: Promise<string>;
    steer: (message: string) => Promise<void>;
    swapModel: (provider: string, modelId: string, level?: string, onModelSet?: () => void) => Promise<void>;
};

/** Run one RPC child, keeping its writer serialized so backpressure and EPIPE reach the caller. */
export function runChild(
    child: Child,
    task: string,
    signal: AbortSignal | undefined,
    onUpdate?: ChildUpdateHandler,
    revive?: boolean,
): ChildRun {
    let buffer = "";
    let liveText = "";
    let toolCalls = 0;
    let stderr = "";
    let childError: string | undefined;
    let childFailure: Error | undefined;
    let aborted = false;
    let settled = false;
    let finishing = false;
    let requestId = 0;
    let writeQueue = Promise.resolve();
    const pending = new Map<
        string,
        {
            command: string;
            resolve: (data: any) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    let send!: (command: Record<string, unknown>) => Promise<any>;

    const done = new Promise<string>((resolveChild, reject) => {
        function rejectPending(error: Error) {
            for (const request of pending.values()) {
                clearTimeout(request.timer);
                request.reject(error);
            }
            pending.clear();
        }
        function finish(code: number | null, error?: Error) {
            if (settled || finishing) return;
            finishing = true;
            if (buffer) {
                const lastLine = buffer;
                buffer = "";
                parse(lastLine);
            }
            settled = true;
            if (!child.stdin.destroyed) child.stdin.end();
            signal?.removeEventListener("abort", abort);
            const result = aborted
                ? new Error("Delegate was aborted")
                : (error ??
                  childFailure ??
                  (code !== 0
                      ? new Error(childError || stderr.trim() || `Child exited with status ${code}`)
                      : undefined));
            if (result) {
                rejectPending(result);
                reject(result);
            } else if (childError) {
                rejectPending(new Error(childError));
                reject(new Error(childError));
            } else {
                rejectPending(new Error("Delegate finished before acknowledging command"));
                resolveChild(limitOutput(liveText.trim() || "(no output)"));
            }
        }
        function fail(error: Error) {
            if (settled || finishing) return;
            childFailure = error;
            child.kill("SIGTERM");
            finish(null, error);
        }
        function parse(line: string) {
            if (!line.trim()) return;
            try {
                const event = JSON.parse(line) as any;
                if (event.type === "response" && typeof event.id === "string" && pending.has(event.id)) {
                    const request = pending.get(event.id)!;
                    pending.delete(event.id);
                    clearTimeout(request.timer);
                    if (event.success === true && event.command === request.command) {
                        request.resolve(event.data);
                        return;
                    }
                    const responseError = new Error(
                        event.command === request.command
                            ? event.error || `Child rejected ${request.command}`
                            : `Child returned ${event.command || "unknown"} response for ${request.command}`,
                    );
                    request.reject(responseError);
                    if (request.command === "prompt") childFailure ??= responseError;
                    return;
                }
                switch (event.type) {
                    case "tool_execution_start": {
                        toolCalls += 1;
                        onUpdate?.({ toolCalls });
                        return;
                    }
                    case "message_update": {
                        onUpdate?.({ contextTokens: usageTokens(event.usage) });
                        return;
                    }
                    case "message_end": {
                        const message = event.message as ChildMessage;
                        let contextTokens: number | undefined;
                        if (message.role === "assistant") {
                            childError = message.errorMessage;
                            const text = textParts(message.content).join("");
                            if (text) liveText = text;
                            contextTokens = answerTokens(message);
                        }
                        onUpdate?.({ contextTokens, message });
                        return;
                    }
                    case "agent_settled":
                        // A run the child aborted itself (an extension's abort or compaction) is not the task's answer.
                        finish(0, event.aborted ? new Error("Delegate run was aborted before it finished") : undefined);
                        return;
                    case "extension_ui_request":
                        if (["select", "confirm", "input", "editor"].includes(event.method)) {
                            void enqueue({ type: "extension_ui_response", id: event.id, cancelled: true }).catch(
                                (error) => fail(error),
                            );
                        }
                        return;
                    default:
                        return;
                }
            } catch {
                // Diagnostics on stdout that are not JSON events; ignore those lines.
            }
        }
        function enqueue(command: Record<string, unknown>) {
            const line = `${JSON.stringify(command)}\n`;
            const write = writeQueue.then(
                () =>
                    new Promise<void>((resolveWrite, rejectWrite) => {
                        if (settled) return rejectWrite(childFailure ?? new Error("Delegate has finished"));
                        if (child.stdin.destroyed || !child.stdin.writable) {
                            return rejectWrite(new Error("Delegate stdin is not writable"));
                        }
                        child.stdin.write(line, (error) => (error ? rejectWrite(error) : resolveWrite()));
                    }),
            );
            writeQueue = write.catch(() => {});
            return write;
        }
        send = (command: Record<string, unknown>) => {
            const id = `delegate_${++requestId}`;
            const response = new Promise<any>((resolveResponse, rejectResponse) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    rejectResponse(new Error(`Timed out waiting for ${command.type} acknowledgement`));
                }, 30_000);
                pending.set(id, {
                    command: String(command.type),
                    resolve: resolveResponse,
                    reject: rejectResponse,
                    timer,
                });
            });
            void enqueue({ ...command, id }).catch((error) => {
                const request = pending.get(id);
                if (request) {
                    pending.delete(id);
                    clearTimeout(request.timer);
                    request.reject(error);
                }
                if (!settled && !aborted) fail(error);
            });
            return response;
        };
        function abort() {
            if (settled || aborted) return;
            aborted = true;
            void send({ type: "abort" }).catch(() => {});
            setTimeout(() => {
                if (!settled) child.kill("SIGKILL");
            }, 5000).unref();
        }

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) parse(line);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
            if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
        });
        child.stdin.on("error", fail);
        child.on("error", fail);
        child.on("close", (code: number | null) => finish(code));
        if (signal?.aborted) {
            aborted = true;
            child.kill("SIGTERM");
            finish(null);
        } else {
            signal?.addEventListener("abort", abort, { once: true });
            function prompt() {
                void send({ type: "prompt", message: task }).catch((error) => {
                    if (!settled) fail(error);
                });
            }
            if (revive) {
                // An empty transcript means the pinned session was recreated (e.g. a different cwd); prompting would lose the task.
                void send({ type: "get_state" })
                    .then((data) => {
                        if (!settled && !aborted && !data?.messageCount) {
                            fail(
                                new Error(
                                    "Revived delegate transcript is empty; the pinned session was recreated. Start a fresh delegate instead.",
                                ),
                            );
                            return;
                        }
                        prompt();
                    })
                    // A revive we cannot verify must not prompt into an unknown transcript.
                    .catch((error) => {
                        if (!settled && !aborted) fail(error);
                    });
            } else {
                prompt();
            }
        }
    });

    return {
        done,
        steer: (message) => send({ type: "steer", message }),
        // The callback lands between the two acks, so a thinking-level failure cannot hide the applied model.
        swapModel: async (provider, modelId, level, onModelSet) => {
            await send({ type: "set_model", provider, modelId });
            onModelSet?.();
            if (level !== undefined) await send({ type: "set_thinking_level", level });
        },
    };
}

/**
 * The child's persisted transcript, for a job whose messages are not in memory. A missing or
 * unreadable session seeds nothing: the job still renders, just without history.
 */
export function sessionMessages(sessionDir: string, id: string): ChildMessage[] {
    let sessionFile: string | undefined;
    try {
        // Sessions are <timestamp>_<sessionId>.jsonl; a recreated pinned session is the newest one.
        sessionFile = readdirSync(sessionDir)
            .filter((name) => name.endsWith(`_delegate-${id}.jsonl`))
            .sort()
            .at(-1);
    } catch {
        return [];
    }
    if (!sessionFile) return [];
    try {
        return SessionManager.open(join(sessionDir, sessionFile)).buildSessionContext().messages;
    } catch {
        return [];
    }
}

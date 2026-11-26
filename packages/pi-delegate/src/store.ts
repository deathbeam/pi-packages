import type { ChildMessage, ChildUpdate } from "./child.ts";
import { type JobUsage, resultPreview, toolCallDetail, usageFromMessages } from "./format.ts";
import type { IsolationState } from "./isolation.ts";

export type JobStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";
export type InspectJob = {
    id: string;
    agent: string;
    description: string;
    task: string;
    model: string;
    tools: string[];
    /** The skills pinned in the child's prompt to read first; empty means none. */
    skills?: string[];
    toolCalls: number;
    contextTokens?: number;
    contextWindow?: number;
    startedAt: number;
    endedAt?: number;
    status: JobStatus;
    /** The child's transcript, kept in memory only: its session file is the source of truth. */
    messages: ChildMessage[];
    /** The failure detail shown under a finished job's transcript. */
    detail?: string;
    isolation?: IsolationState;
    /** Usage totals captured at finish: a restored transcript can drop pre-compaction messages. */
    usage?: JobUsage;
    /** Set once an isolated job's clone was applied or discarded, so a steer revive refuses instead of rerunning in the main tree. */
    cloneClosed?: boolean;
};

export type DelegateJob = InspectJob & {
    controller: AbortController;
    steer?: (message: string) => Promise<void>;
    swapModel?: (provider: string, modelId: string, level?: string, onModelSet?: () => void) => Promise<void>;
};

export type JobStore = ReturnType<typeof createJobStore>;

const JOB_ENTRY = "delegate-job";

/** The latest delegate-job entry per id, newest first: the append-only log's current view. */
function restoredJobs(entries: readonly unknown[]): InspectJob[] {
    const seen = new Set<string>();
    const jobs: InspectJob[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type?: string; customType?: string; data?: unknown } | null;
        if (entry?.type !== "custom" || entry.customType !== JOB_ENTRY || !entry.data) continue;
        const job = entry.data as InspectJob;
        if (typeof job?.id !== "string" || seen.has(job.id)) continue;
        seen.add(job.id);
        jobs.push(job);
    }
    return jobs;
}

/** One owner for live jobs, history, and the delegate-job session entries they write. */
export function createJobStore(append: (customType: string, data: InspectJob) => void) {
    const running = new Map<string, DelegateJob>();
    const history: InspectJob[] = [];
    const listeners = new Set<() => void>();
    function notify() {
        for (const redraw of listeners) redraw();
    }
    // A session_tree rebuild restores old entries; the history keeps one row per id across finish and relaunch.
    function drop(id: string) {
        const stale = history.findIndex((item) => item.id === id);
        if (stale >= 0) history.splice(stale, 1);
    }
    function commit(entry: InspectJob) {
        drop(entry.id);
        history.unshift(entry);
        append(JOB_ENTRY, snapshot(entry));
        notify();
    }
    function find(id: string) {
        return running.get(id) ?? history.find((item) => item.id === id);
    }
    function plain(job: InspectJob) {
        const { controller, steer, swapModel, ...rest } = job as InspectJob & Partial<DelegateJob>;
        return rest;
    }
    /** The serializable form of a job: runtime handles and the transcript stay out. */
    function snapshot(job: InspectJob): InspectJob {
        return {
            ...plain(job),
            messages: [],
        };
    }

    return {
        /** Every job a view can show: live first, then history. */
        all: (): InspectJob[] => [...running.values(), ...history],
        live: (): DelegateJob[] => [...running.values()],
        find,
        snapshot,
        /** A job by id; the common "unknown delegate job" failure lives here so every tool phrases it alike. */
        findOrThrow: (id: string): InspectJob => {
            const job = find(id);
            if (!job) throw new Error(`Unknown delegate job "${id}".`);
            return job;
        },
        liveJob: (id: string) => running.get(id),
        /** Writes the launch entry a restarted parent restores from; the job joins the live set until it finishes. */
        launch: (job: DelegateJob) => {
            append(JOB_ENTRY, snapshot(job));
            drop(job.id);
            running.set(job.id, job);
        },
        record: (job: DelegateJob, update: ChildUpdate) => {
            if (job.status !== "running") return;
            let changed = false;
            if (update.toolCalls !== undefined && update.toolCalls !== job.toolCalls) {
                job.toolCalls = update.toolCalls;
                changed = true;
            }
            if (update.contextTokens !== undefined && update.contextTokens !== job.contextTokens) {
                job.contextTokens = update.contextTokens;
                changed = true;
            }
            if (update.message) {
                job.messages.push(update.message);
                changed = true;
            }
            if (changed) notify();
        },
        /** Leaves the live set and writes the completion entry; false when the job was cancelled. */
        finish: (job: DelegateJob, status: JobStatus, detail?: string): boolean => {
            // Cancellation was already acknowledged; shutdown has no UI to report into.
            if (job.controller.signal.aborted) return false;
            running.delete(job.id);
            job.status = status;
            if (detail) job.detail = detail;
            job.usage = usageFromMessages(job.messages, job.contextTokens);
            commit({ ...plain(job), messages: [], endedAt: Date.now() });
            return true;
        },
        /** Appends a corrected entry for a finished job changed after completion (isolation applied, discarded, or re-based). */
        save: (job: InspectJob) => commit(job),
        /** Rebuilds history from the branch and returns the jobs it marked interrupted. */
        restore: (branch: readonly unknown[]): InspectJob[] => {
            history.length = 0;
            // Skip live jobs' launch entries (the live set renders them); copy so session entries stay append-only.
            const restored = restoredJobs(branch)
                .filter((job) => !running.has(job.id))
                .map((job) => {
                    // Drop the legacy activity field: the child's session file owns the transcript.
                    const { activity: _legacy, ...rest } = job as InspectJob & { activity?: unknown };
                    return { ...rest, messages: [] };
                });
            // A restored running job no live job owns means the parent crashed; the child exits on its own when
            // the parent's stdin pipe closes, so only the job state needs fixing.
            const interrupted = restored.filter((job) => job.status === "running");
            for (const job of interrupted) {
                job.status = "interrupted";
                job.endedAt = Date.now();
                append(JOB_ENTRY, job);
            }
            history.push(...restored);
            return interrupted;
        },
        clear: () => {
            running.clear();
            history.length = 0;
            listeners.clear();
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        notify,
    };
}

/** The job's latest tool call and its result, once the result arrives. */
export function lastToolCall(job: InspectJob): {
    tool?: { name: string; detail: string };
    result?: { text?: string; isError?: boolean };
} {
    for (let i = job.messages.length - 1; i >= 0; i--) {
        const message = job.messages[i]!;
        if (message.role !== "assistant") continue;
        for (let j = message.content.length - 1; j >= 0; j--) {
            const part = message.content[j]!;
            if (part.type !== "toolCall") continue;
            const result = job.messages.find(
                (m): m is Extract<ChildMessage, { role: "toolResult" }> =>
                    m.role === "toolResult" && m.toolCallId === part.id,
            );
            return {
                tool: { name: part.name, detail: toolCallDetail(part.name, part.arguments) },
                result: result ? { text: resultPreview(result), isError: result.isError } : undefined,
            };
        }
    }
    return {};
}

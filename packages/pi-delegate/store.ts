import type { ChildActivity, ChildUpdate } from "./child.ts";
import type { IsolationState } from "./isolation.ts";

export type JobStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";
export type InspectJob = {
    id: string;
    agent: string;
    description: string;
    task: string;
    model: string;
    tools: string[];
    toolCalls: number;
    contextTokens?: number;
    contextWindow?: number;
    startedAt: number;
    endedAt?: number;
    status: JobStatus;
    activity: ChildActivity[];
    isolation?: IsolationState;
    /** Set once an isolated job's clone was applied or discarded, so a steer revive refuses instead of rerunning in the main tree. */
    cloneClosed?: boolean;
};

export type DelegateJob = InspectJob & {
    lastTool?: string;
    lastDetail?: string;
    lastResult?: string;
    controller: AbortController;
    steer?: (message: string) => Promise<void>;
    swapModel?: (provider: string, modelId: string, level?: string, onModelSet?: () => void) => Promise<void>;
};

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
    const notify = () => {
        for (const redraw of listeners) redraw();
    };
    // A session_tree rebuild restores old entries; the history keeps one row per id across finish and relaunch.
    const drop = (id: string) => {
        const stale = history.findIndex((item) => item.id === id);
        if (stale >= 0) history.splice(stale, 1);
    };
    const find = (id: string) => running.get(id) ?? history.find((item) => item.id === id);
    /** The serializable form of a job: runtime handles and the latest tool detail stay out. */
    const snapshot = (job: InspectJob): InspectJob => {
        const { controller, steer, swapModel, lastTool, lastDetail, lastResult, ...plain } = job as InspectJob &
            Partial<DelegateJob>;
        // Copy activity: the live job keeps appending to its own array after the launch snapshot.
        return { ...plain, activity: [...plain.activity] };
    };
    const addActivity = (job: DelegateJob, activity: ChildActivity) => {
        const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
        job.activity.push(
            activity.kind === "assistant" || activity.kind === "user"
                ? activity
                : {
                      ...activity,
                      text: normalize(activity.text),
                      detail: activity.detail && normalize(activity.detail),
                  },
        );
        notify();
    };

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
        /** Writes the launch entry a restarted parent restores from; background jobs join the live set. */
        launch: (job: DelegateJob, background: boolean) => {
            append(JOB_ENTRY, snapshot(job));
            drop(job.id);
            if (background) running.set(job.id, job);
        },
        record: (job: DelegateJob, update: ChildUpdate) => {
            if (job.status !== "running") return;
            if (update.toolCalls !== undefined) job.toolCalls = update.toolCalls;
            if (update.lastTool !== undefined) job.lastTool = update.lastTool;
            if (update.lastDetail !== undefined) job.lastDetail = update.lastDetail;
            if (update.lastResult !== undefined) job.lastResult = update.lastResult;
            if (update.contextTokens !== undefined) job.contextTokens = update.contextTokens;
            // Activity feeds the live views; a foreground run reports through its tool result instead.
            if (update.activity && running.has(job.id)) addActivity(job, update.activity);
        },
        /** Leaves the live set and writes the completion entry; false when the job was cancelled. */
        finish: (job: DelegateJob, status: JobStatus, detail?: string): boolean => {
            // Cancellation was already acknowledged; shutdown has no UI to report into.
            if (job.controller.signal.aborted) return false;
            running.delete(job.id);
            job.status = status;
            if (detail) addActivity(job, { kind: "status", text: detail });
            const entry: InspectJob = { ...snapshot(job), endedAt: Date.now() };
            drop(entry.id);
            history.unshift(entry);
            append(JOB_ENTRY, entry);
            notify();
            return true;
        },
        /** Appends a corrected entry for a finished job changed after completion (isolation applied, discarded, or re-based). */
        save: (job: InspectJob) => {
            drop(job.id);
            history.unshift(job);
            append(JOB_ENTRY, snapshot(job));
            notify();
        },
        /** Rebuilds history from the branch and returns the jobs it marked interrupted. */
        restore: (branch: readonly unknown[]): InspectJob[] => {
            history.length = 0;
            // Skip live jobs' launch entries (the live set renders them); copy so session entries stay append-only.
            const restored = restoredJobs(branch)
                .filter((job) => !running.has(job.id))
                .map((job) => ({ ...job }));
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
        /** Drops all jobs and view subscriptions; called on session shutdown. */
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

export type JobStore = ReturnType<typeof createJobStore>;

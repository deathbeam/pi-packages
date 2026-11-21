import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";
import { createJobStore, lastToolCall } from "../src/store.ts";
import { cleanup, jobEntry } from "./helpers.ts";

const branch = (jobs: any[]) => jobs.map((job) => ({ type: "custom", customType: "delegate-job", data: job }));
const restoreStore = createJobStore(() => {});
const restoredIds = (entries: any[]) => {
    restoreStore.restore(entries);
    return restoreStore.all().map(({ id, status }) => ({ id, status }));
};

afterAll(cleanup);

describe("job store restore", () => {
    // Crash recovery: entry dedupe runs through the store's restore seam.
    // Last entry wins per id and the order stays newest first, so a job shows once with its latest status.
    it("dedupes entries by id with the newest status", () => {
        assert.deepEqual(
            restoredIds(branch([jobEntry("a", "running"), jobEntry("b", "running"), jobEntry("a", "done")])),
            [
                { id: "a", status: "done" },
                { id: "b", status: "interrupted" },
            ],
        );
    });

    // A restored "running" job no live job owns is a crash orphan, so restore marks it interrupted.
    it("marks an orphaned running job interrupted", () => {
        assert.deepEqual(restoredIds(branch([jobEntry("a", "running"), jobEntry("a", "interrupted")])), [
            { id: "a", status: "interrupted" },
        ]);
    });

    it("ignores entries that are not delegate jobs", () => {
        assert.deepEqual(
            restoredIds([{ type: "custom", customType: "other", data: jobEntry("a", "running") }, { type: "message" }]),
            [],
        );
    });
});

describe("lastToolCall", () => {
    // The widget's last tool row comes straight from the transcript.
    const toolMessages = [
        {
            role: "assistant",
            content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts" } }],
        },
        {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "read",
            content: [{ type: "text", text: "file loaded\nmore" }],
            isError: false,
        },
    ];

    it("reads the call and result from the transcript", () => {
        assert.deepEqual(lastToolCall({ messages: toolMessages } as any), {
            tool: { name: "read", detail: "src/a.ts" },
            result: { text: "file loaded", isError: false },
        });
    });

    it("returns nothing for an empty transcript", () => {
        assert.deepEqual(lastToolCall({ messages: [] } as any), {});
    });
});

describe("job finish", () => {
    it("captures usage totals and context tokens", () => {
        const saved: any[] = [];
        const store = createJobStore((_type, data) => saved.push(data));
        const job: any = {
            ...jobEntry("a", "running"),
            contextTokens: 12,
            controller: new AbortController(),
            messages: [
                {
                    role: "assistant",
                    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.5 } },
                },
            ],
        };
        store.launch(job);
        assert.equal(store.finish(job, "done"), true);
        assert.deepEqual(job.usage, {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.5,
            cacheHit: 0,
            contextTokens: 12,
        });
        assert.deepEqual(saved.at(-1)?.usage, job.usage);
    });
});

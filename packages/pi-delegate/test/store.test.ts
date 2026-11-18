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

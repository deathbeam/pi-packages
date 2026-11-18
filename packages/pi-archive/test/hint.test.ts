import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import { archiveCtx, beforeAgentStart, projA, removeArchive, tool } from "./helpers.ts";

afterAll(removeArchive);

function hintFor(entries: any[] = [], file?: string): Promise<string | undefined> {
    return beforeAgentStart({}, archiveCtx(entries, file ? { file } : {})).then((r: any) => r?.message?.content);
}

describe("before_agent_start hint", () => {
    it("stays silent once the transcript has messages", async () => {
        assert.equal(await hintFor([{ type: "message" }]), undefined);
        assert.equal(await hintFor([{ type: "custom_message", customType: "archive-memory" }]), undefined);
    });

    it("lists recent sessions newest-first, titled with their first user message", async () => {
        const hint = await hintFor();
        assert.match(hint ?? "", /^Recent sessions in this project/);
        assert.match(
            hint ?? "",
            /- 2026-09-08: \(no user message\)\n- 2026-09-05: late title\n- 2026-09-01: fix the jwt auth refresh bug/,
        );
    });

    it("includes the live session when its file is not the current one", async () => {
        const lines = (await hintFor([], path.join(projA, "new-session.jsonl")))?.split("\n");
        assert.deepEqual(lines, [
            "Recent sessions in this project (first user messages; use search_archive for full transcripts):",
            "- 2026-09-08: (no user message)",
            "- 2026-09-05: late title",
            "- 2026-09-03: jwt again but this session is the live one",
            "- 2026-09-01: fix the jwt auth refresh bug",
        ]);
    });

    it("still fires when another extension's custom message starts the run", async () => {
        // The hint is injected on the session's first run whatever started it; gating on messageType "user" would
        // drop it when the user steers into that run instead of starting a new one.
        const event = {
            type: "before_agent_start",
            messageType: "custom",
            message: { customType: "report", content: "x" },
        };
        assert.match((await beforeAgentStart(event, archiveCtx([])))?.message?.content ?? "", /^Recent sessions/);
    });
});

describe("retrieval rule", () => {
    it("lives in both the system guidelines and the tool schema", () => {
        assert.match(tool.promptGuidelines?.join("\n") ?? "", /compaction.*search_archive/is);
        assert.match(tool.description, /compaction.*search_archive/is);
    });
});

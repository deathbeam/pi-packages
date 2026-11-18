import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import piArchive from "../index.ts";

// Archive root shaped like pi's: one encoded-cwd dir per project, one JSONL file per session.
export const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-check-"));
export const projA = path.join(root, "--home-user-git-projA--");
export const projB = path.join(root, "--home-user-git-projB--");
const projShort = path.join(root, "--home-user--");
for (const dir of [projA, projB, projShort]) fs.mkdirSync(dir);

/** One JSON object per line with a trailing newline, the way pi writes sessions. */
function writeJsonl(file: string | number, entries: unknown[]): void {
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

export const aaaa = path.join(projA, "2026-09-01T00-00-00-000Z_aaaa.jsonl");
writeJsonl(aaaa, [
    { type: "session", version: 3, id: "aaaa" },
    {
        type: "message",
        id: "m1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "fix the jwt auth refresh bug" }] },
    },
    {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "irrelevant" },
                { type: "text", text: "the token expiry was 5 minutes, raised to 30" },
            ],
        },
    },
    { type: "compaction", id: "c1", parentId: "m2", summary: "Fixed jwt refresh; expiry 5->30 min" },
    {
        type: "message",
        id: "m3",
        parentId: "m2",
        message: {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "bash",
            content: [{ type: "text", text: "Error EACCES: jwt key file unreadable" }],
        },
    },
    // Entries that must never match: search_archive's own results, system messages, non-message entries.
    {
        type: "message",
        message: {
            role: "toolResult",
            toolName: "search_archive",
            content: [{ type: "text", text: "derived selfskip hit" }],
        },
    },
    { type: "model_change", model: "modelskip" },
    { type: "message", message: { role: "system", content: "confidential systemskip memo" } },
]);

writeJsonl(path.join(projB, "2026-09-02T00-00-00-000Z_bbbb.jsonl"), [
    { type: "session", version: 3, id: "bbbb" },
    {
        type: "message",
        id: "m1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "unrelated work on the renderer" }] },
    },
]);

export const currentFile = path.join(projA, "2026-09-03T00-00-00-000Z_cccc.jsonl");
writeJsonl(currentFile, [
    { type: "session", version: 3, id: "cccc" },
    {
        type: "message",
        id: "m1",
        parentId: null,
        message: { role: "user", content: "jwt again but this session is the live one" },
    },
    ...Array.from({ length: 2 }, (_u, i) => ({
        type: "message",
        message: { role: "user", content: `signal intent ${i}` },
    })),
    ...Array.from({ length: 5 }, (_u, i) => ({
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text: `signal noise ${i}` }] },
    })),
]);

// Literal U+2028/U+2029 inside a JSON string must not split the line.
writeJsonl(path.join(projB, "2026-09-04T00-00-00-000Z_dddd.jsonl"), [
    { type: "message", message: { role: "user", content: "literal\u2028and\u2029separators plain string" } },
]);

// The oversized first record spans read chunks and must be skipped, not dropped.
const largeFile = path.join(projA, "2026-09-05T00-00-00-000Z_eeee.jsonl");
const largeFd = fs.openSync(largeFile, "w");
fs.writeFileSync(largeFd, Buffer.alloc(16 * 1024 * 1024 + 128 * 1024, 120) + "\n");
writeJsonl(largeFd, [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "largeentry survives" }] } },
    { type: "message", message: { role: "user", content: "late title" } },
]);
fs.closeSync(largeFd);

export const ffff = path.join(projB, "2026-09-06T00-00-00-000Z_ffff.jsonl");
writeJsonl(ffff, [
    { type: "session", version: 3, id: "ffff" },
    ...Array.from({ length: 6 }, (_u, i) => ({
        type: "message",
        message: { role: "user", content: `capmark hit number ${i}` },
    })),
]);

writeJsonl(path.join(projShort, "2026-09-07T00-00-00-000Z_gggg.jsonl"), [
    { type: "session", version: 3, id: "gggg" },
    { type: "message", message: { role: "user", content: "zephyr works in short projects" } },
    { type: "message", message: { role: "user", content: "x".repeat(400) + "needle" + "y".repeat(400) } },
    { type: "message", message: { role: "user", content: "a null query is searched" } },
]);

// No user message: the recent-sessions hint falls back to "(no user message)".
writeJsonl(path.join(projA, "2026-09-08T00-00-00-000Z_hhhh.jsonl"), [
    { type: "session", version: 3, id: "hhhh" },
    {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "assistant only entry" }] },
    },
]);

// mtimes drive newest-first ranking; make them match the dates in the file names.
for (const dir of [projA, projB, projShort]) {
    for (const name of fs.readdirSync(dir)) {
        const at = new Date(name.slice(0, 10));
        fs.utimesSync(path.join(dir, name), at, at);
    }
}

// Everything below goes through the only public seams: the registered tool and the before_agent_start hook.
let tool: any;
let beforeAgentStart: any;
await piArchive({
    registerTool: (t: any) => (tool = t),
    on: (event: string, handler: any) => {
        if (event === "before_agent_start") beforeAgentStart = handler;
    },
} as any);
export { beforeAgentStart, tool };

export function archiveCtx(
    entries: any[] = [],
    { dir = projA, file = currentFile }: { dir?: string; file?: string } = {},
) {
    return {
        sessionManager: {
            getEntries: () => entries,
            getSessionDir: () => dir,
            getSessionFile: () => file,
        },
    };
}

export async function search(params: any, ctx: any = archiveCtx(), signal?: AbortSignal) {
    const r = await tool.execute("id", params, signal, undefined, ctx);
    return { text: r.content[0].text as string, details: r.details };
}

export function hitLines(text: string): string[] {
    return text.split("\n").filter((l) => l.startsWith("- "));
}

export async function hits(params: any): Promise<string[]> {
    return hitLines((await search(params)).text);
}

export function deny(code: string) {
    return Object.assign(new Error(`${code}: denied`), { code });
}

export function removeArchive(): void {
    fs.rmSync(root, { recursive: true, force: true });
}

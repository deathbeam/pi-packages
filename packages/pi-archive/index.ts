/** Search Pi's persisted JSONL transcripts, including compacted-away entries. */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const DEFAULT_PER_SESSION = 3;
const MAX_PER_SESSION = 1000;
const MAX_OFFSET = 10000;
const MAX_SEARCH_LIMIT = 100;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface ArchiveMatch {
    file: string;
    project: string; // short project label, e.g. "git/dotfiles"
    date: string; // from file name, e.g. "2026-09-07"
    role: string;
    excerpt: string;
    currentSession: boolean;
    sameProject: boolean;
}

export interface SearchOptions {
    currentFile?: string;
    currentDir?: string;
    sessionFilter?: string; // substring matched against the encoded cwd dir name
    limit?: number;
    perSession?: number;
    offset?: number;
}

function parseJsonLine(line: string): any | null {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

export function projectLabel(dirName: string): string {
    const parts = dirName.replace(/^-+|-+$/g, "").split("-");
    return parts.length <= 2 ? parts.join("/") : parts.slice(-2).join("/");
}

export function fileDate(fileName: string): string {
    return fileName.slice(0, 10);
}

export function entryText(entry: unknown): { role: string; text: string } | null {
    const e = entry as Record<string, any>;
    const content = e?.message?.content;
    if (
        e?.type === "message" &&
        !(e.message.role === "toolResult" && e.message.toolName === "search_archive") &&
        (Array.isArray(content) || (e.message.role === "user" && typeof content === "string"))
    ) {
        const text =
            typeof content === "string"
                ? content
                : content
                      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                      .map((c: any) => c.text)
                      .join("\n");
        if (!text) return null;
        return { role: String(e.message.role ?? "?"), text };
    }
    if (e?.type === "compaction" && typeof e.summary === "string") {
        return { role: "summary", text: e.summary };
    }
    return null;
}

/** LF-only JSONL: readline also splits literal U+2028/U+2029 inside JSON strings. */
async function scanJsonLines(
    file: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
    onLine: (line: string) => boolean,
): Promise<{ bytes: number; incomplete: boolean; oversizedLines: number }> {
    const empty = { bytes: 0, incomplete: false, oversizedLines: 0 };
    if (signal?.aborted || maxBytes <= 0) return { ...empty, incomplete: maxBytes <= 0 };

    let size: number;
    try {
        size = (await fs.promises.stat(file)).size;
    } catch {
        return { ...empty, incomplete: true };
    }
    if (size === 0) return empty;

    const stream = fs.createReadStream(file, {
        start: 0,
        end: Math.min(size, maxBytes) - 1,
        encoding: "utf8",
        highWaterMark: READ_CHUNK_BYTES,
    });
    let bytes = 0;
    let pending = "";
    let pendingBytes = 0;
    let skippingLine = false;
    let oversizedLines = 0;
    let stopped = false;

    const consume = (text: string): boolean => {
        let start = 0;
        while (start < text.length) {
            const newline = text.indexOf("\n", start);
            const end = newline === -1 ? text.length : newline + 1;
            if (skippingLine) {
                if (newline !== -1) skippingLine = false;
            } else {
                const part = text.slice(start, end);
                pending += part;
                pendingBytes += Buffer.byteLength(part);
                if (pendingBytes > MAX_LINE_BYTES) {
                    oversizedLines++;
                    pending = "";
                    pendingBytes = 0;
                    skippingLine = newline === -1;
                } else if (newline !== -1) {
                    if (!onLine(pending.slice(0, -1))) return false;
                    pending = "";
                    pendingBytes = 0;
                }
            }
            if (newline === -1) return true;
            start = end;
        }
        return true;
    };

    try {
        for await (const chunk of stream) {
            if (signal?.aborted) {
                stopped = true;
                break;
            }
            const text = chunk as string;
            bytes += Buffer.byteLength(text);
            if (!consume(text)) {
                stopped = true;
                break;
            }
        }
        if (!stopped && !signal?.aborted && pending && !skippingLine) onLine(pending);
        let incomplete = size > maxBytes;
        if (!incomplete && !stopped && !signal?.aborted) {
            try {
                incomplete = (await fs.promises.stat(file)).size > bytes;
            } catch {
                incomplete = true;
            }
        }
        return { bytes, incomplete, oversizedLines };
    } catch {
        return { bytes, incomplete: true, oversizedLines };
    }
}

export function parseTerms(query: string): string[] {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesAll(text: string, terms: string[]): boolean {
    const lower = text.toLowerCase();
    return terms.every((t) => lower.includes(t));
}

export function excerptAround(text: string, terms: string[], radius = 150): string {
    const lower = text.toLowerCase();
    let idx = -1;
    for (const t of terms) {
        const i = lower.indexOf(t);
        if (i >= 0 && (idx === -1 || i < idx)) idx = i;
    }
    const start = idx === -1 ? 0 : Math.max(0, idx - radius);
    const end = idx === -1 ? radius * 2 : idx + radius;
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/** Rank the current session first, then this project, then other projects newest-first. */
export async function searchSessions(
    root: string,
    query: string,
    opts: SearchOptions = {},
    signal?: AbortSignal,
    onProgress?: (filesScanned: number, matches: number) => void,
): Promise<{
    matches: ArchiveMatch[];
    bytesScanned: number;
    filesScanned: number;
    truncated: boolean;
    limitReached?: boolean;
    scanIncomplete?: boolean;
    perSession?: number;
    offset?: number;
}> {
    const terms = parseTerms(query);
    if (
        opts.limit !== undefined &&
        (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_SEARCH_LIMIT)
    ) {
        throw new RangeError(`limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}`);
    }
    if (
        opts.perSession !== undefined &&
        (!Number.isSafeInteger(opts.perSession) || opts.perSession < 1 || opts.perSession > MAX_PER_SESSION)
    ) {
        throw new RangeError(`perSession must be an integer from 1 to ${MAX_PER_SESSION}`);
    }
    if (
        opts.offset !== undefined &&
        (!Number.isSafeInteger(opts.offset) || opts.offset < 0 || opts.offset > MAX_OFFSET)
    ) {
        throw new RangeError(`offset must be an integer from 0 to ${MAX_OFFSET}`);
    }
    if (terms.length === 0) return { matches: [], bytesScanned: 0, filesScanned: 0, truncated: false };
    const limit = opts.limit ?? 20;
    const perSession = opts.perSession ?? DEFAULT_PER_SESSION;
    const offset = opts.offset ?? 0;
    const filter = opts.sessionFilter?.toLowerCase();
    const files: { file: string; dir: string; name: string; mtime: number }[] = [];
    let rootEntries: fs.Dirent[];
    try {
        rootEntries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (err) {
        // A missing archive is normal; other errors must not look like clean misses.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
        return { matches: [], bytesScanned: 0, filesScanned: 0, truncated: false };
    }
    let incompleteDiscovery = false;
    for (const entry of rootEntries) {
        if (signal?.aborted) break;
        if (!entry.isDirectory()) continue;
        const dirName = entry.name;
        if (filter && !dirName.toLowerCase().includes(filter)) continue;
        const dir = path.join(root, dirName);
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") incompleteDiscovery = true;
            continue;
        }
        for (const fileEntry of entries) {
            if (signal?.aborted) break;
            if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
            const file = path.join(dir, fileEntry.name);
            try {
                files.push({ file, dir: dirName, name: fileEntry.name, mtime: (await fs.promises.stat(file)).mtimeMs });
            } catch (err) {
                if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") incompleteDiscovery = true;
            }
        }
    }
    if (signal?.aborted) return { matches: [], bytesScanned: 0, filesScanned: 0, truncated: true };

    const currentDirName = opts.currentDir ? path.basename(opts.currentDir) : undefined;
    const rank = (f: (typeof files)[number]) =>
        f.file === opts.currentFile ? 0 : currentDirName && f.dir === currentDirName ? 1 : 2;
    files.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);

    const matches: ArchiveMatch[] = [];
    // ponytail: live offsets can shift as sessions grow; use entry-ID cursors if paging must be exact.
    let skipped = 0;
    let bytes = 0;
    let filesScanned = 0;
    let scanIncomplete = incompleteDiscovery;
    let limitReached = false;
    for (const { file, dir, name } of files) {
        if (signal?.aborted || bytes >= MAX_TOTAL_BYTES) {
            scanIncomplete = true;
            break;
        }
        onProgress?.(filesScanned, matches.length);
        // ponytail: newest hits require scanning each file; index offsets if archive searches get slow.
        const fileMessages: ArchiveMatch[] = [];
        const fileTools: ArchiveMatch[] = [];
        const scan = await scanJsonLines(file, MAX_TOTAL_BYTES - bytes, signal, (line) => {
            if (!line || !terms.some((t) => line.toLowerCase().includes(t))) return true;
            const parsed = parseJsonLine(line);
            if (!parsed) return true;
            const et = entryText(parsed);
            if (!et || !matchesAll(et.text, terms)) return true;
            const bucket = et.role === "toolResult" ? fileTools : fileMessages;
            bucket.push({
                file,
                project: projectLabel(dir),
                date: fileDate(name),
                role: et.role,
                excerpt: excerptAround(et.text, terms),
                currentSession: file === opts.currentFile,
                sameProject: currentDirName !== undefined && dir === currentDirName,
            });
            if (bucket.length > perSession) bucket.shift();
            return true;
        });
        bytes += scan.bytes;
        filesScanned++;
        // ponytail: prefer dialogue with one tool hit; add relevance ranking if noisy matches persist.
        const keepMessages = fileTools.length && perSession > 1 ? perSession - 1 : perSession;
        const selected = fileMessages.slice(-keepMessages).reverse();
        const toolSlots = perSession - selected.length;
        if (toolSlots) selected.push(...fileTools.slice(-toolSlots).reverse());
        for (const hit of selected) {
            if (skipped < offset) skipped++;
            else if (matches.length < limit) matches.push(hit);
        }
        if (signal?.aborted || scan.incomplete) {
            scanIncomplete = true;
            break;
        }
        if (scan.oversizedLines > 0) scanIncomplete = true;
        if (matches.length >= limit) {
            limitReached = true;
            break;
        }
    }
    return {
        matches,
        bytesScanned: bytes,
        filesScanned,
        truncated: scanIncomplete || limitReached,
        limitReached,
        scanIncomplete,
        perSession,
        offset,
    };
}

export async function firstUserTitle(file: string, maxLen = 120): Promise<string | null> {
    let title: string | null = null;
    await scanJsonLines(file, Number.MAX_SAFE_INTEGER, undefined, (line) => {
        const et = entryText(parseJsonLine(line));
        if (et?.role !== "user" || !et.text.trim()) return true;
        title = et.text.length > maxLen ? et.text.slice(0, maxLen) + "…" : et.text;
        return false;
    });
    return title;
}

/** Recent session files in a project dir (encoded cwd), newest first. */
export function recentSessions(
    sessionDir: string,
    excludeFile: string | undefined,
    count: number,
): { file: string; name: string }[] {
    let names: string[];
    try {
        names = fs.readdirSync(sessionDir).filter((n) => n.endsWith(".jsonl"));
    } catch {
        return [];
    }
    const out: { file: string; name: string; mtime: number }[] = [];
    for (const name of names) {
        const file = path.join(sessionDir, name);
        if (file === excludeFile) continue;
        try {
            out.push({ file, name, mtime: fs.statSync(file).mtimeMs });
        } catch {
            /* skip */
        }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, count).map(({ file, name }) => ({ file, name }));
}

export function formatResults(query: string, result: Awaited<ReturnType<typeof searchSessions>>): string {
    const notes = [
        result.limitReached ? "Result limit reached; increase offset to check for more." : "",
        result.truncated && (!result.limitReached || result.scanIncomplete)
            ? "Search incomplete; narrow the search or check archive access."
            : "",
    ].filter(Boolean);
    const note = notes.length ? `\n(${notes.join(" ")})` : "";
    if (result.matches.length === 0) {
        return `No matches for "${query}"${result.offset ? ` after offset ${result.offset}` : ""} in ${result.filesScanned} scanned session files.${note}`;
    }
    const blocks: string[] = [];
    let lastFile = "";
    for (const m of result.matches) {
        if (m.file !== lastFile) {
            blocks.push(
                `${m.file}\n[${m.currentSession ? "this session" : m.sameProject ? "other session in this project" : m.project} | ${m.date}]`,
            );
            lastFile = m.file;
        }
        blocks[blocks.length - 1] += `\n- ${m.role}: ${m.excerpt.replace(/\s+/g, " ")}`;
    }
    return `Found ${result.matches.length} match(es) for "${query}"${result.offset ? ` at offset ${result.offset}` : ""} — at most ${result.perSession ?? DEFAULT_PER_SESSION} per session file (read or grep the file for more):\n\n${blocks.join("\n\n")}${note}`;
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "search_archive",
        label: "Search archive",
        description:
            "Search raw Pi transcripts from this session and older sessions, including messages compacted away. " +
            "After compaction, if the summary lacks a detail needed for the task, use search_archive before guessing. " +
            "Results identify this session, another session in this project, or another project; old hits may be stale, so verify against current context or files.",
        promptSnippet: "Search raw Pi transcripts from this and older sessions, including messages compacted away",
        promptGuidelines: [
            "After compaction, if the summary lacks a detail needed for the current task (exact code, output, error, or decision), use search_archive before guessing; verify old hits against current files.",
        ],
        parameters: Type.Object({
            query: Type.String({ description: "Search terms; all must appear (case-insensitive)" }),
            session: Type.Optional(
                Type.String({ description: "Only search sessions whose project path contains this, e.g. 'dotfiles'" }),
            ),
            limit: Type.Optional(
                Type.Integer({
                    minimum: 1,
                    maximum: MAX_SEARCH_LIMIT,
                    description: `Max matches (default 20, max ${MAX_SEARCH_LIMIT})`,
                }),
            ),
            perSession: Type.Optional(
                Type.Integer({
                    minimum: 1,
                    maximum: MAX_PER_SESSION,
                    description: `Max hits per session file (default ${DEFAULT_PER_SESSION}, max ${MAX_PER_SESSION}); raise for more hits in one session`,
                }),
            ),
            offset: Type.Optional(
                Type.Integer({
                    minimum: 0,
                    maximum: MAX_OFFSET,
                    description: `Skip ranked hits across sessions (default 0, max ${MAX_OFFSET}); keep perSession unchanged when paging. New messages can shift offsets.`,
                }),
            ),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const sessionDir = ctx.sessionManager.getSessionDir();
            const root = path.dirname(sessionDir);
            const result = await searchSessions(
                root,
                params.query,
                {
                    currentFile: ctx.sessionManager.getSessionFile(),
                    currentDir: sessionDir,
                    sessionFilter: params.session,
                    limit: params.limit,
                    perSession: params.perSession,
                    offset: params.offset,
                },
                signal,
                (files, hits) =>
                    onUpdate?.({
                        content: [{ type: "text", text: `Scanning archive… ${files} files, ${hits} match(es) so far` }],
                        details: {},
                    }),
            );
            return {
                content: [{ type: "text", text: formatResults(params.query, result) }],
                details: {
                    matchCount: result.matches.length,
                    filesScanned: result.filesScanned,
                    truncated: result.truncated,
                },
            };
        },
    });

    pi.on("before_agent_start", async (_event, ctx) => {
        if (
            ctx.sessionManager
                .getEntries()
                .some((e) => e.type === "message" || (e.type === "custom_message" && e.customType === "archive-memory"))
        )
            return;
        const sessionDir = ctx.sessionManager.getSessionDir();
        const current = ctx.sessionManager.getSessionFile();
        const recent = recentSessions(sessionDir, current, 5);
        if (recent.length === 0) return;
        const titles = await Promise.all(recent.map(({ file }) => firstUserTitle(file)));
        const lines = recent.map(({ name }, i) => `- ${fileDate(name)}: ${titles[i] ?? "(no user message)"}`);
        return {
            message: {
                customType: "archive-memory",
                content: `Recent sessions in this project (first user messages; use search_archive for full transcripts):\n${lines.join("\n")}`,
                display: false,
            },
        };
    });
}

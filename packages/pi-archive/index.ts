/** Search Pi's persisted JSONL transcripts, including compacted-away entries. */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ArchiveMatch {
    file: string;
    project: string; // short project label, e.g. "git/dotfiles"
    date: string; // from file name, e.g. "2026-09-07"
    role: string;
    excerpt: string;
    currentSession: boolean;
    sameProject: boolean;
}

interface SearchOptions {
    currentFile?: string;
    currentDir?: string;
    sessionFilter?: string; // substring matched against the encoded cwd dir name
    limit?: number;
    perSession?: number;
    offset?: number;
}

interface SearchResult {
    matches: ArchiveMatch[];
    filesScanned: number;
    filesTotal: number;
    truncated: boolean;
    limitReached?: boolean;
    scanIncomplete?: boolean;
    perSession?: number;
    offset?: number;
}

const DEFAULT_PER_SESSION = 3;
const MAX_PER_SESSION = 1000;
const MAX_OFFSET = 10000;
const MAX_SEARCH_LIMIT = 100;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const EXCERPT_RADIUS = 150;
const TITLE_MAX_CHARS = 120;
const COLLAPSED_LINES = 10;
const OPTION_BOUNDS = [
    { name: "limit", min: 1, max: MAX_SEARCH_LIMIT },
    { name: "perSession", min: 1, max: MAX_PER_SESSION },
    { name: "offset", min: 0, max: MAX_OFFSET },
] as const;

function parseJsonLine(line: string): unknown {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

function projectLabel(dirName: string): string {
    const parts = dirName.replace(/^-+|-+$/g, "").split("-");
    return parts.length <= 2 ? parts.join("/") : parts.slice(-2).join("/");
}

function fileDate(fileName: string): string {
    return fileName.slice(0, 10);
}

function entryText(entry: unknown): { role: string; text: string } | null {
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

/** Case-insensitive gate for a term JSON.stringify writes verbatim; null when only parsing can decide. */
function termPattern(term: string): RegExp | null {
    // Quotes and backslashes are escaped on disk; non-ASCII folds differently under /i. Both skip the gate.
    return /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/.test(term)
        ? new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
        : null;
}

/** LF-only JSONL: readline also splits literal U+2028/U+2029 inside JSON strings. */
async function scanJsonLines(
    file: string,
    signal: AbortSignal | undefined,
    onLine: (line: string) => boolean,
): Promise<{ stopped: boolean; oversizedLines: number }> {
    let pending = "";
    let pendingBytes = 0;
    let skippingLine = false;
    let oversizedLines = 0;
    let stopped = false;

    try {
        const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: READ_CHUNK_BYTES });
        for await (const chunk of stream) {
            if (signal?.aborted) {
                stopped = true;
                break;
            }
            const text = chunk as string;
            let start = 0;
            for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
                if (skippingLine) skippingLine = false;
                else if (!onLine(pending + text.slice(start, newline))) {
                    stopped = true;
                    break;
                }
                pending = "";
                pendingBytes = 0;
                start = newline + 1;
            }
            if (stopped) break;
            const tail = text.slice(start);
            pending += tail;
            pendingBytes += Buffer.byteLength(tail);
            if (pendingBytes > MAX_LINE_BYTES) {
                oversizedLines++;
                pending = "";
                pendingBytes = 0;
                skippingLine = true;
            }
        }
        if (!stopped && !signal?.aborted && pending && !skippingLine) onLine(pending);
        return { stopped: stopped || (signal?.aborted ?? false), oversizedLines };
    } catch {
        return { stopped: true, oversizedLines };
    }
}

function matchesAll(text: string, terms: string[]): boolean {
    const lower = text.toLowerCase();
    return terms.every((t) => lower.includes(t));
}

function excerptAround(text: string, terms: string[]): string {
    const lower = text.toLowerCase();
    let idx = -1;
    for (const t of terms) {
        const i = lower.indexOf(t);
        if (i >= 0 && (idx === -1 || i < idx)) idx = i;
    }
    // Callers only reach here after matchesAll, so every term is present and idx >= 0.
    const start = Math.max(0, idx - EXCERPT_RADIUS);
    const end = idx + EXCERPT_RADIUS;
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/** Rank the current session first, then this project, then other projects newest-first. */
async function searchSessions(
    root: string,
    query: string,
    opts: SearchOptions = {},
    signal?: AbortSignal,
    onProgress?: (filesScanned: number, matches: number) => void,
): Promise<SearchResult> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const { name, min, max } of OPTION_BOUNDS) {
        const value = opts[name];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max)) {
            throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
        }
    }
    const empty = (overrides: Partial<SearchResult> = {}): SearchResult => ({
        matches: [],
        filesScanned: 0,
        filesTotal: 0,
        truncated: false,
        ...overrides,
    });
    if (terms.length === 0) return empty();
    const patterns = terms.map(termPattern);
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
        return empty();
    }
    let incompleteDiscovery = false;
    async function addFile(dir: string, dirName: string, name: string): Promise<void> {
        const file = path.join(dir, name);
        try {
            files.push({ file, dir: dirName, name, mtime: (await fs.promises.stat(file)).mtimeMs });
        } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") incompleteDiscovery = true;
        }
    }
    // The archive root holds one dir per project; a custom session dir holds its own JSONL files.
    for (const entry of rootEntries) {
        if (signal?.aborted) break;
        const dirName = entry.isFile() ? path.basename(root) : entry.name;
        if (filter && !dirName.toLowerCase().includes(filter)) continue;
        if (entry.isFile()) {
            if (entry.name.endsWith(".jsonl")) await addFile(root, dirName, entry.name);
            continue;
        }
        if (!entry.isDirectory()) continue;
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
            await addFile(dir, dirName, fileEntry.name);
        }
    }
    if (signal?.aborted) return empty({ filesTotal: files.length, truncated: true, scanIncomplete: true });

    const currentDirName = opts.currentDir ? path.basename(opts.currentDir) : undefined;
    function rank(f: (typeof files)[number]) {
        return f.file === opts.currentFile ? 0 : currentDirName && f.dir === currentDirName ? 1 : 2;
    }
    files.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);

    const matches: ArchiveMatch[] = [];
    // shortcut: live offsets can shift as sessions grow, use entry-ID cursors when paging must be exact
    let skipped = 0;
    let filesScanned = 0;
    let incompleteReason: string | undefined = incompleteDiscovery ? "partial discovery" : undefined;
    let limitReached = false;
    for (const { file, dir, name } of files) {
        if (signal?.aborted) {
            incompleteReason ??= "aborted";
            break;
        }
        onProgress?.(filesScanned, matches.length);
        // shortcut: newest hits require scanning each file, index offsets when archive searches get slow
        const fileMessages: ArchiveMatch[] = [];
        const fileTools: ArchiveMatch[] = [];
        const scan = await scanJsonLines(file, signal, (line) => {
            if (patterns.some((pattern) => pattern && !pattern.test(line))) return true;
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
        filesScanned++;
        // shortcut: prefer dialogue with one tool hit, add relevance ranking when noisy matches persist
        const keepMessages = fileTools.length && perSession > 1 ? perSession - 1 : perSession;
        const selected = fileMessages.slice(-keepMessages).reverse();
        const toolSlots = perSession - selected.length;
        if (toolSlots) selected.push(...fileTools.slice(-toolSlots).reverse());
        for (const hit of selected) {
            if (skipped < offset) skipped++;
            else if (matches.length < limit) matches.push(hit);
        }
        if (scan.stopped) {
            incompleteReason ??= signal?.aborted ? "aborted" : "scan stopped";
            break;
        }
        if (scan.oversizedLines > 0) incompleteReason ??= "oversized line";
        if (matches.length >= limit) {
            limitReached = true;
            break;
        }
    }
    const scanIncomplete = incompleteReason !== undefined;
    return {
        matches,
        filesScanned,
        filesTotal: files.length,
        truncated: scanIncomplete || limitReached,
        limitReached,
        scanIncomplete,
        perSession,
        offset,
    };
}

async function firstUserTitle(file: string): Promise<string | null> {
    let title: string | null = null;
    await scanJsonLines(file, undefined, (line) => {
        const et = entryText(parseJsonLine(line));
        if (et?.role !== "user" || !et.text.trim()) return true;
        title = et.text.length > TITLE_MAX_CHARS ? et.text.slice(0, TITLE_MAX_CHARS) + "…" : et.text;
        return false;
    });
    return title;
}

function recentSessions(
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
        } catch {}
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, count).map(({ file, name }) => ({ file, name }));
}

function formatResults(query: string, result: SearchResult): string {
    const notes = [
        result.limitReached ? "Result limit reached; increase offset to check for more." : "",
        result.scanIncomplete
            ? `Search incomplete; scanned ${result.filesScanned} of ${result.filesTotal} files. Narrow the search or check archive access.`
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
            blocks.push(`${m.file}\n[${matchLabel(m)} | ${m.date}]`);
            lastFile = m.file;
        }
        blocks[blocks.length - 1] += `\n- ${m.role}: ${m.excerpt.replace(/\s+/g, " ")}`;
    }
    return `Found ${result.matches.length} match(es) for "${query}"${result.offset ? ` at offset ${result.offset}` : ""} — at most ${result.perSession ?? DEFAULT_PER_SESSION} per session file (read or grep the file for more):\n\n${blocks.join("\n\n")}${note}`;
}

function matchLabel(m: ArchiveMatch): string {
    return m.currentSession ? "this session" : m.sameProject ? "other session in this project" : m.project;
}

/** Absent, null and the literal "null" strict models send all mean "not set". */
function callArg(value: unknown): string | undefined {
    if (typeof value === "number") return String(value);
    return typeof value === "string" && value !== "" && value !== "null" ? value : undefined;
}

function formatSearchCall(args: any, theme: Theme): string {
    const query = callArg(args?.query);
    const session = callArg(args?.session);
    const limit = callArg(args?.limit);
    const perSession = callArg(args?.perSession);
    const offset = callArg(args?.offset);
    let text = theme.fg("toolTitle", theme.bold("search_archive"));
    if (query !== undefined) text += " " + theme.fg("accent", `"${query}"`);
    if (session !== undefined) text += theme.fg("toolOutput", ` in ${session}`);
    if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
    if (perSession !== undefined) text += theme.fg("toolOutput", ` per session ${perSession}`);
    if (offset !== undefined) text += theme.fg("toolOutput", ` offset ${offset}`);
    return text;
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
        renderCall(args, theme, context) {
            const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
            text.setText(formatSearchCall(args, theme));
            return text;
        },
        renderResult(result, { expanded }, theme, context) {
            const text = result.content.flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("\n");
            const details = result.details as SearchResult | undefined;
            // Errors, partial scans and results saved before details.matches existed show the plain text.
            if (context.isError || !details?.matches)
                return new Text(`\n${theme.fg(context.isError ? "error" : "toolOutput", text)}`, 0, 0);
            const { matches } = details;
            const sessions = new Set(matches.map((m) => m.file)).size;
            const warnings = [
                details.limitReached && "limit reached",
                details.scanIncomplete && "scan incomplete",
            ].filter(Boolean);
            const lines: string[] = [];
            let lastFile = "";
            for (const m of matches) {
                if (m.file !== lastFile) {
                    lines.push(`${theme.fg("accent", m.date)} ${theme.fg("muted", matchLabel(m))}`);
                    if (expanded) lines.push(theme.fg("dim", m.file));
                    lastFile = m.file;
                }
                lines.push(
                    `  ${theme.fg("dim", `${m.role}:`)} ${theme.fg("toolOutput", m.excerpt.replace(/\s+/g, " ").trim())}`,
                );
            }
            const shown = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
            const container = new Container();
            container.addChild(new Spacer(1));
            container.addChild(
                new Text(
                    theme.fg(matches.length ? "success" : "muted", `${matches.length} match(es)`) +
                        theme.fg(
                            "muted",
                            ` in ${sessions} session(s) · ${details.filesScanned ?? 0}${details.scanIncomplete ? ` of ${details.filesTotal ?? 0}` : ""} files scanned`,
                        ),
                    0,
                    0,
                ),
            );
            // Collapsed hits stay one line each; expanded ones wrap in full.
            for (const line of shown)
                container.addChild(expanded ? new Text(line, 0, 0) : new TruncatedText(line, 0, 0));
            if (lines.length > shown.length)
                container.addChild(
                    new Text(
                        `${theme.fg("muted", `... (${lines.length - shown.length} more lines,`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
                        0,
                        0,
                    ),
                );
            if (warnings.length)
                container.addChild(new Text(theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`), 0, 0));
            return container;
        },
        async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
            // Strict models inject literal "null" for optional params they omit; drop it from those, never from the query.
            const params = { ...rawParams } as typeof rawParams & Record<string, unknown>;
            for (const key of ["session", "limit", "perSession", "offset"]) {
                if (params[key] === null || params[key] === "null") delete params[key];
            }
            const sessionDir = ctx.sessionManager.getSessionDir();
            // Default sessions nest under an encoded-cwd dir; a custom session dir holds the JSONL files directly.
            // shortcut: a custom dir named like --x-- reads as the default layout, use usesDefaultSessionDir() once it is exposed
            const root = path.basename(sessionDir).startsWith("-") ? path.dirname(sessionDir) : sessionDir;
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
                    matches: result.matches,
                    matchCount: result.matches.length,
                    filesScanned: result.filesScanned,
                    filesTotal: result.filesTotal,
                    truncated: result.truncated,
                    limitReached: result.limitReached === true,
                    scanIncomplete: result.scanIncomplete === true,
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

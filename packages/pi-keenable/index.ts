import { getMarkdownTheme, type ExtensionAPI, type KeybindingHints, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const BASE = "https://api.keenable.ai";
const DEFAULT_MAX_CHARS = 50_000;
const TIMEOUT_MS = 60_000;
const COLLAPSED_LINES = 10;
const DATE_DESC = "Date (YYYY-MM-DD), ISO timestamp, or relative delta like 7d, 30min.";

async function keen(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
    const key = process.env.KEENABLE_API_KEY;
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as object) };
    if (key) headers["X-API-Key"] = key;
    else headers["X-Keenable-Title"] = "pi-keenable";
    // Append /public to the pathname, not the fetch query.
    const url = new URL(path, BASE);
    if (!key) url.pathname += "/public";
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(url.toString(), {
        ...init,
        headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`Keenable ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
}

// Strict models inject literal "null" for optional params they omit; drop it from those, never from query or url.
function definedOptionals<T extends object>(params: T, keys: readonly string[]): T {
    const next = { ...params } as Record<string, unknown>;
    for (const key of keys) if (next[key] == null || next[key] === "null") delete next[key];
    return next as T;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("\n");
}

function resultView(
    theme: Theme,
    context: { keyHint: KeybindingHints["keyHint"] },
    summary: string,
    body: Component,
    hidden = 0,
) {
    const container = new Container();
    container.addChild(new Spacer(1));
    container.addChild(new Text(summary, 0, 0));
    container.addChild(body);
    if (hidden > 0)
        container.addChild(
            new Text(
                `${theme.fg("muted", `... (${hidden} more lines,`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
                0,
                0,
            ),
        );
    return container;
}

/** Absent, null and the literal "null" strict models send all mean "not set". */
function callArg(value: unknown): string | undefined {
    if (typeof value === "number") return String(value);
    return typeof value === "string" && value !== "" && value !== "null" ? value : undefined;
}

function formatSearchCall(args: any, theme: Theme): string {
    const query = callArg(args?.query);
    const site = callArg(args?.site);
    const limit = callArg(args?.max_results);
    const after = callArg(args?.published_after);
    const before = callArg(args?.published_before);
    let text = theme.fg("toolTitle", theme.bold("web_search"));
    if (query !== undefined) text += " " + theme.fg("accent", `"${query}"`);
    if (site !== undefined) text += theme.fg("toolOutput", ` site ${site}`);
    if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
    if (after !== undefined) text += theme.fg("toolOutput", ` after ${after}`);
    if (before !== undefined) text += theme.fg("toolOutput", ` before ${before}`);
    return text;
}

function formatFetchCall(args: any, theme: Theme): string {
    const url = callArg(args?.url);
    const maxChars = callArg(args?.max_chars);
    const prompt = callArg(args?.prompt);
    let text = theme.fg("toolTitle", theme.bold("web_fetch"));
    if (url !== undefined) text += " " + theme.fg("accent", url);
    if (args?.live === true || args?.live === "true") text += theme.fg("toolOutput", " live");
    if (maxChars !== undefined) text += theme.fg("toolOutput", ` max ${maxChars} chars`);
    // Prompts run to 2000 chars; the first line is enough to recognise the call.
    if (prompt !== undefined) text += `\n${theme.fg("muted", prompt.split("\n")[0])}`;
    return text;
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "web_search",
        label: "Web search",
        description:
            "Search the web and return ranked results with URLs, titles, descriptions, and text snippets. Use for finding pages when you don't know the URL.",
        promptSnippet: "Search the web for ranked results with URLs and snippets; use when you don't know the URL",
        parameters: Type.Object({
            query: Type.String({ description: "The search query." }),
            site: Type.Optional(
                Type.String({ description: 'Restrict results to a specific site (e.g. "techcrunch.com").' }),
            ),
            max_results: Type.Optional(
                Type.Integer({ minimum: 1, maximum: 50, description: "Max results (default 10)." }),
            ),
            published_after: Type.Optional(
                Type.String({ description: `Pages published at/after this time. ${DATE_DESC}` }),
            ),
            published_before: Type.Optional(
                Type.String({ description: `Pages published at/before this time. ${DATE_DESC}` }),
            ),
        }),
        renderCall(args, theme, context) {
            const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
            text.setText(formatSearchCall(args, theme));
            return text;
        },
        renderResult(result, options, theme, context) {
            const text = resultText(result);
            const results = (result.details as { results?: Array<{ title?: string; url?: string }> } | undefined)
                ?.results;
            // Errors and results without details show the plain text.
            if (context.isError || !results)
                return new Text(`\n${theme.fg(context.isError ? "error" : "toolOutput", text)}`, 0, 0);
            const summary = theme.fg(results.length ? "success" : "muted", `${results.length} result(s)`);
            // Collapsed keeps one line per result; expanded renders the markdown the model sees, snippets included.
            if (options.expanded)
                return resultView(theme, context, summary, new Markdown(text, 0, 0, getMarkdownTheme()));
            const shown = results.slice(0, COLLAPSED_LINES);
            const body = new Container();
            for (const x of shown)
                body.addChild(
                    new TruncatedText(
                        `${theme.fg("toolOutput", x.title || "(untitled)")} ${theme.fg("dim", x.url ?? "")}`,
                        0,
                        0,
                    ),
                );
            return resultView(theme, context, summary, body, results.length - shown.length);
        },
        async execute(_id, rawParams, signal) {
            const p = definedOptionals(rawParams, ["site", "max_results", "published_after", "published_before"]);
            const r = await keen(
                "/v1/search",
                {
                    method: "POST",
                    body: JSON.stringify(p),
                },
                signal,
            );
            const results = (r.results as any[]) ?? [];
            const text = results
                .map(
                    (x) =>
                        `## ${x.title}\nURL: ${x.url}${x.description ? `\n${x.description}` : ""}${x.published_at ? `\nPublished: ${x.published_at}` : ""}${x.snippet ? `\n\n${x.snippet}` : ""}`,
                )
                .join("\n\n");
            return {
                content: [{ type: "text", text: text || "No results." }],
                details: { results: results.map((x) => ({ title: x.title, url: x.url })) },
            };
        },
    });

    pi.registerTool({
        name: "web_fetch",
        label: "Web fetch",
        description:
            "Fetch a URL and return its content as clean markdown. By default only indexed URLs are supported; pass live=true to fetch any URL directly from the source. Pass prompt to have an LLM extract only that from the page.",
        promptSnippet: "Fetch a URL as clean markdown; pass live=true to fetch any URL directly from the source",
        parameters: Type.Object({
            url: Type.String({ description: "The URL to fetch." }),
            max_chars: Type.Optional(
                Type.Integer({ minimum: 1, description: `Max characters of content (default ${DEFAULT_MAX_CHARS}).` }),
            ),
            live: Type.Optional(
                Type.Boolean({ description: "Fetch live from the source instead of the indexed copy." }),
            ),
            prompt: Type.Optional(
                Type.String({
                    maxLength: 2000,
                    description:
                        "Extraction instruction (max 2000 chars). Returns only the answer instead of the full page. Example: 'List all pricing tiers with their monthly prices'.",
                }),
            ),
        }),
        renderCall(args, theme, context) {
            const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
            text.setText(formatFetchCall(args, theme));
            return text;
        },
        renderResult(result, options, theme, context) {
            const text = resultText(result);
            const details = result.details as { title?: string; chars?: number } | undefined;
            // Errors and results without details show the plain text.
            if (context.isError || !details)
                return new Text(`\n${theme.fg(context.isError ? "error" : "toolOutput", text)}`, 0, 0);
            const summary =
                theme.fg("toolOutput", theme.bold(details.title ?? "")) +
                (details.chars !== undefined ? theme.fg("muted", ` · ${details.chars} chars`) : "");
            // The body skips the "# title" and URL header the model sees; the summary already carries them.
            const at = text.indexOf("\n\n");
            const lines = (at < 0 ? text : text.slice(at + 2)).trim().split("\n");
            const shown = options.expanded ? lines : lines.slice(0, COLLAPSED_LINES);
            const hidden = lines.length - shown.length;
            // An unclosed fence would swallow the rest of the preview.
            if (hidden && shown.filter((line) => line.trimStart().startsWith("```")).length % 2 === 1)
                shown.push("```");
            return resultView(
                theme,
                context,
                summary,
                new Markdown(shown.join("\n"), 0, 0, getMarkdownTheme()),
                hidden,
            );
        },
        async execute(_id, rawParams, signal) {
            const p = definedOptionals(rawParams, ["max_chars", "live", "prompt"]);
            const q = new URLSearchParams({ url: p.url });
            if (p.max_chars !== undefined) q.set("max_chars", String(p.max_chars));
            if (p.live) q.set("live", "true");
            if (p.prompt) q.set("prompt", p.prompt);
            const r = await keen(`/v1/fetch?${q}`, {}, signal);
            const content = (r.content ?? "").slice(0, p.max_chars ?? DEFAULT_MAX_CHARS);
            const text = `# ${r.title ?? p.url}\n${r.url}\n\n${content}`;
            return { content: [{ type: "text", text }], details: { title: r.title ?? p.url, chars: content.length } };
        },
    });
}

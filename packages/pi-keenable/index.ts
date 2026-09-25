import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BASE = "https://api.keenable.ai";
const TIMEOUT_MS = 60_000;

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

const DATE_DESC = "Date (YYYY-MM-DD), ISO timestamp, or relative delta like 7d, 30min.";

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "web_search",
        label: "Web search",
        description:
            "Search the web and return ranked results with URLs, titles, descriptions, and text snippets. Use for finding pages when you don't know the URL.",
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
        async execute(_id, p, signal) {
            const r = await keen(
                "/v1/search",
                {
                    method: "POST",
                    body: JSON.stringify(Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))),
                },
                signal,
            );
            const text = ((r.results as any[]) ?? [])
                .map(
                    (x) =>
                        `## ${x.title}\nURL: ${x.url}${x.description ? `\n${x.description}` : ""}${x.snippet ? `\n\n${x.snippet}` : ""}`,
                )
                .join("\n\n");
            return { content: [{ type: "text", text: text || "No results." }], details: undefined };
        },
    });

    pi.registerTool({
        name: "web_fetch",
        label: "Web fetch",
        description:
            "Fetch a URL and return its content as clean markdown. By default only indexed URLs are supported; pass live=true to fetch any URL directly from the source. Pass prompt to have an LLM extract only that from the page.",
        parameters: Type.Object({
            url: Type.String({ description: "The URL to fetch." }),
            max_chars: Type.Optional(
                Type.Integer({ minimum: 1, description: "Max characters of content (default 50000)." }),
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
        async execute(_id, p, signal) {
            const q = new URLSearchParams({ url: p.url });
            if (p.max_chars !== undefined) q.set("maxChars", String(p.max_chars));
            if (p.live) q.set("live", "true");
            if (p.prompt) q.set("prompt", p.prompt);
            const r = await keen(`/v1/fetch?${q}`, {}, signal);
            const text = `# ${r.title ?? p.url}\n${r.url}\n\n${r.content ?? ""}`;
            return { content: [{ type: "text", text: text.slice(0, p.max_chars ?? 50000) }], details: undefined };
        },
    });
}

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

const realFetch = globalThis.fetch;
const calls: { url: string; init: any }[] = [];
const tools: Record<string, any> = {};

const renderTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const renderContext = {
    isError: false,
    keyHint: (_binding: string, description: string) => `ctrl+o ${description}`,
};
const collapsed = { expanded: false, isPartial: false };

function stubFetch(body: unknown) {
    globalThis.fetch = (async (url: string, init: any) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body));
    }) as typeof fetch;
}

function lastCall() {
    return calls.at(-1)!;
}

function lastUrl() {
    return new URL(lastCall().url);
}

// Markdown pads, colors and (in hyperlink-capable terminals) links its lines, so compare the visible text only.
function lines(component: { render: (width: number) => string[] }) {
    return component
        .render(200)
        .map((line: string) => stripVTControlCharacters(line).trimEnd())
        .filter((line: string) => line.trim());
}

function searchCall(args: any) {
    return lines(tools.web_search.renderCall(args, renderTheme, renderContext));
}

function fetchCall(args: any) {
    return lines(tools.web_fetch.renderCall(args, renderTheme, renderContext));
}

function searchResult(result: any, options = collapsed, context = renderContext) {
    return lines(tools.web_search.renderResult(result, options, renderTheme, context));
}

function fetchResult(result: any, options = collapsed, context = renderContext) {
    return lines(tools.web_fetch.renderResult(result, options, renderTheme, context));
}

function numberedLines(count: number) {
    return Array.from({ length: count }, (_, i) => `line ${i}`);
}

describe("pi-keenable", () => {
    beforeAll(() => {
        extension({ registerTool: (t: any) => (tools[t.name] = t) } as any);
        initTheme("dark", false);
    });

    beforeEach(() => {
        delete process.env.KEENABLE_API_KEY;
        calls.length = 0;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        delete process.env.KEENABLE_API_KEY;
    });

    describe("keyless tier", () => {
        it("sends fetch to /public with all options as query params", async () => {
            stubFetch({ title: "T", url: "u", content: "body" });
            const fetched = await tools.web_fetch.execute("1", {
                url: "https://example.com/a?b=1",
                max_chars: 10,
                live: true,
                prompt: "hi",
            });
            assert.equal(lastUrl().pathname, "/v1/fetch/public");
            assert.deepEqual(Object.fromEntries(lastUrl().searchParams), {
                url: "https://example.com/a?b=1",
                max_chars: "10",
                live: "true",
                prompt: "hi",
            });
            assert.equal(lastCall().init.headers["X-Keenable-Title"], "pi-keenable");
            assert.equal(lastCall().init.headers["X-API-Key"], undefined);
            assert.equal(fetched.content[0].text, "# T\nu\n\nbody");
        });

        it("truncates the fetched content to max_chars", async () => {
            stubFetch({ title: "T", url: "u", content: "body" });
            const short = await tools.web_fetch.execute("1b", { url: "https://example.com/", max_chars: 2 });
            assert.equal(short.content[0].text, "# T\nu\n\nbo");
        });

        it("searches on /public with only the params that are set", async () => {
            stubFetch({ results: [] });
            await tools.web_search.execute("2", { query: "hi", site: undefined });
            assert.equal(lastUrl().pathname, "/v1/search/public");
            assert.deepEqual(JSON.parse(lastCall().init.body), { query: "hi" });
        });

        it("formats results as the markdown the model reads", async () => {
            stubFetch({
                results: [{ title: "Doc", url: "https://example.com/", published_at: "2026-09-27", snippet: "fact" }],
            });
            const text = (await tools.web_search.execute("2b", { query: "hi" })).content[0].text;
            assert.match(text, /Published: 2026-09-27/);
        });
    });

    describe("keyed tier", () => {
        it("drops the /public suffix and sends the key", async () => {
            process.env.KEENABLE_API_KEY = "secret";
            stubFetch({ title: "T", url: "u", content: "body" });
            await tools.web_fetch.execute("3", { url: "https://example.com/a?b=1" });
            assert.equal(lastUrl().pathname, "/v1/fetch");
            assert.equal(lastUrl().searchParams.get("url"), "https://example.com/a?b=1");
            assert.equal(lastCall().init.headers["X-API-Key"], "secret");
            stubFetch({ results: [] });
            await tools.web_search.execute("4", { query: "hi" });
            assert.equal(lastUrl().pathname, "/v1/search");
        });
    });

    describe("strict-model params", () => {
        it('drops the literal "null" models send for omitted optionals', async () => {
            stubFetch({ results: [] });
            await tools.web_search.execute("n", { query: "hi", site: "null", published_after: "null" });
            assert.deepEqual(JSON.parse(lastCall().init.body), { query: "hi" });
            stubFetch({ title: "T", url: "u", content: "body" });
            await tools.web_fetch.execute("n2", { url: "https://example.com/", prompt: "null" });
            assert.equal(lastUrl().searchParams.get("prompt"), null);
        });

        it('keeps the literal "null" in required params', async () => {
            stubFetch({ results: [] });
            await tools.web_search.execute("n", { query: "null" });
            assert.deepEqual(JSON.parse(lastCall().init.body), { query: "null" });
            stubFetch({ title: "T", url: "u", content: "body" });
            await tools.web_fetch.execute("n2", { url: "null" });
            assert.equal(lastUrl().searchParams.get("url"), "null");
        });
    });

    describe("abort", () => {
        it("aborts the in-flight request with the caller's reason", async () => {
            globalThis.fetch = ((url: string, init: any) => {
                calls.push({ url, init });
                return new Promise((_, reject) =>
                    init.signal.addEventListener("abort", () => reject(init.signal.reason)),
                );
            }) as typeof fetch;
            const ac = new AbortController();
            const pending = tools.web_fetch.execute("6", { url: "https://example.com/" }, ac.signal);
            const requestSignal = lastCall().init.signal;
            assert.ok(requestSignal instanceof AbortSignal);
            assert.equal(requestSignal.aborted, false);
            const reason = new Error("user aborted");
            ac.abort(reason);
            await assert.rejects(pending, (e) => e === reason);
            assert.equal(requestSignal.reason, reason);
        });
    });

    describe("errors", () => {
        it("surfaces the HTTP status and body", async () => {
            globalThis.fetch = (async () => new Response("boom", { status: 429 })) as typeof fetch;
            await assert.rejects(tools.web_fetch.execute("7", { url: "https://example.com/" }), /Keenable 429: boom/);
        });

        it('answers an empty result list with "No results."', async () => {
            stubFetch({});
            assert.equal((await tools.web_search.execute("8", { query: "hi" })).content[0].text, "No results.");
        });
    });

    describe("renderers", () => {
        it("renders search call lines with only the set filters", () => {
            assert.deepEqual(searchCall({ query: "hi" }), ['web_search "hi"']);
            assert.deepEqual(
                searchCall({
                    query: "hi",
                    site: "x.com",
                    max_results: 5,
                    published_after: "7d",
                    published_before: "2026-01-01",
                }),
                ['web_search "hi" site x.com limit 5 after 7d before 2026-01-01'],
            );
        });

        it("renders fetch call lines with options and the prompt's first line", () => {
            assert.deepEqual(fetchCall({ url: "https://x" }), ["web_fetch https://x"]);
            assert.deepEqual(
                fetchCall({ url: "https://x", live: true, max_chars: 100, prompt: "list tiers\nand prices" }),
                ["web_fetch https://x live max 100 chars", "list tiers"],
            );
        });

        it('hides null and "null" optionals on call lines', () => {
            assert.deepEqual(
                searchCall({
                    query: "hi",
                    site: "null",
                    max_results: null,
                    published_after: "null",
                    published_before: null,
                }),
                ['web_search "hi"'],
            );
            assert.deepEqual(fetchCall({ url: "https://x", live: "null", max_chars: "null", prompt: "null" }), [
                "web_fetch https://x",
            ]);
        });

        it("renders one line per collapsed search result", () => {
            assert.deepEqual(searchResult({ content: [], details: { results: [{ title: "T", url: "https://x" }] } }), [
                "1 result(s)",
                "T https://x",
            ]);
        });

        it("renders expanded search as the model's markdown", () => {
            const result = {
                content: [{ type: "text", text: "## T\nURL: https://x" }],
                details: { results: [{ title: "T", url: "https://x" }] },
            };
            assert.deepEqual(searchResult(result, { ...collapsed, expanded: true }), [
                "1 result(s)",
                "T",
                "URL: https://x",
            ]);
        });

        it("renders the fetch body as markdown, previewed until expanded", () => {
            const fetched = {
                content: [{ type: "text", text: `# T\nhttps://x\n\n${numberedLines(15).join("\n")}` }],
                details: { title: "T", chars: 99 },
            };
            assert.deepEqual(fetchResult(fetched), [
                "T · 99 chars",
                ...numberedLines(10),
                "... (5 more lines, ctrl+o to expand)",
            ]);
            assert.deepEqual(fetchResult(fetched, { ...collapsed, expanded: true }), [
                "T · 99 chars",
                ...numberedLines(15),
            ]);
        });

        it("shows errors and results without details as plain text", () => {
            const failed = { content: [{ type: "text", text: "Keenable 429: boom" }] };
            const errorContext = { ...renderContext, isError: true };
            assert.deepEqual(searchResult(failed, collapsed, errorContext), ["Keenable 429: boom"]);
            assert.deepEqual(fetchResult(failed, collapsed, errorContext), ["Keenable 429: boom"]);
        });
    });
});

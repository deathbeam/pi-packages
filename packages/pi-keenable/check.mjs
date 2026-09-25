// Run: node check.mjs (Node >=22.19 supports TypeScript type stripping).
import assert from "node:assert/strict";
import extension from "./index.ts";

const calls = [];
const realFetch = globalThis.fetch;
const tools = {};
extension({ registerTool: (t) => (tools[t.name] = t) });

function stub(body) {
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body));
    };
}
const last = () => new URL(calls.at(-1).url);

try {
    // Keyless fetch: /public belongs on the pathname, the query must survive intact.
    delete process.env.KEENABLE_API_KEY;
    stub({ title: "T", url: "u", content: "body" });
    await tools.web_fetch.execute("1", { url: "https://example.com/a?b=1", max_chars: 10, live: true, prompt: "hi" });
    assert.equal(last().pathname, "/v1/fetch/public");
    assert.equal(last().searchParams.get("url"), "https://example.com/a?b=1");
    assert.equal(last().searchParams.get("maxChars"), "10");
    assert.equal(last().searchParams.get("live"), "true");
    assert.equal(last().searchParams.get("prompt"), "hi");
    assert.equal(calls.at(-1).init.headers["X-Keenable-Title"], "pi-keenable");
    assert.equal(calls.at(-1).init.headers["X-API-Key"], undefined);

    // Keyless search stays on the public tier.
    stub({ results: [] });
    await tools.web_search.execute("2", { query: "hi", site: undefined });
    assert.equal(last().pathname, "/v1/search/public");
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { query: "hi" });

    // Keyed calls skip the public tier and keep the query untouched.
    process.env.KEENABLE_API_KEY = "secret";
    await tools.web_fetch.execute("3", { url: "https://example.com/a?b=1" });
    assert.equal(last().pathname, "/v1/fetch");
    assert.equal(last().searchParams.get("url"), "https://example.com/a?b=1");
    assert.equal(calls.at(-1).init.headers["X-API-Key"], "secret");
    await tools.web_search.execute("4", { query: "hi" });
    assert.equal(last().pathname, "/v1/search");
    delete process.env.KEENABLE_API_KEY;

    // Every request carries its own timeout signal, not the caller's.
    stub({ results: [] });
    const ac = new AbortController();
    await tools.web_search.execute("5", { query: "hi" }, ac.signal);
    assert.ok(calls.at(-1).init.signal instanceof AbortSignal);
    assert.notEqual(calls.at(-1).init.signal, ac.signal);
    assert.equal(calls.at(-1).init.signal.aborted, false);

    // Aborting the tool call aborts the in-flight request with the same reason.
    globalThis.fetch = (url, init) => {
        calls.push({ url, init });
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    };
    const ac2 = new AbortController();
    const reason = new Error("user aborted");
    const pending = tools.web_fetch.execute("6", { url: "https://example.com/" }, ac2.signal);
    ac2.abort(reason);
    await assert.rejects(pending, (e) => e === reason);
    assert.equal(calls.at(-1).init.signal.aborted, true);
    assert.equal(calls.at(-1).init.signal.reason, reason);

    // HTTP errors and empty result shapes surface as errors / "No results.", not TypeErrors.
    globalThis.fetch = async () => new Response("boom", { status: 429 });
    await assert.rejects(tools.web_fetch.execute("7", { url: "https://example.com/" }), /Keenable 429: boom/);
    stub({});
    assert.equal((await tools.web_search.execute("8", { query: "hi" })).content[0].text, "No results.");
} finally {
    globalThis.fetch = realFetch;
    delete process.env.KEENABLE_API_KEY;
}

console.log("pi-keenable: all checks passed");

import { afterEach, expect, spyOn, test } from "bun:test";
import { searchBrave, formatSearchResults } from "../../src/core-extensions/web-search/search.ts";
import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { decideToolPermission } from "../../src/engine/permissions.ts";
import { executeToolHandler } from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const signal = new AbortController().signal;
const result = { title: "Graph", url: "https://example.com/graph", description: "A directed graph." };
const originalKey = process.env.BRAVE_API_KEY;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;

afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    if (originalKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = originalKey;
});

test("included search uses permissions and returns a visible failure followed by a successful retry", async () => {
    const configs = includedExtensionConfigs([]).filter((config) =>
        loadExtensionManifest(config.path).manifest.id === "vera.web-search").map((config) => ({ ...config, config: { providers: ["brave"] } }));
    expect(configs).toHaveLength(1);
    expect(includedExtensionConfigs(["vera.web-search"]).some((config) =>
        loadExtensionManifest(config.path).manifest.id === "vera.web-search")).toBe(false);
    delete process.env.BRAVE_API_KEY;
    const registry = await startExtensionRegistry({ extensions: configs });
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
        type: "search", web: { results: [result] },
    }));
    try {
        const tools = registry.tools();
        expect(tools.map((tool) => tool.definition.name)).toEqual(["web_search"]);
        const call = { type: "tool_call" as const, id: "search", name: "web_search", input: { query: "graph" } };
        expect(decideToolPermission("ask", call, process.cwd(), [], { extensionTools: tools }))
            .toMatchObject({ behavior: "ask", actions: [{ action: { operation: "web.search" } }] });
        const runtime = new ToolRuntime(process.cwd());
        expect(await executeToolHandler(call, runtime, signal, tools)).toMatchObject({
            isError: true, output: expect.stringContaining("BRAVE_API_KEY"),
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        process.env.BRAVE_API_KEY = "test-token";
        expect(await executeToolHandler(call, runtime, signal, tools)).toMatchObject({
            isError: false, output: expect.stringContaining("https://example.com/graph"),
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
        await registry.close();
    }
});

test("request uses the official endpoint and keeps the token out of the URL and output", async () => {
    const results = await searchBrave(" graph & trees ", undefined, " test-token ", signal, {
        fetcher: async (url, init) => {
            expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
            expect(url.searchParams.get("q")).toBe("graph & trees");
            expect(url.searchParams.get("count")).toBe("5");
            expect(url.searchParams.get("text_decorations")).toBe("false");
            expect(String(url)).not.toContain("test-token");
            expect(init.headers).toMatchObject({ "X-Subscription-Token": "test-token" });
            expect(init.redirect).toBe("error");
            return Response.json({ type: "search", web: { results: [result] } });
        },
    });
    expect(results).toEqual([{ title: "Graph", url: result.url, snippet: result.description }]);
    expect(formatSearchResults(results)).toContain("Provider: Brave");
    expect(formatSearchResults(results)).not.toContain("test-token");
});

test("invalid inputs and missing credentials never reach the network", async () => {
    const options = { fetcher: async () => { throw new Error("unexpected fetch"); } };
    for (const query of [undefined, null, 42, " ", "x".repeat(601), "word ".repeat(76)]) {
        await expect(searchBrave(query, 5, "key", signal, options)).rejects.toThrow("query");
    }
    for (const limit of [null, 0, 11, 1.5, "3"]) {
        await expect(searchBrave("graph", limit, "key", signal, options)).rejects.toThrow("max_results");
    }
    for (const key of [undefined, "", "   "]) {
        await expect(searchBrave("graph", 5, key, signal, options)).rejects.toThrow("BRAVE_API_KEY");
    }
});

test("HTTP failures provide actionable errors without echoing the body", async () => {
    for (const [status, advice] of [[401, "BRAVE_API_KEY"], [403, "subscription"], [429, "Rate or quota"], [503, "Try again"]] as const) {
        let requests = 0;
        const promise = searchBrave("graph", 5, "secret-token", signal, {
            fetcher: async () => {
                requests++;
                return new Response("secret-token", { status });
            },
        });
        await expect(promise).rejects.toThrow(advice);
        await expect(promise).rejects.not.toThrow("secret-token");
        expect(requests).toBe(1);
    }
    await expect(searchBrave("graph", 5, "secret-token", signal, {
        fetcher: async () => { throw new Error("Brave search secret-token"); },
    })).rejects.toThrow("request failed");
});

test("empty results differ from malformed responses", async () => {
    for (const body of [{ type: "search" }, { type: "search", web: null }, { type: "search", web: { results: [] } }]) {
        const results = await searchBrave("graph", 5, "key", signal, {
            fetcher: async () => Response.json(body),
        });
        expect(formatSearchResults(results)).toContain("No results found.");
    }
    for (const body of [{}, null, { type: "ErrorResponse" }, { type: "search", web: {} }, { type: "search", web: { results: [{}] } }]) {
        await expect(searchBrave("graph", 5, "key", signal, {
            fetcher: async () => Response.json(body),
        })).rejects.toThrow("invalid");
    }
    await expect(searchBrave("graph", 5, "key", signal, {
        fetcher: async () => new Response("<html>blocked</html>"),
    })).rejects.toThrow("invalid JSON");
});

test("output is bounded and skips unsafe URLs before applying the limit", async () => {
    const results = await searchBrave("graph", 1, "key", signal, {
        fetcher: async () => Response.json({ type: "search", web: { results: [
            { ...result, url: "javascript:alert(1)" },
            { ...result, url: "https://user:pass@example.com/" },
            { ...result, title: "x".repeat(600), description: "x".repeat(3_000) },
            result,
        ] } }),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.title.length).toBe(500);
    expect(results[0]?.snippet.length).toBe(2_000);
    expect(results[0]?.url).toBe(result.url);
    await expect(searchBrave("graph", 1, "key", signal, {
        fetcher: async () => new Response("x".repeat(1_048_577)),
    })).rejects.toThrow("exceeded 1 MiB");
});

test("cancellation and timeouts abort the request", async () => {
    const fetcher = async (_url: URL, init: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        });
    const controller = new AbortController();
    const cancelled = searchBrave("graph", 5, "key", controller.signal, { fetcher });
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    await expect(searchBrave("graph", 5, "key", signal, { fetcher, timeoutMs: 5 }))
        .rejects.toThrow("timed out");
    await expect(searchBrave("graph", 5, "key", controller.signal, {
        fetcher: async () => { throw new Error("unexpected fetch"); },
    })).rejects.not.toThrow("unexpected fetch");
});


test("timeout covers a stalled response body after headers arrive", async () => {
    let aborted = false;
    await expect(searchBrave("graph", 5, "key", signal, {
        timeoutMs: 5,
        fetcher: async (_url, init) => new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"type":"search",'));
                init.signal!.addEventListener("abort", () => {
                    aborted = true;
                    controller.error(init.signal!.reason);
                }, { once: true });
            },
        })),
    })).rejects.toThrow("timed out");
    expect(aborted).toBe(true);
});

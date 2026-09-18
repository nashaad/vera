import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { SearchStore } from "../../src/core-extensions/web-search/store.ts";
import { searchWeb, formatSearchResults } from "../../src/core-extensions/web-search/search.ts";
import { parseDuckDuckGo } from "../../src/core-extensions/web-search/providers.ts";
import { openSearchProviders } from "../../src/core-extensions/web-search/client.ts";
import type { VeraClientExtensionApi, VeraClientPickerRequest } from "../../src/sdk/extensions.ts";

const signal = new AbortController().signal;
const choices = ["brave", "exa", "duckduckgo"].map((id) => ({ id, enabled: true })) as Parameters<typeof searchWeb>[2];
const html = '<a class="result-link" href="https://example.com">Example &amp; test</a><td class="result-snippet">Some <b>text</b>.</td>';

test("missing keys skip providers and Exa highlights become snippets", async () => {
    const requests: string[] = [];
    const outcome = await searchWeb("test", 2, choices, (id) => id === "exa" ? "key" : undefined, signal, {
        fetcher: async (url, init) => {
            requests.push(url.host);
            expect(init.headers).toMatchObject({ "x-api-key": "key" });
            expect(JSON.parse(String(init.body))).toMatchObject({ query: "test", numResults: 2, contents: { highlights: { maxCharacters: 2_000 } } });
            return Response.json({ results: [{ title: "Example", url: "https://example.com", highlights: ["One", "Two"] }] });
        },
    });
    expect(requests).toEqual(["api.exa.ai"]);
    expect(outcome.results[0]?.snippet).toBe("One Two");
    expect(formatSearchResults(outcome.results, outcome.provider, outcome.notices)).toContain("Fallback: Brave: API key unavailable");
});

test("auth errors and quota failures fall through to DuckDuckGo without echoing response bodies", async () => {
    const requests: string[] = [];
    const outcome = await searchWeb("test", 2, choices, () => "private-key", signal, {
        fetcher: async (url) => {
            requests.push(url.host);
            if (url.host === "api.search.brave.com") return new Response("private-key", { status: 401 });
            if (url.host === "api.exa.ai") return new Response("private-key", { status: 429 });
            return new Response(html);
        },
    });
    expect(requests).toEqual(["api.search.brave.com", "api.exa.ai", "lite.duckduckgo.com"]);
    expect(outcome.provider).toBe("duckduckgo");
    expect(outcome.notices.join(" ")).toContain("HTTP 401");
    expect(outcome.notices.join(" ")).toContain("HTTP 429");
    expect(JSON.stringify(outcome)).not.toContain("private-key");
    expect(outcome.results[0]?.title).toBe("Example & test");
});

test("zero results do not trigger fallback and disabled providers make no requests", async () => {
    let calls = 0;
    const result = await searchWeb("test", 2, [{ id: "brave", enabled: false }, ...choices.slice(1)], () => "key", signal, {
        fetcher: async (url) => { calls++; expect(url.host).toBe("api.exa.ai"); return Response.json({ results: [] }); },
    });
    expect(result.results).toEqual([]);
    expect(calls).toBe(1);
});

test("one overall deadline bounds the chain and cancellation prevents fallback", async () => {
    let calls = 0;
    const fetcher = async (_url: URL, init: RequestInit): Promise<Response> => {
        calls++;
        return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    };
    await expect(searchWeb("test", 2, choices, () => "key", signal, { fetcher, timeoutMs: 15, attemptTimeoutMs: 50 })).rejects.toThrow("timed out");
    expect(calls).toBe(1);
    calls = 0;
    const controller = new AbortController();
    const pending = searchWeb("test", 2, choices, () => "key", controller.signal, { fetcher });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
});

test("an attempt timeout leaves time for the next provider", async () => {
    const result = await searchWeb("test", 2, choices, () => "key", signal, { timeoutMs: 500, attemptTimeoutMs: 5,
        fetcher: async (url, init) => url.host === "api.search.brave.com"
            ? new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))
            : Response.json({ results: [] }),
    });
    expect(result.provider).toBe("exa");
    expect(result.notices[0]).toContain("timed out");
});

test("DuckDuckGo distinguishes a challenge from an explicit empty page and filters ads before limiting", () => {
    expect(() => parseDuckDuckGo('<form id="challenge-form"></form>', 5)).toThrow("blocked");
    expect(() => parseDuckDuckGo("<html>Changed page</html>", 5)).toThrow("no parseable results");
    expect(parseDuckDuckGo('<div class="no-results__message">No results</div>', 5)).toEqual([]);
    const ad = '<a class="result-link" href="https://duckduckgo.com/y.js">Ad</a><td class="result-snippet">ad</td>';
    expect(parseDuckDuckGo(ad + html, 1)).toHaveLength(1);
});

test("provider order and keys survive reopening without putting keys in settings", () => {
    const root = mkdtempSync(join(tmpdir(), "search-store-"));
    try {
        const auth = createAuthStorage({ path: join(root, "auth.json") });
        auth.setCredential("unrelated", { type: "api_key", key: "preserved" });
        const store = new SearchStore(root, auth, { BRAVE_API_KEY: "exported" });
        expect(store.providers().map((entry) => entry.id)).toEqual(["brave", "duckduckgo"]);
        store.saveKey("brave", "saved-secret");
        store.save([{ id: "exa", enabled: false }, { id: "brave", enabled: true }]);
        const reopened = new SearchStore(root, createAuthStorage({ path: join(root, "auth.json") }), { BRAVE_API_KEY: "exported" });
        expect(reopened.providers()).toEqual([{ id: "exa", enabled: false }, { id: "brave", enabled: true }]);
        expect(reopened.key("brave")).toBe("saved-secret");
        expect(readFileSync(join(root, "providers.json"), "utf8")).not.toContain("secret");
        expect(statSync(join(root, "providers.json")).mode & 0o777).toBe(0o600);
        expect(auth.getCredential("unrelated")).toEqual({ type: "api_key", key: "preserved" });
        reopened.removeKey("brave");
        expect(reopened.key("brave")).toBe("exported");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider menus add a keyed service, reorder it, and disable it", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-menu-"));
    try {
        const store = new SearchStore(root, createAuthStorage({ path: join(root, "auth.json") }), {});
        const actions = ["connect", "exa", "exa", "up", "toggle", undefined, undefined];
        const screens: VeraClientPickerRequest[] = [];
        const api = { ui: { requestPicker: async (request: VeraClientPickerRequest) => {
            screens.push(request);
            const id = actions.shift();
            return id ? { outcome: "selected", rowId: id === "connect" ? "duckduckgo" : id, actionId: id === "connect" ? "connect" : "open" } : { outcome: "cancelled" };
        } }, experimentalTui: { requestSecret: async () => "saved-key" } } as unknown as VeraClientExtensionApi;
        await openSearchProviders(api, store, signal);
        expect(store.providers()).toEqual([{ id: "exa", enabled: false }, { id: "duckduckgo", enabled: true }]);
        expect(store.key("exa")).toBe("saved-key");
        expect(JSON.stringify(screens)).not.toContain("saved-key");
        expect(screens[0]?.layout).toBe("list-detail");
        expect(screens[0]?.searchable).toBe(false);
        expect(screens[0]?.actions.filter((action) => action.button).map((action) => action.label)).toEqual(["Connect provider"]);
        const manage = screens.find((screen) => screen.title === "Manage Exa")!;
        expect(manage.rows.find((row) => row.id === "up")?.group).toBe("order");
        expect(manage.rows.find((row) => row.id === "remove")?.group).toBe("state");
        expect(manage.rows.find((row) => row.id === "verify")?.description).toBeUndefined();
        expect(manage.rows.map((row) => row.id)).toEqual(["key", "verify", "remove-key", "up", "toggle", "remove"]);
        expect(screens[0]?.rows.map((row) => row.label)).toEqual(["DuckDuckGo"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

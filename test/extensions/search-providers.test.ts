import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { SearchStore } from "../../src/core-extensions/web-search/store.ts";
import { searchWeb, formatSearchResults } from "../../src/core-extensions/web-search/search.ts";
import { builtInProviders, type SearchFetch } from "../../src/core-extensions/web-search/providers.ts";
import { openSearchProviders } from "../../src/core-extensions/web-search/client.ts";
import type { VeraClientExtensionApi, VeraClientPickerRequest, VeraSearchProvider } from "../../src/sdk/extensions.ts";

const signal = new AbortController().signal;
const lookupCalls: string[] = [];
const lookup: VeraSearchProvider = {
    id: "lookup", label: "Lookup", requiresKey: false,
    async search({ query }) {
        lookupCalls.push(query);
        return [{ title: "Example  &  test", url: "https://example.com", snippet: "Some text." }];
    },
};
const chain = (fetcher: SearchFetch) => [...builtInProviders(fetcher), lookup].map((provider) => ({ provider, enabled: true }));
const byId = (id: string) => (provider: VeraSearchProvider) => provider.id === id;

test("missing keys skip providers and Exa highlights become snippets", async () => {
    const requests: string[] = [];
    const outcome = await searchWeb("test", 2, chain(async (url, init) => {
        requests.push(url.host);
        expect(init.headers).toMatchObject({ "x-api-key": "key" });
        expect(JSON.parse(String(init.body))).toMatchObject({ query: "test", numResults: 2, contents: { highlights: { maxCharacters: 2_000 } } });
        return Response.json({ results: [{ title: "Example", url: "https://example.com", highlights: ["One", "Two"] }] });
    }), (provider) => provider.id === "exa" ? "key" : undefined, signal);
    expect(requests).toEqual(["api.exa.ai"]);
    expect(outcome.results[0]?.snippet).toBe("One Two");
    expect(formatSearchResults(outcome.results, outcome.provider.label, outcome.notices)).toContain("Fallback: Brave: API key unavailable");
});

test("auth errors and quota failures fall through to an extension provider without echoing response bodies", async () => {
    const requests: string[] = [];
    lookupCalls.length = 0;
    const outcome = await searchWeb("test", 2, chain(async (url) => {
        requests.push(url.host);
        return new Response("private-key", { status: url.host === "api.exa.ai" ? 429 : 401 });
    }), (provider) => provider.requiresKey ? "private-key" : undefined, signal);
    expect(requests).toEqual(["api.search.brave.com", "api.exa.ai"]);
    expect(lookupCalls).toEqual(["test"]);
    expect(outcome.provider.id).toBe("lookup");
    expect(outcome.notices.join(" ")).toContain("HTTP 401");
    expect(outcome.notices.join(" ")).toContain("HTTP 429");
    expect(JSON.stringify(outcome)).not.toContain("private-key");
    expect(outcome.results[0]?.title).toBe("Example & test");
});

test("zero results do not trigger fallback and disabled providers make no requests", async () => {
    let calls = 0;
    const [brave, ...rest] = chain(async (url) => { calls++; expect(url.host).toBe("api.exa.ai"); return Response.json({ results: [] }); });
    const result = await searchWeb("test", 2, [{ ...brave!, enabled: false }, ...rest], () => "key", signal);
    expect(result.results).toEqual([]);
    expect(calls).toBe(1);
});

test("one overall deadline bounds the chain and cancellation prevents fallback", async () => {
    let calls = 0;
    const fetcher = async (_url: URL, init: RequestInit): Promise<Response> => {
        calls++;
        return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    };
    await expect(searchWeb("test", 2, chain(fetcher), () => "key", signal, { timeoutMs: 15, attemptTimeoutMs: 50 })).rejects.toThrow("timed out");
    expect(calls).toBe(1);
    calls = 0;
    const controller = new AbortController();
    const pending = searchWeb("test", 2, chain(fetcher), () => "key", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
});

test("an attempt timeout leaves time for the next provider", async () => {
    const result = await searchWeb("test", 2, chain(async (url, init) => url.host === "api.search.brave.com"
        ? new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))
        : Response.json({ results: [] })), () => "key", signal, { timeoutMs: 500, attemptTimeoutMs: 5 });
    expect(result.provider.id).toBe("exa");
    expect(result.notices[0]).toContain("timed out");
});

test("with no ready provider the error names both ways out", async () => {
    const keyed = builtInProviders(async () => { throw new Error("unexpected fetch"); }).map((provider) => ({ provider, enabled: true }));
    const failure = searchWeb("test", 2, keyed, () => undefined, signal);
    await expect(failure).rejects.toThrow("Connect Brave or Exa in /search-providers");
    await expect(failure).rejects.toThrow("examples/extensions/duckduckgo-search");
    await expect(searchWeb("test", 2, [], () => undefined, signal)).rejects.toThrow("No search provider is ready");
});

test("extension results are bounded and a malformed row fails that provider", async () => {
    const noisy: VeraSearchProvider = { ...lookup, async search() {
        return [{ title: "x".repeat(600), url: "https://example.com", snippet: "ok" }, { title: "Ad", url: "javascript:alert(1)", snippet: "" }];
    } };
    const outcome = await searchWeb("test", 5, [{ provider: noisy, enabled: true }], () => undefined, signal);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.title.length).toBe(500);
    const broken = { ...lookup, search: async () => [{ title: 1 }] } as unknown as VeraSearchProvider;
    await expect(searchWeb("test", 5, [{ provider: broken, enabled: true }], () => undefined, signal)).rejects.toThrow("invalid result");
});

test("provider order and keys survive reopening without putting keys in settings", () => {
    const root = mkdtempSync(join(tmpdir(), "search-store-"));
    try {
        const auth = createAuthStorage({ path: join(root, "auth.json") });
        auth.setCredential("unrelated", { type: "api_key", key: "preserved" });
        const registered = [...builtInProviders(), lookup];
        const brave = registered.find(byId("brave"))!;
        const exa = registered.find(byId("exa"))!;
        const store = new SearchStore(root, () => registered, auth, { BRAVE_API_KEY: "exported" });
        expect(store.providers().map((entry) => entry.provider.id)).toEqual(["brave", "lookup"]);
        store.saveKey(brave, "saved-secret");
        store.save([{ provider: exa, enabled: false }, { provider: brave, enabled: true }]);
        const reopened = new SearchStore(root, () => registered, createAuthStorage({ path: join(root, "auth.json") }), { BRAVE_API_KEY: "exported" });
        expect(reopened.providers().map((entry) => [entry.provider.id, entry.enabled]))
            .toEqual([["exa", false], ["brave", true], ["lookup", true]]);
        expect(reopened.key(brave)).toBe("saved-secret");
        expect(readFileSync(join(root, "providers.json"), "utf8")).not.toContain("secret");
        expect(statSync(join(root, "providers.json")).mode & 0o777).toBe(0o600);
        expect(auth.getCredential("unrelated")).toEqual({ type: "api_key", key: "preserved" });
        reopened.removeKey(brave);
        expect(reopened.key(brave)).toBe("exported");
        const withoutLookup = new SearchStore(root, () => registered.slice(0, 2), auth, {});
        expect(withoutLookup.providers().map((entry) => entry.provider.id)).toEqual(["exa", "brave"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider menus add a keyed service, reorder it, and disable it", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-menu-"));
    try {
        const registered = [...builtInProviders(), lookup];
        const store = new SearchStore(root, () => registered, createAuthStorage({ path: join(root, "auth.json") }), {});
        const actions = ["connect", "exa", "exa", "up", "toggle", undefined, undefined];
        const screens: VeraClientPickerRequest[] = [];
        const api = { ui: { requestPicker: async (request: VeraClientPickerRequest) => {
            screens.push(request);
            const id = actions.shift();
            return id ? { outcome: "selected", rowId: id === "connect" ? "lookup" : id, actionId: id === "connect" ? "connect" : "open" } : { outcome: "cancelled" };
        } }, experimentalTui: { requestSecret: async () => "saved-key" } } as unknown as VeraClientExtensionApi;
        await openSearchProviders(api, store, signal);
        expect(store.providers().map((entry) => [entry.provider.id, entry.enabled])).toEqual([["exa", false], ["lookup", true]]);
        expect(store.key(registered.find(byId("exa"))!)).toBe("saved-key");
        expect(JSON.stringify(screens)).not.toContain("saved-key");
        expect(screens[0]?.layout).toBe("list-detail");
        expect(screens[0]?.searchable).toBe(false);
        expect(screens[0]?.actions.filter((action) => action.button).map((action) => action.label)).toEqual(["Connect provider"]);
        const manage = screens.find((screen) => screen.title === "Manage Exa")!;
        expect(manage.rows.find((row) => row.id === "up")?.group).toBe("order");
        expect(manage.rows.find((row) => row.id === "remove")?.group).toBe("state");
        expect(manage.rows.find((row) => row.id === "verify")?.description).toBeUndefined();
        expect(manage.rows.map((row) => row.id)).toEqual(["key", "verify", "remove-key", "up", "toggle", "remove"]);
        expect(screens[0]?.rows.map((row) => row.label)).toEqual(["Lookup"]);
        expect(screens.find((screen) => screen.title === "Connect search provider")?.rows.map((row) => row.id)).toEqual(["brave", "exa"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

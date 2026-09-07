import { expect, test } from "bun:test";
import { providerEndpointError, readModelCatalog } from "../../src/providers/read-model-catalog.ts";

test("endpoint failures name the cause and accept HTTP and HTTPS", () => {
    expect(providerEndpointError("nonsense")).toBe("Not a valid URL");
    expect(providerEndpointError("ftp://host/v1")).toContain("not HTTP or HTTPS");
    expect(providerEndpointError("http://server.lan/v1")).toBeUndefined();
    expect(providerEndpointError("https://api.example/v1")).toBeUndefined();
});

test("a catalog read discovers names without inventing verification or membership", async () => {
    const catalog = await readModelCatalog({ provider: "custom", baseUrl: "https://example/v1/", protocol: "openai-chat", apiKey: "key",
        fetch: (async (url, init) => {
            expect(url).toBe("https://example/v1/models");
            expect(init?.headers).toEqual({ Authorization: "Bearer key" });
            return Response.json({ data: [{ id: "model-a", name: "Model A" }] });
        }) as typeof fetch });
    expect(catalog.models).toEqual([{ id: "model-a", label: "Model A", levels: [] }]);
    expect(catalog.fetched_at).toBeDefined();
});

test("Anthropic catalogs paginate and use their own credential headers", async () => {
    let calls = 0;
    const catalog = await readModelCatalog({ provider: "anthropic", baseUrl: "https://example/v1", protocol: "anthropic-messages", apiKey: "key",
        fetch: (async (url, init) => {
            expect(init?.headers).toEqual({ "x-api-key": "key", "anthropic-version": "2023-06-01" });
            calls++;
            if (calls === 1) return Response.json({ data: [{ id: "a", display_name: "A" }], has_more: true, last_id: "a" });
            expect(String(url)).toEndWith("?after_id=a");
            return Response.json({ data: [{ id: "b" }] });
        }) as typeof fetch });
    expect(catalog.models.map((row) => row.id)).toEqual(["a", "b"]);
});

test("network and malformed responses fail without a catalog", async () => {
    const options = { provider: "x", baseUrl: "https://example", protocol: "openai-chat" };
    await expect(readModelCatalog({ ...options, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch })).rejects.toThrow("No response from that host");
    await expect(readModelCatalog({ ...options, fetch: (async () => Response.json({ invalid: true })) as unknown as typeof fetch })).rejects.toThrow("invalid model catalog");
});

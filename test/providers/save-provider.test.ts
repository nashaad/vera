import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVeraConfig } from "../../src/config.ts";
import { readProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { saveProvider } from "../../src/providers/save-provider.ts";

test("provider save persists the endpoint, key and discovered catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-save-provider-"));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = root;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            if (request.headers.get("authorization") !== "Bearer fake-key") return new Response(null, { status: 401 });
            return Response.json({ data: [{ id: "test-model" }] });
        },
    });
    try {
        const baseUrl = `http://127.0.0.1:${server.port}/v1`;
        const result = await saveProvider({
            id: "gateway",
            declaration: { protocol: "openai-chat", credential: "api_key", base_url: baseUrl },
            apiKey: "fake-key",
        }, createAuthStorage());
        expect(result).toEqual({ label: "gateway", modelCount: 1 });
        expect(loadVeraConfig().providers?.gateway?.base_url).toBe(baseUrl);
        expect(createAuthStorage().getCredential("gateway")).toEqual({ type: "api_key", key: "fake-key" });
        expect(readProviderCatalogSnapshot("gateway").models.map((model) => model.id)).toEqual(["test-model"]);
    } finally {
        server.stop(true);
        if (previousHome === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    }
});

test("a failed catalog read leaves provider stores untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-save-provider-"));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = root;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 401 }) });
    try {
        const auth = createAuthStorage();
        await expect(saveProvider({
            id: "gateway",
            declaration: { protocol: "openai-chat", credential: "api_key", base_url: `http://127.0.0.1:${server.port}/v1` },
            apiKey: "fake-key",
        }, auth)).rejects.toThrow("HTTP 401");
        expect(auth.getCredential("gateway")).toBeUndefined();
        expect(readProviderCatalogSnapshot("gateway").models).toEqual([]);
    } finally {
        server.stop(true);
        if (previousHome === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    }
});

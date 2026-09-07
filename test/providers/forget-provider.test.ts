import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadVeraConfig } from "../../src/config.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { forgetProviderConnection } from "../../src/providers/forget-provider.ts";
import { readUserPoolFile } from "../../src/model/pool-file-store.ts";
import { readProviderCatalogSnapshot, writeProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";

test("forget removes the provider catalog, shortlist rows and bound slots from real stores", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-forget-"));
    const previousHome = process.env.VERA_HOME;
    const previousPool = process.env.VERA_POOL_FILE;
    process.env.VERA_HOME = root; process.env.VERA_POOL_FILE = join(root, "pool.json");
    try {
        writeFileSync(join(root, "config.json"), JSON.stringify({ schema_version: 1, provider: "openrouter", model: "initial",
            providers: { gateway: { protocol: "openai-chat", credential: "api_key", base_url: "https://example/v1" } },
            model_assignments: { snappy: { models: [{ name: "one", provider: "gateway", model: "one" }] },
                eco: { models: [{ name: "two", provider: "openrouter", model: "two" }] } } }));
        writeFileSync(join(root, "pool.json"), JSON.stringify({ models: { "gateway/one": { added: true }, "openrouter/two": { added: true } } }));
        const auth = createAuthStorage(); auth.setCredential("gateway", { type: "api_key", key: "test" });
        writeProviderCatalogSnapshot({ schema_version: 2, provider: "gateway", fetched_at: new Date().toISOString(), models: [{ id: "one", label: "One", levels: [] }] });
        forgetProviderConnection("gateway", auth);
        const config = loadVeraConfig();
        expect(config.providers?.gateway).toBeUndefined();
        expect(config.model_assignments?.snappy).toBeUndefined();
        expect(config.model_assignments?.eco?.models?.[0]?.model).toBe("two");
        expect(Object.keys(readUserPoolFile().models)).toEqual(["openrouter/two"]);
        expect(auth.getCredential("gateway")).toBeUndefined();
        expect(readProviderCatalogSnapshot("gateway").fetched_at).toBeUndefined();
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previousHome;
        if (previousPool === undefined) delete process.env.VERA_POOL_FILE; else process.env.VERA_POOL_FILE = previousPool;
        rmSync(root, { recursive: true, force: true });
    }
});

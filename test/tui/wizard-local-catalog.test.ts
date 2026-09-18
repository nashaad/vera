/** What the wizard leaves behind for a local runtime, which is the record that decides whether the home has a provider at all. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLocalCatalog } from "../../clients/tui/main/onboarding-wizard-ops.ts";
import { readProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import { connectedProviderCatalogs } from "../../src/providers/catalog-state.ts";

function cacheDir(): string {
    return mkdtempSync(join(tmpdir(), "wizard-catalog-"));
}

function listing(models: readonly string[]): typeof fetch {
    return (async () =>
        new Response(
            JSON.stringify({ data: models.map((id) => ({ id })) }),
            { headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch;
}

describe("the catalog a verified local runtime leaves", () => {
    test("the gateway's own listing is what gets written", async () => {
        const dir = cacheDir();
        await recordLocalCatalog("outrider", "ling3-tiny", {
            cacheDir: dir,
            fetch: listing(["ling3-tiny", "qwen35-2b"]),
        });
        const snapshot = readProviderCatalogSnapshot("outrider", { cacheDir: dir });
        expect(snapshot.fetched_at).toBeDefined();
        expect(snapshot.models.map((model) => model.id)).toEqual([
            "ling3-tiny",
            "qwen35-2b",
        ]);
    });

    test("a listing that cannot be read still leaves the model that answered", async () => {
        const dir = cacheDir();
        await recordLocalCatalog("outrider", "ling3-tiny", {
            cacheDir: dir,
            fetch: (async () => {
                throw new Error("connection refused");
            }) as unknown as typeof fetch,
        });
        expect(readProviderCatalogSnapshot("outrider", { cacheDir: dir })
            .models.map((model) => model.id)).toEqual(["ling3-tiny"]);
    });

    test("the home counts as having a provider afterwards", async () => {
        const dir = cacheDir();
        expect(connectedProviderCatalogs(undefined, { cacheDir: dir })
            .map((row) => row.id)).not.toContain("outrider");
        await recordLocalCatalog("outrider", "ling3-tiny", {
            cacheDir: dir,
            fetch: listing(["ling3-tiny"]),
        });
        expect(connectedProviderCatalogs(undefined, { cacheDir: dir })
            .map((row) => row.id)).toContain("outrider");
    });

    test("a provider Vera does not run itself is left alone", async () => {
        const dir = cacheDir();
        await recordLocalCatalog("openrouter", "faux/test", {
            cacheDir: dir,
            fetch: listing(["faux/test"]),
        });
        expect(readProviderCatalogSnapshot("openrouter", { cacheDir: dir })
            .fetched_at).toBeUndefined();
    });
});

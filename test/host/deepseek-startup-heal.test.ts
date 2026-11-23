import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig, startingVeraConfig } from "../../src/config.ts";
import {
    providerCatalogCacheDir,
    readProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
} from "../../src/model/catalog-cache.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { configuredProviders } from "../../src/providers/registry.ts";

test("@core DeepSeek host startup heals a broken catalog without migrating the configured model", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-deepseek-startup-"));
    const cacheDir = providerCatalogCacheDir(home);
    try {
        const config = {
            ...startingVeraConfig(),
            provider: "deepseek",
            model: "deepseek-chat",
            disabled_providers: configuredProviders(undefined)
                .filter((provider) => provider.id !== "deepseek")
                .map((provider) => provider.id),
        };
        await Bun.write(join(home, "config.json"), JSON.stringify(config));
        createAuthStorage({ path: join(home, "machine", "auth.json") })
            .setCredential("deepseek", { type: "api_key", key: "fake-key" });
        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "deepseek",
            fetched_at: new Date().toISOString(),
            models: [{ id: "deepseek-chat", label: "deepseek-chat", levels: [] }],
        }, { cacheDir });
        expect(readProviderCatalogSnapshot("deepseek", { cacheDir }).models).toEqual([
            { id: "deepseek-chat", label: "deepseek-chat", levels: [] },
        ]);

        const child = Bun.spawn([process.execPath, join(import.meta.dir, "../support/deepseek-startup-heal-child.ts")], {
            env: {
                PATH: process.env.PATH ?? "",
                HOME: home,
                VERA_HOME: home,
                VERA_DEV_INSTANCE: "deepseek-startup test-build",
                VERA_TEST_MODE: "1",
                USER: "vera-test",
                LOGNAME: "vera-test",
                LANG: "en_US.UTF-8",
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [exit, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });

        const healed = readProviderCatalogSnapshot("deepseek", { cacheDir });
        expect(healed.models.map((model) => ({
            id: model.id,
            levels: model.levels.map((level) => level.id),
            defaultLevel: model.default_level,
        }))).toEqual([
            { id: "deepseek-v4-pro", levels: ["max", "high", "off"], defaultLevel: "high" },
            { id: "deepseek-flash", levels: ["max", "high", "off"], defaultLevel: "high" },
        ]);
        expect(loadVeraConfig({ path: join(home, "config.json") }).model).toBe("deepseek-chat");
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

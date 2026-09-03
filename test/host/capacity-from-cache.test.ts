import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VeraConfig } from "../../src/config.ts";
import { configuredCatalog } from "../../src/host/runtime.ts";
import { settingsForClient } from "../../src/host/agent-registry/helpers.ts";
import { writeProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import { COMPACTION_TRIGGER_FRACTION } from "../../src/engine/compaction-scheduler.ts";

const homes: string[] = [];
const originalHome = process.env.VERA_HOME;

function isolatedHome(): string {
    const home = mkdtempSync(join(tmpdir(), "vera-capacity-"));
    homes.push(home);
    process.env.VERA_HOME = home;
    return home;
}

afterEach(() => {
    if (originalHome === undefined) {
        delete process.env.VERA_HOME;
    } else {
        process.env.VERA_HOME = originalHome;
    }
    while (homes.length > 0) {
        rmSync(homes.pop()!, { recursive: true, force: true });
    }
});

const CONFIG = {
    provider: "outrider_t1",
    model: "gemma4-26b",
    context_limit: 204_800,
    providers: {
        outrider_t1: {
            protocol: "openai-chat",
            base_url: "http://127.0.0.1:11435/v1",
        },
    },
} as unknown as VeraConfig;

test("a local model's window is read back from its discovery cache", () => {
    const home = isolatedHome();
    writeProviderCatalogSnapshot({
        schema_version: 2,
        provider: "outrider_t1",
        fetched_at: new Date().toISOString(),
        models: [{ id: "gemma4-26b", label: "gemma4-26b", context_window: 32_768, levels: [] }],
    }, { cacheDir: join(home, "runtime", "cache") });

    const models = configuredCatalog(CONFIG);
    const settings = settingsForClient(
        { model: "gemma4-26b" },
        "outrider_t1",
        {},
        models,
        [],
        undefined,
        undefined,
        undefined,
        CONFIG.context_limit,
    );

    expect(settings.contextWindow).toBe(32_768);
});

test("without the cache the window is unknown, and compaction is set past the wall", () => {
    isolatedHome();

    const models = configuredCatalog(CONFIG);
    const settings = settingsForClient(
        { model: "gemma4-26b" },
        "outrider_t1",
        {},
        models,
        [],
        undefined,
        undefined,
        undefined,
        CONFIG.context_limit,
    );

    expect(settings.contextWindow).toBeUndefined();
});

test("a resolved window puts the compaction trigger inside the model's reach", () => {
    const home = isolatedHome();
    writeProviderCatalogSnapshot({
        schema_version: 2,
        provider: "outrider_t1",
        fetched_at: new Date().toISOString(),
        models: [{ id: "gemma4-26b", label: "gemma4-26b", context_window: 32_768, levels: [] }],
    }, { cacheDir: join(home, "runtime", "cache") });

    const models = configuredCatalog(CONFIG);
    const settings = settingsForClient(
        { model: "gemma4-26b" },
        "outrider_t1",
        {},
        models,
        [],
        undefined,
        undefined,
        undefined,
        CONFIG.context_limit,
    );

    const trigger = settings.contextWindow! * COMPACTION_TRIGGER_FRACTION;
    expect(trigger).toBeLessThan(32_768);
    expect(trigger).toBeLessThan(100_000);
});

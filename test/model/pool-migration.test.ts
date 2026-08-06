import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateConfigPool } from "../../src/model/pool-migration.ts";
import { readUserPoolFile } from "../../src/model/pool-file-store.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

interface Paths {
    readonly configPath: string;
    readonly poolPath: string;
}

function paths(config: unknown, pool?: unknown): Paths {
    const directory = mkdtempSync(join(tmpdir(), "vera-pool-migration-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    const poolPath = join(directory, "pool.json");
    if (config !== undefined) {
        writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
    if (pool !== undefined) {
        writeFileSync(poolPath, JSON.stringify(pool, null, 2));
    }
    return { configPath, poolPath };
}

test("old pool entries move into the pool file with their probe as learned", () => {
    const scope = paths({
        model: "m",
        pool: [
            {
                provider: "cerebras",
                model: "newer",
                verification: {
                    verified_at: "2026-07-01",
                    response_model: "newer-2026",
                    checked: "user_key",
                    levels: [
                        { vera_effort: "high", provider_effort: "high" },
                        { vera_effort: "none", provider_effort: "none" },
                    ],
                },
            },
            { provider: "cerebras", model: "older" },
        ],
    });

    const outcome = migrateConfigPool(scope);

    expect(outcome.migrated).toEqual(["cerebras/newer", "cerebras/older"]);
    expect(outcome.notice).toContain("Moved 2 pooled models");
    const file = readUserPoolFile({ path: scope.poolPath });
    expect(Object.keys(file.models)).toEqual(["cerebras/newer", "cerebras/older"]);
    expect(file.models["cerebras/newer"]?.learned).toEqual({
        probe: {
            ok: true,
            seen: "2026-07-01",
            wire: "newer-2026",
            checked: "user_key",
        },
        "efforts.high": {
            ok: true,
            seen: "2026-07-01",
            wire: "high",
            checked: "user_key",
        },
        "efforts.off": {
            ok: true,
            seen: "2026-07-01",
            wire: "none",
            checked: "user_key",
        },
    });
    expect(file.models["cerebras/older"]).toEqual({});
});

test("the old config keys are left exactly as they were", () => {
    const scope = paths({ pool: [{ provider: "cerebras", model: "m" }] });
    const before = readFileSync(scope.configPath, "utf8");

    migrateConfigPool(scope);

    expect(readFileSync(scope.configPath, "utf8")).toBe(before);
});

test("the legacy pinned list migrates when there is no pool key", () => {
    const scope = paths({ pinned: ["cerebras/a", "openrouter/b", "junk"] });

    const outcome = migrateConfigPool(scope);

    expect(outcome.migrated).toEqual(["cerebras/a", "openrouter/b"]);
});

test("an existing pool file is never migrated over", () => {
    const scope = paths(
        { pool: [{ provider: "cerebras", model: "m" }] },
        { models: { "cerebras/kept": {} } },
    );

    const outcome = migrateConfigPool(scope);

    expect(outcome.migrated).toEqual([]);
    expect(outcome.notice).toBeUndefined();
    expect(Object.keys(readUserPoolFile({ path: scope.poolPath }).models))
        .toEqual(["cerebras/kept"]);
});

test("a record already flagged for reverification brings no learned facts", () => {
    const scope = paths({
        pool: [{
            provider: "cerebras",
            model: "m",
            verification: {
                verified_at: "2026-07-01",
                response_model: "m",
                checked: "user_key",
                levels: [{ vera_effort: "high", provider_effort: "high" }],
                needs_reverify: true,
            },
        }],
    });

    migrateConfigPool(scope);

    expect(readUserPoolFile({ path: scope.poolPath }).models["cerebras/m"])
        .toEqual({});
});

test("no config file at all migrates nothing", () => {
    const scope = paths(undefined);

    expect(migrateConfigPool(scope).migrated).toEqual([]);
});

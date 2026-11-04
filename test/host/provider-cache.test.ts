import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { providerCatalogsOf } from "../../src/host/model-catalog-settings.ts";
import { subagentPoolPolicy } from "../../src/host/subagent-policy.ts";
import { effectiveCatalog } from "../../src/model/catalog.ts";
import { providerCatalogCachePath, writeProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import { writeCuratedCache } from "../../src/model/curated-models.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { connectedProviderCatalogs, modelsFromConnectedCatalogs } from "../../src/providers/catalog-state.ts";

function temporaryHome(): string {
    const parent = join(tmpdir(), "vera-dev");
    fs.mkdirSync(parent, { recursive: true });
    return fs.mkdtempSync(join(parent, "pc-"));
}

const declaration = {
    protocol: "openai-chat" as const,
    base_url: "http://127.0.0.1:9/v1",
    credential: "api_key" as const,
    api_key_env: "PIRATE_CROW_KEY",
};

const rows = Array.from({ length: 60 }, (_, index) => ({
    id: `pirate-crow-${index}`,
    label: `Pirate crow ${index}`,
    tool_support: true,
    levels: [{ id: "high", label: "High" }],
}));

const boot = {
    schema_version: 1,
    provider: "ollama",
    model: rows[0]!.id,
    approval_mode: "ask",
    providers: { "pirate-crow": declaration },
    models: rows.map((row) => ({ name: row.id, provider: "ollama", model: row.id })),
    model_routes: {},
    reviewer_profiles: {},
};

const pool = {
    models: Object.fromEntries(rows.map((row) => [`ollama/${row.id}`, {
        added: true,
        learned: { probe: { ok: true, seen: "2026-11-04" } },
    }])),
};

test("warm host settings and policy reads reuse catalogs and follow live inputs", async () => {
    const home = temporaryHome();
    const previousHome = process.env.VERA_HOME;
    const previousPool = process.env.VERA_POOL_FILE;
    process.env.VERA_HOME = home;
    process.env.VERA_POOL_FILE = join(home, "pool.json");
    const configPath = join(home, "config.json");
    const authStorage = createAuthStorage({ path: join(home, "auth.json") });
    fs.writeFileSync(configPath, JSON.stringify(boot));
    fs.writeFileSync(process.env.VERA_POOL_FILE, JSON.stringify(pool));
    writeProviderCatalogSnapshot({ schema_version: 2, provider: "ollama", models: rows });
    const host = await startResidentHost({
        config: loadVeraConfig({ path: configPath }),
        configPath,
        createAdapter: () => ({ stream() { throw new Error("unused"); } }),
        authStorage,
        socketPath: join(home, "h.sock"),
        lockPath: join(home, "host.json"),
        sessionDirectory: join(home, "sessions"),
        eventLogDirectory: join(home, "logs"),
    });
    const readPolicy = () => host.registry.options.readPolicy!(home);
    const readSettings = () => host.registry.readHostModelSettings(home);
    try {
        const catalog = effectiveCatalog("ollama");
        const policy = subagentPoolPolicy({ projectRoot: home, config: loadVeraConfig({ path: configPath }) });
        const settings = readSettings();
        readPolicy();
        const reads = spyOn(fs, "readFileSync");
        const lists = spyOn(fs, "readdirSync");
        try {
            for (let index = 0; index < 5; index++) {
                expect(effectiveCatalog("ollama")).toBe(catalog);
                expect(subagentPoolPolicy({ projectRoot: home, config: loadVeraConfig({ path: configPath }) })).toBe(policy);
                expect(readSettings()).toEqual(settings);
                readPolicy();
            }
            const definitions = (path: unknown) => String(path).includes("/providers/definitions");
            expect(reads.mock.calls.filter(([path]) => definitions(path))).toHaveLength(0);
            expect(lists.mock.calls.filter(([path]) => definitions(path))).toHaveLength(0);
        } finally {
            reads.mockRestore();
            lists.mockRestore();
        }

        fs.writeFileSync(configPath, JSON.stringify({
            ...boot,
            model_assignments: { subagents: { models: [], allow_self: true } },
            providers: { "pirate-crow": { ...declaration, credential: "none" } },
        }));
        expect(readPolicy().allowSelf).toBe(true);
        expect(providerCatalogsOf(readSettings())?.some((row) => row.id === "pirate-crow")).toBe(true);
        fs.writeFileSync(configPath, "{");
        expect(readPolicy().allowSelf).toBe(true);
        fs.writeFileSync(configPath, JSON.stringify(boot));
        expect(readPolicy().allowSelf).toBeUndefined();

        const ref = `ollama/${rows[0]!.id}`;
        fs.writeFileSync(process.env.VERA_POOL_FILE, JSON.stringify({
            ...pool,
            defaults: { deny: [ref] },
        }));
        expect(readPolicy().deny).toEqual([ref]);
        expect(readSettings().pooled?.some((row) => row.model === rows[0]!.id)).toBe(false);
        const projectPool = join(home, ".vera", "pool.json");
        fs.mkdirSync(join(home, ".vera"));
        fs.writeFileSync(projectPool, JSON.stringify({ defaults: { deny: [] }, models: { [ref]: { displayName: "Captain" } } }));
        expect(readPolicy().deny).toEqual([]);
        expect(readSettings().pooled?.find((row) => row.model === rows[0]!.id)?.label).toBe("Captain");
        fs.unlinkSync(projectPool);
        expect(readPolicy().deny).toEqual([ref]);
        fs.writeFileSync(process.env.VERA_POOL_FILE, JSON.stringify(pool));

        const changed = rows.map((row) => ({ ...row, tool_support: false,
            pricing: { input: 2, output: 4 }, levels: [{ id: "low", label: "Low" }] }));
        writeProviderCatalogSnapshot({ schema_version: 2, provider: "ollama", models: changed });
        expect(readPolicy().tools?.[ref]).toBe(false);
        const listed = readSettings().availableModels?.find((row) => row.model === rows[0]!.id);
        expect(listed?.levels).toEqual(effectiveCatalog("ollama").models[0]?.levels);
        expect(listed?.pricing).toEqual({ input: 2, output: 4 });

        expect(providerCatalogsOf(readSettings())?.some((row) => row.id === "pirate-crow")).toBe(false);
        authStorage.setCredential("pirate-crow", { type: "api_key", key: "test-key" });
        expect(providerCatalogsOf(readSettings())?.some((row) => row.id === "pirate-crow")).toBe(true);
        authStorage.deleteCredential("pirate-crow");
        expect(providerCatalogsOf(readSettings())?.some((row) => row.id === "pirate-crow")).toBe(false);
    } finally {
        await host.close();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        if (previousPool === undefined) delete process.env.VERA_POOL_FILE;
        else process.env.VERA_POOL_FILE = previousPool;
        fs.rmSync(home, { recursive: true, force: true });
    }
}, 30_000);

test("catalog caches follow replacement, deletion, malformed files and curated updates", () => {
    const home = temporaryHome();
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        const path = providerCatalogCachePath("ollama");
        expect(effectiveCatalog("ollama").models).toEqual([]);
        writeProviderCatalogSnapshot({ schema_version: 2, provider: "ollama", models: rows });
        const first = effectiveCatalog("ollama");
        expect(first.models).toHaveLength(60);
        const stamp = fs.statSync(path);
        const text = fs.readFileSync(path, "utf8").replaceAll("Pirate crow", "Golden crow");
        fs.writeFileSync(`${path}.new`, text);
        fs.utimesSync(`${path}.new`, stamp.atime, stamp.mtime);
        fs.renameSync(`${path}.new`, path);
        expect(effectiveCatalog("ollama").models[0]?.label).toBe("Golden crow 0");
        fs.writeFileSync(path, "{");
        expect(effectiveCatalog("ollama").models).toEqual([]);
        fs.unlinkSync(path);
        expect(effectiveCatalog("ollama").models).toEqual([]);
        writeProviderCatalogSnapshot({ schema_version: 2, provider: "ollama", models: rows });
        writeCuratedCache({ fetched_at: "2026-11-04", list: {
            schema_version: 3, updated_at: "2026-11-04", models: [{ make: "crow", model: rows[0]!.id }],
        } });
        expect(effectiveCatalog("ollama").models.find((row) => row.id === rows[0]!.id)?.recommended).toBe(true);
        writeCuratedCache({ fetched_at: "2026-11-04", list: {
            schema_version: 3, updated_at: "2026-11-04", models: [],
        } });
        expect(effectiveCatalog("ollama").models.find((row) => row.id === rows[0]!.id)?.recommended).toBeUndefined();
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("provider facts follow environment credentials, auth storage and cache directories", () => {
    const home = temporaryHome();
    const config = { ...loadVeraConfigFixture(), providers: { "pirate-crow": declaration } };
    const env: Record<string, string | undefined> = {};
    const authStorage = createAuthStorage({ path: join(home, "auth.json") });
    const options = { cacheDir: join(home, "a"), env, authStorage };
    try {
        expect(connectedProviderCatalogs(config, options)).toEqual([]);
        env.PIRATE_CROW_KEY = "test-key";
        const connected = connectedProviderCatalogs(config, options);
        expect(connected.map((row) => row.id)).toEqual(["pirate-crow"]);
        expect(connectedProviderCatalogs(config, options)).toBe(connected);
        writeProviderCatalogSnapshot({ schema_version: 2, provider: "pirate-crow", models: [rows[0]!], fetched_at: "2026-11-04" }, options);
        expect(modelsFromConnectedCatalogs(config, [], options).map((row) => row.model)).toEqual([rows[0]!.id]);
        expect(modelsFromConnectedCatalogs(config, [], { ...options, cacheDir: join(home, "b") })).toEqual([]);
        delete env.PIRATE_CROW_KEY;
        expect(modelsFromConnectedCatalogs(config, [], options)).toEqual([]);
        authStorage.setCredential("pirate-crow", { type: "api_key", key: "test-key" });
        expect(modelsFromConnectedCatalogs(config, [], options)).toHaveLength(1);
        fs.unlinkSync(join(home, "auth.json"));
        expect(modelsFromConnectedCatalogs(config, [], options)).toEqual([]);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

function loadVeraConfigFixture() {
    return { schema_version: 1 as const, provider: "ollama", model: rows[0]!.id, approval_mode: "ask" as const };
}

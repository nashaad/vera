import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLiveVeraConfigReader, loadVeraConfig, type VeraConfig } from "../../src/config.ts";
import { createConsumerRegistry } from "../../src/host/consumers.ts";
import { createExtensionConfigWatch } from "../../src/host/extension-config-watch.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import type { HostLogEntry } from "../../src/host/host-log.ts";
import { inProcessExtensionBootstrap, workerSessionOptions } from "../../src/host/pool/in-process.ts";
import { processWorkerStartOptions } from "../../src/host/pool/process-worker.ts";
import { startSessionHost, type StartSessionHostOptions } from "../../src/host/session-host.ts";
import { StartupFindings } from "../../src/host/startup-findings.ts";
import { workerPluginSnapshot } from "../../src/plugins/catalog.ts";
import { migratePluginsIn } from "../../src/plugins/migrate.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function fixture() {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "vera-plugin-migrate-startup-"));
    try {
        const home = join(root, "selected-home");
        mkdirSync(home, { recursive: true });
        return { root, home };
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
}

function legacy(home: string, id: string): string {
    const path = join(home, "extensions", id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "vera.extension.json"), JSON.stringify({
        id, version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: ["commands.register"],
    }));
    writeFileSync(join(path, "extension.ts"), "export function activate() {}\n");
    return path;
}

function configAt(home: string, entries: readonly { path: string; config: Record<string, unknown> }[]): VeraConfig {
    const path = join(home, "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto",
        extensions: entries.map((entry) => ({ ...entry, enabled: true })),
    }));
    return loadVeraConfig({ path });
}

async function openHost(
    home: string,
    initial: VeraConfig,
    ids: readonly string[],
    sessionWorker = false,
    beforeStart?: () => void,
) {
    const inbox = Inbox.open(join(home, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(createConsumerRegistry(inbox));
    const findings = new StartupFindings();
    const logs: HostLogEntry[] = [];
    const configPath = join(home, "config.json");
    const currentConfig = createLiveVeraConfigReader(initial, { path: configPath });
    try {
        beforeStart?.();
        const sessionOptions: StartSessionHostOptions = {
            sessions: "all", home, configPath, config: initial, currentConfig,
            currentReachability: () => () => true,
            cacheDirectory: join(home, "catalog"), sessionDirectory: join(home, "sessions"),
            sessionIdentityReservationRoot: home, blockedDirectory: join(home, "blocked"),
            modelFailureLedgerPath: join(home, "failures.jsonl"),
            authStorage: createAuthStorage({ path: join(home, "auth.json") }),
            createAdapter: () => new FauxAdapter([]),
            hostLog: (entry) => logs.push(entry), startupLog: (entry) => logs.push(entry),
            startupFindings: findings, timed: async (_phase, run) => await run(),
            createServices: () => ({ models: {}, inboxDelivery: delivery }),
            processObservations: {}, disableTurnWorker: true,
            availableExtensionIds: ["vera.session-identity", ...ids],
            ...(sessionWorker ? { sessionWorker: true } : {}),
            turnsHeld: () => false, inboxActorForSession: () => null, annexUrl: () => undefined,
            forgetRestartRecords: () => {}, recentScheduleRuns: () => [], onWorkChanged: () => () => {},
        };
        const host = await startSessionHost(sessionOptions);
        return {
            host, sessionOptions, logs, findings,
            async close() {
                try { await host.close(); } finally { delivery.close(); inbox.close(); }
            },
        };
    } catch (error) {
        delivery.close();
        inbox.close();
        throw error;
    }
}

async function expectWorkersHaveNoDrift(
    opened: Awaited<ReturnType<typeof openHost>>,
    home: string,
    initial: VeraConfig,
    id: string,
) {
    const sessionOptions = workerSessionOptions(opened.sessionOptions, opened.host);
    const bootstrap = inProcessExtensionBootstrap(opened.host);
    const processOptions = processWorkerStartOptions({ config: initial, home }, sessionOptions, opened.host.pluginWorkerExtensions);
    const serialized = JSON.parse(JSON.stringify(processOptions)) as typeof processOptions;
    const path = join(home, "plugins", id, "host");
    expect(sessionOptions.config.extensions).toContainEqual(expect.objectContaining({ path, config: { color: "blue" } }));
    expect(serialized.config).toEqual(sessionOptions.config);
    if (existsSync(sessionOptions.configPath)) {
        const staleWatch = createExtensionConfigWatch({
            configPath: sessionOptions.configPath,
            config: initial,
            currentConfig: sessionOptions.currentConfig,
            pluginSnapshot: workerPluginSnapshot(home, bootstrap.pluginWorkerExtensions),
        });
        expect(staleWatch.drift()).toContainEqual({ operation: "update", id, needsRestart: true });
    }

    for (const options of [
        sessionOptions,
        {
            ...sessionOptions,
            config: serialized.config,
            currentConfig: createLiveVeraConfigReader(serialized.config, { path: sessionOptions.configPath }),
        },
    ]) {
        const worker = await startSessionHost({ ...options, ...bootstrap, sessionWorker: true });
        try {
            expect(worker.registry.options.readExtensionConfigDrift?.()).toEqual([]);
        } finally {
            await worker.close();
        }
    }
}

function noSignals() {
    return spyOn(process, "kill").mockImplementation(() => { throw new Error("Unexpected process signal"); });
}

async function closeFixture(
    root: string,
    signals: ReturnType<typeof noSignals>,
    opened: Awaited<ReturnType<typeof openHost>> | undefined,
    checkSignals: () => void = () => { expect(signals).not.toHaveBeenCalled(); },
): Promise<void> {
    try {
        await opened?.close();
        checkSignals();
    } finally {
        try { signals.mockRestore(); } finally { rmSync(root, { recursive: true, force: true }); }
    }
}

test("host startup migrates the selected home and loads rewritten extension config", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const path = legacy(f.home, "crow.start");
        const config = configAt(f.home, [{ path, config: { color: "blue" } }]);
        opened = await openHost(f.home, config, ["crow.start"]);
        expect(opened.host.extensions.extensionIds()).toContain("crow.start");
        expect(opened.host.pluginWorkerExtensions.entries).toContainEqual(expect.objectContaining({
            id: "crow.start", directory: join(f.home, "plugins", "crow.start", "host"), config: { color: "blue" },
        }));
        expect(existsSync(join(f.home, "extensions.pre-plugins", "crow.start"))).toBe(true);
        expect(existsSync(join(f.home, "machine", "plugins.json"))).toBe(true);
        expect(existsSync(join(f.home, ".vera"))).toBe(false);
        expect(opened.logs).toContainEqual(expect.objectContaining({ type: "host_startup_plugin_migration", outcome: "completed" }));
        expect(opened.findings.contributions()).toEqual([]);
        await expectWorkersHaveNoDrift(opened, f.home, config, "crow.start");
    } finally {
        await closeFixture(f.root, signals, opened);
    }
});

test("a held plugin lock skips startup migration and leaves the legacy extension active", async () => {
    const f = fixture();
    const signals = noSignals();
    signals.mockImplementation((pid, signal) => {
        if (pid === process.pid && signal === 0) return true;
        throw new Error("Unexpected process signal");
    });
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const path = legacy(f.home, "crow.locked");
        const config = configAt(f.home, [{ path, config: { color: "blue" } }]);
        mkdirSync(join(f.home, "machine"), { recursive: true });
        const lock = join(f.home, "machine", "plugins.json.lock");
        const owner = JSON.stringify({ pid: process.pid });
        writeFileSync(lock, owner);
        opened = await openHost(f.home, config, ["crow.locked"]);
        expect(opened.host.extensions.extensionIds()).toContain("crow.locked");
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(lock, "utf8")).toBe(owner);
        expect(existsSync(join(f.home, "machine", "plugins.json"))).toBe(false);
        expect(opened.logs).toContainEqual(expect.objectContaining({
            type: "host_startup_plugin_migration", outcome: "skipped", message: expect.stringContaining("Plugin migration skipped"),
        }));
        expect(opened.findings.contributions()).toEqual([]);
    } finally {
        await closeFixture(f.root, signals, opened, () => {
            expect(signals).toHaveBeenCalledTimes(1);
            expect(signals).toHaveBeenCalledWith(process.pid, 0);
        });
    }
});

test("a failed startup migration is logged while the legacy extension remains active", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const path = legacy(f.home, "crow.large");
        writeFileSync(join(path, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        const config = configAt(f.home, [{ path, config: { color: "blue" } }]);
        opened = await openHost(f.home, config, ["crow.large"]);
        expect(opened.host.extensions.extensionIds()).toContain("crow.large");
        expect(existsSync(path)).toBe(true);
        expect(existsSync(join(f.home, "extensions.pre-plugins"))).toBe(false);
        expect(opened.logs).toContainEqual(expect.objectContaining({
            type: "host_startup_plugin_migration", outcome: "failed", message: expect.stringContaining("larger than"),
        }));
        expect(opened.findings.contributions()).toEqual([]);
    } finally {
        await closeFixture(f.root, signals, opened);
    }
});

test("a session worker does not run migration", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const path = legacy(f.home, "crow.worker");
        const config = configAt(f.home, [{ path, config: {} }]);
        opened = await openHost(f.home, config, ["crow.worker"], true);
        expect(existsSync(path)).toBe(true);
        expect(existsSync(join(f.home, "machine", "plugins.json"))).toBe(false);
        expect(opened.logs.some((entry) => entry.type === "host_startup_plugin_migration")).toBe(false);
    } finally {
        await closeFixture(f.root, signals, opened);
    }
});

test("partial startup migration keeps both the migrated config and a held-back extension", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const good = legacy(f.home, "crow.good");
        const held = legacy(f.home, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        const config = configAt(f.home, [
            { path: good, config: { color: "blue" } }, { path: held, config: { color: "red" } },
        ]);
        opened = await openHost(f.home, config, ["crow.good", "crow.large"]);
        expect(opened.host.extensions.extensionIds()).toContain("crow.good");
        expect(opened.host.extensions.extensionIds()).toContain("crow.large");
        expect(opened.host.pluginWorkerExtensions.entries).toContainEqual(expect.objectContaining({
            id: "crow.good", config: { color: "blue" }, directory: join(f.home, "plugins", "crow.good", "host"),
        }));
        expect(existsSync(good)).toBe(true);
        expect(existsSync(held)).toBe(true);
        expect(opened.logs).toContainEqual(expect.objectContaining({ type: "host_startup_plugin_migration", outcome: "partial" }));
        expect(opened.findings.contributions()).toEqual([]);
    } finally {
        await closeFixture(f.root, signals, opened);
    }
});

test("startup remaps an already-read config even when the config file is absent", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const path = legacy(f.home, "crow.memory");
        const config: VeraConfig = {
            schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto",
            extensions: [{ path, enabled: true, config: { color: "blue" } }],
        };
        opened = await openHost(f.home, config, ["crow.memory"]);
        expect(opened.host.extensions.extensionIds()).toContain("crow.memory");
        expect(opened.host.pluginWorkerExtensions.entries).toContainEqual(expect.objectContaining({
            id: "crow.memory", config: { color: "blue" }, directory: join(f.home, "plugins", "crow.memory", "host"),
        }));
        expect(opened.host.registry.options.workerExtensions?.().map((entry) => entry.path)).not.toContain(path);
        expect(opened.findings.contributions()).toEqual([]);
        await expectWorkersHaveNoDrift(opened, f.home, config, "crow.memory");
    } finally {
        await closeFixture(f.root, signals, opened);
    }
});

test("a config rewrite failure rolls back startup migration and still loads legacy", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const path = legacy(f.home, "crow.config");
        const config = configAt(f.home, [{ path, config: { color: "blue" } }]);
        mkdirSync(join(f.home, "machine"), { recursive: true });
        mkdirSync(join(f.home, "plugins"), { recursive: true });
        try {
            opened = await openHost(f.home, config, ["crow.config"], false, () => chmodSync(f.home, 0o555));
        } finally { chmodSync(f.home, 0o755); }
        expect(opened.host.extensions.extensionIds()).toContain("crow.config");
        expect(existsSync(path)).toBe(true);
        expect(existsSync(join(f.home, "extensions.pre-plugins"))).toBe(false);
        expect(existsSync(join(f.home, "plugins", "crow.config"))).toBe(false);
        expect(JSON.parse(readFileSync(join(f.home, "machine", "plugins.json"), "utf8")).plugins).toEqual([]);
        expect(opened.logs).toContainEqual(expect.objectContaining({
            type: "host_startup_plugin_migration", outcome: "failed", message: expect.stringContaining("Config rewrite failed"),
        }));
        expect(opened.findings.contributions()).toEqual([]);
    } finally {
        try { chmodSync(f.home, 0o755); } finally { await closeFixture(f.root, signals, opened); }
    }
});

test("a corrupt plugin registry logs startup migration failure and keeps legacy loading", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const path = legacy(f.home, "crow.corrupt");
        const config = configAt(f.home, [{ path, config: {} }]);
        mkdirSync(join(f.home, "machine"), { recursive: true });
        writeFileSync(join(f.home, "machine", "plugins.json"), "{ not json");
        opened = await openHost(f.home, config, ["crow.corrupt"]);
        expect(opened.host.extensions.extensionIds()).toContain("crow.corrupt");
        expect(existsSync(path)).toBe(true);
        expect(opened.logs).toContainEqual(expect.objectContaining({
            type: "host_startup_plugin_migration", outcome: "failed", message: expect.stringContaining("not valid JSON"),
        }));
        expect(opened.findings.contributions()).toEqual([]);
    } finally {
        await closeFixture(f.root, signals, opened);
    }
});

test("a fresh host does not create migration state", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const config: VeraConfig = { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" };
        opened = await openHost(f.home, config, []);
        expect(existsSync(join(f.home, "machine", "plugins.json"))).toBe(false);
        expect(existsSync(join(f.home, "machine", "plugins.json.lock"))).toBe(false);
        expect(opened.logs.some((entry) => entry.type === "host_startup_plugin_migration")).toBe(false);
        expect(opened.findings.contributions()).toEqual([]);
    } finally {
        await closeFixture(f.root, signals, opened);
    }
});

test("host startup leaves desktop installs alone after the desktop store migrated", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const desktop = join(f.home, "machine", "desktop", "extensions");
        const seed = (id: string) => {
            const path = join(desktop, id);
            mkdirSync(path, { recursive: true });
            writeFileSync(join(path, "vera.desktop.json"), JSON.stringify({ id, version: "1.0.0", engine: "vera-gui@^1" }));
            return path;
        };
        seed("crow.theme");
        expect(migratePluginsIn(f.home).report.failures).toEqual([]);
        const registryPath = join(f.home, "machine", "plugins.json");
        const registry = readFileSync(registryPath, "utf8");
        const later = seed("gull.theme");
        const config: VeraConfig = { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" };
        opened = await openHost(f.home, config, []);
        expect(existsSync(later)).toBe(true);
        expect(existsSync(join(f.home, "plugins", "gull.theme"))).toBe(false);
        expect(readFileSync(registryPath, "utf8")).toBe(registry);
        expect(opened.logs.some((entry) => entry.type === "host_startup_plugin_migration")).toBe(false);
        expect(opened.findings.contributions()).toEqual([]);
    } finally {
        await closeFixture(f.root, signals, opened);
    }
});

test("startup migration preserves managed state over an explicit config state", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const path = legacy(f.home, "crow.off");
        writeFileSync(join(f.home, "extensions.json"), JSON.stringify({
            schema_version: 1,
            extensions: [{
                id: "crow.off", version: "1.0.0", source: { kind: "local", path },
                digest: `sha256:${"0".repeat(64)}`, directory: "extensions/crow.off",
                enabled: false, installedAt: "2026-01-01T00:00:00.000Z",
            }],
        }));
        const config = configAt(f.home, [{ path, config: { color: "blue" } }]);
        expect(config.extensions?.find((entry) => entry.path === path)?.enabled).toBe(false);
        opened = await openHost(f.home, config, ["crow.off"]);
        const registry = JSON.parse(readFileSync(join(f.home, "machine", "plugins.json"), "utf8"));
        expect(registry.plugins[0]).toMatchObject({ name: "crow.off", enabled: false });
        expect(opened.host.extensions.extensionIds()).not.toContain("crow.off");
        expect(opened.findings.contributions()).toEqual([]);
    } finally {
        await closeFixture(f.root, signals, opened);
    }
});

test("startup migration refuses a desktop store outside the selected home", async () => {
    const f = fixture();
    const signals = noSignals();
    let opened: Awaited<ReturnType<typeof openHost>> | undefined;
    try {
        const path = legacy(f.home, "crow.boundary");
        const config = configAt(f.home, [{ path, config: {} }]);
        const outside = join(f.root, "outside-home");
        mkdirSync(join(outside, "extensions", "crow.desktop"), { recursive: true });
        writeFileSync(join(outside, "extensions", "crow.desktop", "vera.desktop.json"), JSON.stringify({
            id: "crow.desktop", version: "1.0.0", engine: "vera-gui@^1",
        }));
        mkdirSync(join(f.home, "machine"), { recursive: true });
        symlinkSync(outside, join(f.home, "machine", "desktop"));
        opened = await openHost(f.home, config, ["crow.boundary"]);
        expect(opened.host.extensions.extensionIds()).toContain("crow.boundary");
        expect(existsSync(path)).toBe(true);
        expect(existsSync(join(outside, "extensions", "crow.desktop"))).toBe(true);
        expect(existsSync(join(outside, "extensions.pre-plugins"))).toBe(false);
        expect(opened.logs).toContainEqual(expect.objectContaining({
            type: "host_startup_plugin_migration", outcome: "failed", message: expect.stringContaining("symlink"),
        }));
        expect(opened.findings.contributions()).toEqual([]);
    } finally {
        await closeFixture(f.root, signals, opened);
    }
});

import { expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { startSessionHost } from "../../src/host/session-host.ts";
import { StartupFindings } from "../../src/host/startup-findings.ts";
import { defaultHostLogPath, type HostLog } from "../../src/host/host-log.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { installPlugin, setPluginEnabled } from "../../src/plugins/manager.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";
import { readPluginCatalog, type PluginWorkerExtensions } from "../../src/plugins/catalog.ts";
import * as pluginRegistry from "../../src/plugins/registry.ts";
import { processWorkerStartOptions } from "../../src/host/pool/process-worker.ts";
import { inProcessExtensionBootstrap } from "../../src/host/pool/in-process.ts";
import type { WorkerBootstrap } from "../../src/host/pool/worker-control.ts";
import { startSessionWorkerRuntime } from "../../src/host/runtime.ts";
import { ScheduleStore } from "../../src/scheduler/store.ts";
import type { VeraExtensionConfig } from "../../src/config.ts";

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "auto",
} as const;

async function openSessionHost(
    home: string,
    options: {
        readonly hostLog?: HostLog;
        readonly startupLog?: HostLog;
        readonly startupFindings?: StartupFindings;
        readonly sessionWorker?: boolean;
        readonly pluginWorkerExtensions?: PluginWorkerExtensions;
        readonly availableExtensionIds?: readonly string[];
        readonly extensions?: readonly VeraExtensionConfig[];
        readonly disabledIncluded?: readonly string[];
    } = {},
) {
    const inbox = Inbox.open(join(home, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(createConsumerRegistry(inbox));
    const startupConfig = {
        ...config,
        ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
        ...(options.disabledIncluded === undefined ? {} : { disabled_included_extensions: options.disabledIncluded }),
    };
    try {
        const host = await startSessionHost({
            sessions: "all",
            config: startupConfig,
            currentConfig: () => startupConfig,
            currentReachability: () => () => true,
            home,
            configPath: join(home, "config.json"),
            cacheDirectory: join(home, "catalog"),
            sessionDirectory: join(home, "sessions"),
            sessionIdentityReservationRoot: home,
            blockedDirectory: join(home, "blocked"),
            modelFailureLedgerPath: join(home, "failures.jsonl"),
            authStorage: createAuthStorage({ path: join(home, "auth.json") }),
            createAdapter: () => new FauxAdapter([]),
            hostLog: options.hostLog ?? (() => {}),
            startupLog: options.startupLog ?? (() => {}),
            startupFindings: options.startupFindings ?? new StartupFindings(),
            ...(options.sessionWorker === true ? { sessionWorker: true } : {}),
            ...(options.pluginWorkerExtensions === undefined ? {} : { pluginWorkerExtensions: options.pluginWorkerExtensions }),
            ...(options.availableExtensionIds === undefined ? {} : { availableExtensionIds: options.availableExtensionIds }),
            timed: async (_phase, run) => await run(),
            createServices: () => ({ models: {}, inboxDelivery: delivery }),
            turnsHeld: () => false,
            inboxActorForSession: () => null,
            annexUrl: () => undefined,
            forgetRestartRecords: () => {},
            recentScheduleRuns: () => [],
            onWorkChanged: () => () => {},
        });
        host.startStorage();
        return {
            host,
            async close() {
                try {
                    await host.close();
                } finally {
                    delivery.close();
                    inbox.close();
                }
            },
        };
    } catch (error) {
        delivery.close();
        inbox.close();
        throw error;
    }
}

test("a session host persists and restores sessions without a public listener", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-session-host-"));
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home);
        const created = await opened.host.handlers.createAgent({ workspace: home });
        const id = created.id;
        expect(await opened.host.handlers.findAgent(id)).toBe(created);
        expect(await opened.host.handlers.closeAgent(id)).toEqual({
            status: "closed",
            sessionRetained: true,
        });
        expect(await opened.host.handlers.listAgents()).toEqual([
            expect.objectContaining({ id, live: false }),
        ]);
        await opened.close();
        opened = undefined;

        opened = await openSessionHost(home);
        expect(opened.host.registry.find(id)).toBeUndefined();
        expect(await opened.host.handlers.listAgents()).toEqual([
            expect.objectContaining({ id, live: false }),
        ]);
        const restored = await opened.host.handlers.findAgent(id);
        expect(restored?.id).toBe(id);
        expect(await opened.host.handlers.findAgent(id)).toBe(restored);
        expect(await opened.host.handlers.listAgents()).toEqual([
            expect.objectContaining({ id, live: true }),
        ]);
        expect(existsSync(join(home, "runtime", "host.sock"))).toBe(false);
        expect(existsSync(join(home, "runtime", "host.json"))).toBe(false);
    } finally {
        await opened?.close();
        await rm(home, { recursive: true, force: true });
    }
});

test("@core a session host tells the clients its server attaches to a session to open a screen", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-session-host-show-"));
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home);
        const seen: string[] = [];
        const stop = opened.host.handlers.subscribeSessionShow("deck", "window", (target) => seen.push(target.id));
        expect(await opened.host.localExtensionSessions.showInSession("deck", "settings.providers"))
            .toEqual({ window: 1, terminal: 0, terminalCannot: 0 });
        stop();
        expect(await opened.host.localExtensionSessions.showInSession("deck", "settings.providers"))
            .toEqual({ window: 0, terminal: 0, terminalCannot: 0 });
        expect(seen).toEqual(["settings.providers"]);
    } finally {
        await opened?.close();
        await rm(home, { recursive: true, force: true });
    }
});

test("@core plugin snapshot warnings go to the host log, not the startup prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-session-host-plugins-"));
    await mkdir(join(home, "machine"), { recursive: true });
    await writeFile(join(home, "machine", "plugins.json"), "{ not json");
    const logs: Parameters<HostLog>[0][] = [];
    const findings = new StartupFindings();
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home, {
            hostLog: (entry) => logs.push(entry),
            startupFindings: findings,
        });
        expect(logs).toContainEqual(expect.objectContaining({
            type: "host_startup_plugin_warning",
            message: expect.stringContaining("Plugins:"),
        }));
        expect(findings.contributions().some((entry) =>
            entry.content.includes("Plugins:")
        )).toBe(false);
    } finally {
        await opened?.close();
        await rm(home, { recursive: true, force: true });
    }
});

test("@core a changed plugin host id is logged without becoming a startup prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-host-plugin-id-"));
    const home = join(root, ".vera");
    const source = join(root, "source");
    const extension = join(source, "dev.vera", "host");
    await mkdir(extension, { recursive: true });
    await writeFile(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "sea-chest",
    }));
    const manifest = (id: string) => JSON.stringify({
        id, version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
        capabilities: ["commands.register"],
    });
    await writeFile(join(extension, "vera.extension.json"), manifest("crow.original"));
    await writeFile(join(extension, "extension.ts"), "export function activate() {}\n");
    installPlugin(source, { home: root });
    await writeFile(
        join(home, "plugins", "sea-chest", "dev.vera", "host", "vera.extension.json"),
        manifest("crow.changed"),
    );

    const logs: Parameters<HostLog>[0][] = [];
    const findings = new StartupFindings();
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home, {
            hostLog: (entry) => logs.push(entry),
            startupFindings: findings,
        });
        expect(logs).toContainEqual(expect.objectContaining({
            type: "host_startup_plugin_warning",
            message: expect.stringContaining(
                "plugin sea-chest: host extension id crow.changed differs from the recorded id crow.original",
            ),
        }));
        expect(opened.host.extensions.extensionIds()).not.toContain("crow.changed");
        expect(findings.contributions().some((entry) => entry.content.includes("crow.changed"))).toBe(false);
    } finally {
        await opened?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core a session host loads a plugin host extension only while the plugin is on", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-host-plugin-switch-"));
    const home = join(root, ".vera");
    const source = join(root, "source");
    const extension = join(source, "dev.vera", "host");
    await mkdir(extension, { recursive: true });
    await writeFile(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "sea-chest",
    }));
    await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
        id: "crow.bridge", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
        capabilities: ["commands.register"],
    }));
    await writeFile(join(extension, "extension.ts"), `
        export function activate(vera) {
            vera.commands.register({ name: "crow-bridge", description: "Inspect the hold",
                usage: "/crow-bridge", run() { return { kind: "notice", level: "info", text: "ready" }; } });
        }
    `);
    installPlugin(source, { home: root });
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home);
        expect(opened.host.extensions.extensionIds()).toContain("crow.bridge");
        await opened.close();
        opened = undefined;

        setPluginEnabled("sea-chest", false, { home: root });
        opened = await openSessionHost(home);
        expect(opened.host.extensions.extensionIds()).not.toContain("crow.bridge");
    } finally {
        await opened?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core the host log names a suppressed legacy extension and its plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-host-legacy-plugin-"));
    const home = join(root, ".vera");
    const source = join(root, "source");
    const pluginHost = join(source, "dev.vera", "host");
    const legacy = join(home, "extensions", "crow.bridge");
    await mkdir(pluginHost, { recursive: true });
    await mkdir(legacy, { recursive: true });
    await writeFile(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA, name: "sea-chest",
    }));
    const manifest = JSON.stringify({
        id: "crow.bridge", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
        capabilities: ["commands.register"],
    });
    for (const directory of [pluginHost, legacy]) {
        await writeFile(join(directory, "vera.extension.json"), manifest);
        await writeFile(join(directory, "extension.ts"), "export function activate() {}\n");
    }
    installPlugin(source, { home: root });
    const logs: Parameters<HostLog>[0][] = [];
    const findings = new StartupFindings();
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    const signals = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === process.pid && signal === 0) return true;
        throw new Error("Unexpected process signal");
    });
    try {
        await writeFile(join(home, "machine", "plugins.json.lock"), JSON.stringify({ pid: process.pid }));
        opened = await openSessionHost(home, {
            startupLog: (entry) => logs.push(entry),
            startupFindings: findings,
            extensions: [{ path: legacy, enabled: true, config: {} }],
        });
        expect(logs).toContainEqual(expect.objectContaining({
            type: "host_startup_plugin_migration",
            outcome: "skipped",
            message: expect.stringContaining("Plugin migration skipped"),
        }));
        expect(opened.host.extensions.extensionIds()).toContain("crow.bridge");
        expect(logs).toContainEqual(expect.objectContaining({
            type: "host_startup_plugin_warning",
            message: expect.stringContaining("legacy extension crow.bridge"),
        }));
        expect(logs.some((entry) => String(entry.message).includes("plugin sea-chest"))).toBe(true);
        expect(findings.contributions().some((entry) => entry.content.includes("sea-chest"))).toBe(false);
        expect(signals).toHaveBeenCalledTimes(1);
        expect(signals).toHaveBeenCalledWith(process.pid, 0);
    } finally {
        try {
            await opened?.close();
        } finally {
            signals.mockRestore();
            await rm(root, { recursive: true, force: true });
        }
    }
});

test("@core a disabled included id still rejects a colliding plugin host part", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-host-reserved-plugin-"));
    const home = join(root, ".vera");
    const source = join(root, "source");
    const extension = join(source, "dev.vera", "host");
    await mkdir(extension, { recursive: true });
    await writeFile(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA, name: "sea-chest",
    }));
    const manifest = (id: string) => JSON.stringify({
        id, version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
        capabilities: ["commands.register"],
    });
    await writeFile(join(extension, "vera.extension.json"), manifest("crow.original"));
    await writeFile(join(extension, "extension.ts"), "export function activate() {}\n");
    installPlugin(source, { home: root });
    await writeFile(join(home, "plugins", "sea-chest", "dev.vera", "host", "vera.extension.json"), manifest("vera.help"));
    const registryPath = join(home, "machine", "plugins.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
        plugins: { components: { host_extension: string } }[];
    };
    registry.plugins[0]!.components.host_extension = "vera.help";
    await writeFile(registryPath, JSON.stringify(registry));
    const logs: Parameters<HostLog>[0][] = [];
    const findings = new StartupFindings();
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home, {
            startupLog: (entry) => logs.push(entry),
            startupFindings: findings,
            disabledIncluded: ["vera.help"],
        });
        expect(opened.host.extensions.extensionIds()).not.toContain("vera.help");
        expect(logs).toContainEqual(expect.objectContaining({
            type: "host_startup_extension_failed",
            extension_id: "vera.help",
            message: "Duplicate extension ID: vera.help",
        }));
        expect(findings.contributions().some((entry) => entry.content.includes("Duplicate extension ID: vera.help"))).toBe(true);
    } finally {
        await opened?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core a session worker does not read the plugin registry at start", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-session-worker-plugins-"));
    await mkdir(join(home, "machine"), { recursive: true });
    await writeFile(join(home, "machine", "plugins.json"), "{ not json");
    const logs: Parameters<HostLog>[0][] = [];
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home, {
            hostLog: (entry) => logs.push(entry),
            sessionWorker: true,
        });
        expect(logs).not.toContainEqual(expect.objectContaining({
            type: "host_startup_plugin_warning",
        }));
    } finally {
        await opened?.close();
        await rm(home, { recursive: true, force: true });
    }
});

test("@core both session worker paths use the host's frozen plugin extension entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-worker-plugin-"));
    const home = join(root, ".vera");
    async function source(name: string, id: string): Promise<string> {
        const directory = join(root, name);
        const extension = join(directory, "dev.vera", "host");
        await mkdir(extension, { recursive: true });
        await writeFile(join(directory, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA, name,
        }));
        await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
            id, version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
            capabilities: ["hooks.model_middleware"],
        }));
        await writeFile(join(extension, "extension.ts"), `
            import { writeFileSync } from "node:fs";
            import { join } from "node:path";
            export function activate(vera) {
                writeFileSync(join(vera.storage.profile, "settings.json"), JSON.stringify(vera.config));
                vera.hooks.registerModelMiddleware((adapter) => adapter);
            }
        `);
        return directory;
    }
    installPlugin(await source("sea-chest", "crow.bridge"), { home: root });
    installPlugin(await source("crow-off", "crow.off"), { home: root });
    setPluginEnabled("crow-off", false, { home: root });
    const activePath = join(home, "plugins", "sea-chest", "dev.vera", "host");
    const offPath = join(home, "plugins", "crow-off", "dev.vera", "host");
    const legacy = join(home, "extensions", "crow.off");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "vera.extension.json"), JSON.stringify({
        id: "crow.off", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
        capabilities: ["hooks.model_middleware"],
    }));
    await writeFile(join(legacy, "extension.ts"), "export function activate(vera) { vera.hooks.registerModelMiddleware((adapter) => adapter); }\n");
    const mutableConfig = { harbor: "original" };
    const hostEntries = [
        { path: activePath, enabled: false, config: mutableConfig },
        { path: offPath, enabled: true, config: {} },
        { path: legacy, enabled: true, config: {} },
    ];
    let host: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    let worker: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    let withoutBootstrap: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    let processWorker: Awaited<ReturnType<typeof startSessionWorkerRuntime>> | undefined;
    const registryRead = spyOn(pluginRegistry, "readPluginRegistry");
    try {
        host = await openSessionHost(home, { extensions: hostEntries });
        const payload = host.host.pluginWorkerExtensions;
        expect(payload.entries).toMatchObject([{
            plugin: "sea-chest", id: "crow.bridge", directory: activePath,
            enabled: true, config: { harbor: "original" },
        }]);
        expect(payload.owners).toEqual([
            { plugin: "crow-off", id: "crow.off" },
            { plugin: "sea-chest", id: "crow.bridge" },
        ]);
        mutableConfig.harbor = "changed";
        setPluginEnabled("sea-chest", false, { home: root });
        await writeFile(join(home, "machine", "plugins.json"), "{ broken registry");
        registryRead.mockClear();
        readPluginCatalog({ veraHome: home });
        expect(registryRead).toHaveBeenCalledTimes(1);
        registryRead.mockClear();

        const logs: Parameters<HostLog>[0][] = [];
        worker = await openSessionHost(home, {
            sessionWorker: true,
            ...inProcessExtensionBootstrap(host.host),
            extensions: hostEntries,
            hostLog: (entry) => logs.push(entry),
        });
        expect(worker.host.extensions.modelMiddleware().map((item) => item.extensionId)).toContain("crow.bridge");
        expect(worker.host.extensions.extensionIds()).not.toContain("crow.off");
        expect(worker.host.registry.options.workerExtensions?.().some((entry) => entry.path === activePath)).toBe(true);
        expect(JSON.parse(readFileSync(join(home, "extension-data", "crow.bridge", "settings.json"), "utf8")))
            .toEqual({ harbor: "original" });
        expect(logs.some((entry) => String(entry.message).includes("Plugins:"))).toBe(false);

        withoutBootstrap = await openSessionHost(home, {
            sessionWorker: true,
            extensions: [{ path: activePath, enabled: true, config: {} }],
            hostLog: (entry) => logs.push(entry),
        });
        expect(withoutBootstrap.host.extensions.extensionIds()).not.toContain("crow.bridge");
        expect(logs.some((entry) => String(entry.message).includes("Plugins:"))).toBe(false);

        const schedulePath = join(home, "schedules.db");
        ScheduleStore.open(schedulePath).close();
        const hostOptions = {
            config: { ...config, extensions: hostEntries },
            home, inboxPath: join(home, "inbox.db"), schedulePath,
        };
        const bootstrap: WorkerBootstrap = {
            options: processWorkerStartOptions(hostOptions, {
                config: hostOptions.config, home, configPath: join(home, "config.json"), blockedDirectory: join(home, "blocked"),
                modelFailureLedgerPath: join(home, "failures.jsonl"),
            }, payload),
            hostSocket: "unused", lockPath: "unused", buildId: "test", capabilities: [],
            extensionCatalog: { extensionOrder: host.host.extensions.extensionIds(), toolCatalog: [], commandCatalog: [] },
        };
        const decoded = JSON.parse(JSON.stringify(bootstrap)) as WorkerBootstrap;
        processWorker = await startSessionWorkerRuntime(
            { ...decoded.options, createAdapter: () => new FauxAdapter([]) },
            new Map(), undefined, undefined,
            {
                catalog: decoded.extensionCatalog,
                tools: [],
                async invokeCommand() { throw new Error("unused"); },
            },
        );
        expect(processWorker.sessionHost.extensions.modelMiddleware().map((item) => item.extensionId)).toContain("crow.bridge");
        expect(processWorker.sessionHost.extensions.extensionIds()).not.toContain("crow.off");
        expect(JSON.parse(readFileSync(join(home, "extension-data", "crow.bridge", "settings.json"), "utf8")))
            .toEqual({ harbor: "original" });
        expect(registryRead).not.toHaveBeenCalled();
    } finally {
        registryRead.mockRestore();
        await processWorker?.close();
        await withoutBootstrap?.close();
        await worker?.close();
        await host?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core a session worker does not revive a plugin rejected by the host registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-worker-duplicate-"));
    const home = join(root, ".vera");
    const source = join(root, "sea-chest");
    const plugin = join(source, "dev.vera", "host");
    const configured = join(root, "configured");
    const manifest = JSON.stringify({
        id: "crow.shared", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
        capabilities: ["commands.register"],
    });
    async function writeExtension(directory: string, name: string): Promise<void> {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "vera.extension.json"), manifest);
        await writeFile(join(directory, "extension.ts"), `
            export function activate(vera) {
                vera.commands.register({
                    name: ${JSON.stringify(name)}, description: "Inspect", usage: "/inspect",
                    run() { return { kind: "notice", level: "info", text: "ready" }; },
                });
            }
        `);
    }
    await writeExtension(plugin, "plugin-command");
    await writeExtension(configured, "configured-command");
    await writeFile(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA, name: "sea-chest",
    }));
    installPlugin(source, { home: root });
    const entries = [{ path: configured, enabled: true, config: {} }];
    const logs: Parameters<HostLog>[0][] = [];
    let host: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    let worker: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        host = await openSessionHost(home, { extensions: entries, startupLog: (entry) => logs.push(entry) });
        expect(logs).toContainEqual(expect.objectContaining({
            type: "host_startup_extension_failed", extension_id: "crow.shared",
        }));
        expect(host.host.pluginWorkerExtensions.entries).toEqual([]);
        worker = await openSessionHost(home, {
            sessionWorker: true,
            ...inProcessExtensionBootstrap(host.host),
            extensions: entries,
        });
        const commands = worker.host.extensions.commands().map((command) => command.name);
        expect(commands).toContain("configured-command");
        expect(commands).not.toContain("plugin-command");
    } finally {
        await worker?.close();
        await host?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core workers skip replaced and missing plugin packages but load unchanged ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-worker-replaced-"));
    const home = join(root, ".vera");
    const replacementMarker = join(root, "replacement-imported");
    async function source(name: string, id: string, command: string): Promise<string> {
        const directory = join(root, name);
        const extension = join(directory, "dev.vera", "host");
        await mkdir(extension, { recursive: true });
        await writeFile(join(directory, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA, name,
        }));
        await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
            id, version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
            capabilities: ["commands.register"],
        }));
        await writeFile(join(extension, "extension.ts"), `
            export function activate(vera) {
                vera.commands.register({
                    name: ${JSON.stringify(command)}, description: "Inspect", usage: "/inspect",
                    run() { return { kind: "notice", level: "info", text: "ready" }; },
                });
            }
        `);
        return directory;
    }
    let host: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    let worker: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    let processWorker: Awaited<ReturnType<typeof startSessionWorkerRuntime>> | undefined;
    try {
        const replaced = await source("sea-chest", "crow.replaced", "old-command");
        const missing = await source("crow-gone", "crow.gone", "gone-command");
        const unchanged = await source("crow-keep", "crow.keep", "keep-command");
        installPlugin(replaced, { home: root });
        installPlugin(missing, { home: root });
        installPlugin(unchanged, { home: root });
        host = await openSessionHost(home);
        const payload = host.host.pluginWorkerExtensions;
        const original = payload.entries.find((entry) => entry.plugin === "sea-chest")!;
        const packageDirectory = realpathSync(join(home, "plugins", "sea-chest"));
        const details = lstatSync(packageDirectory, { bigint: true });
        expect(original.package_identity).toEqual({
            directory: packageDirectory, dev: details.dev.toString(), ino: details.ino.toString(),
        });
        await writeFile(join(replaced, "dev.vera", "host", "vera.extension.json"), JSON.stringify({
            id: "crow.replaced", version: "2.0.0", sdk: "1", entrypoint: "replacement.ts",
            capabilities: ["commands.register"],
        }));
        await writeFile(join(replaced, "dev.vera", "host", "replacement.ts"), `
            import { writeFileSync } from "node:fs";
            writeFileSync(${JSON.stringify(replacementMarker)}, "imported");
            export function activate(vera) {
                vera.commands.register({
                    name: "new-command", description: "Inspect", usage: "/inspect",
                    run() { return { kind: "notice", level: "info", text: "ready" }; },
                });
            }
        `);
        installPlugin(replaced, { home: root });
        const replacement = lstatSync(packageDirectory, { bigint: true });
        expect([replacement.dev.toString(), replacement.ino.toString()])
            .not.toEqual([original.package_identity.dev, original.package_identity.ino]);
        await rm(join(home, "plugins", "crow-gone"), { recursive: true, force: true });

        const expectedWarnings = ["crow-gone", "sea-chest"].map((plugin) => ({
            type: "host_startup_plugin_warning",
            message: `plugin ${plugin}: the installed package changed or is unavailable; restart the host to load the new version`,
        }));
        const logs: Parameters<HostLog>[0][] = [];
        worker = await openSessionHost(home, {
            sessionWorker: true,
            ...inProcessExtensionBootstrap(host.host),
            hostLog: (entry) => logs.push(entry),
        });
        expect(worker.host.extensions.extensionIds()).toContain("crow.keep");
        expect(worker.host.extensions.extensionIds()).not.toContain("crow.replaced");
        expect(worker.host.extensions.extensionIds()).not.toContain("crow.gone");
        expect(worker.host.extensions.commands().map((command) => command.name)).toContain("keep-command");
        for (const warning of expectedWarnings) expect(logs).toContainEqual(warning);
        expect(existsSync(replacementMarker)).toBe(false);

        const schedulePath = join(home, "schedules.db");
        ScheduleStore.open(schedulePath).close();
        const bootstrap: WorkerBootstrap = {
            options: processWorkerStartOptions({
                config, home, inboxPath: join(home, "inbox.db"), schedulePath,
            }, {
                config, home, configPath: join(home, "config.json"), blockedDirectory: join(home, "blocked"),
                modelFailureLedgerPath: join(home, "failures.jsonl"),
            }, payload),
            hostSocket: "unused", lockPath: "unused", buildId: "test", capabilities: [],
            extensionCatalog: { extensionOrder: host.host.extensions.extensionIds(), toolCatalog: [], commandCatalog: [] },
        };
        const decoded = JSON.parse(JSON.stringify(bootstrap)) as WorkerBootstrap;
        processWorker = await startSessionWorkerRuntime(
            { ...decoded.options, createAdapter: () => new FauxAdapter([]) },
            new Map(), undefined, undefined,
            {
                catalog: decoded.extensionCatalog,
                tools: [],
                async invokeCommand() { throw new Error("unused"); },
            },
        );
        expect(processWorker.sessionHost.extensions.extensionIds()).toContain("crow.keep");
        expect(processWorker.sessionHost.extensions.extensionIds()).not.toContain("crow.replaced");
        expect(processWorker.sessionHost.extensions.extensionIds()).not.toContain("crow.gone");
        const processLogs = readFileSync(defaultHostLogPath(home), "utf8").trim().split("\n")
            .map((line) => JSON.parse(line) as Parameters<HostLog>[0]);
        for (const warning of expectedWarnings) expect(processLogs).toContainEqual(expect.objectContaining(warning));
        expect(existsSync(replacementMarker)).toBe(false);

        await processWorker.close();
        processWorker = undefined;
        await worker.close();
        worker = undefined;
        await host.close();
        host = await openSessionHost(home);
        expect(host.host.extensions.extensionIds()).toContain("crow.replaced");
        expect(host.host.extensions.commands().map((command) => command.name)).toContain("new-command");
        expect(existsSync(replacementMarker)).toBe(true);
    } finally {
        await processWorker?.close();
        await worker?.close();
        await host?.close();
        await rm(root, { recursive: true, force: true });
    }
});

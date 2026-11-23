import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostExtensionConfigSet, workerExtensionConfigs } from "../../src/extensions/host-set.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import { startExtensionRegistry, type ExtensionRegistryFailure } from "../../src/extensions/registry.ts";
import { extensionConfigEntries } from "../../src/host/extension-config-watch.ts";
import { readPluginSnapshot } from "../../src/plugins/catalog.ts";
import { installPlugin, setPluginEnabled } from "../../src/plugins/manager.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";

function writeExtension(directory: string, id: string, command: string, capabilities = ["commands.register"]): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "extension.ts",
        capabilities,
    }));
    writeFileSync(join(directory, "extension.ts"), `
        import { writeFileSync } from "node:fs";
        import { join } from "node:path";
        export function activate(vera) {
            writeFileSync(join(vera.storage.profile, "activation.json"), JSON.stringify(vera.config));
            vera.commands.register({
                name: ${JSON.stringify(command)},
                description: "Inspect the hold",
                usage: "/${command}",
                run() { return { kind: "notice", level: "info", text: "ready" }; },
            });
        }
    `);
}

function pluginSource(root: string, name: string, id: string, capabilities?: string[]): string {
    const source = join(root, name);
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name,
    }));
    writeExtension(join(source, "dev.vera", "host"), id, name, capabilities);
    return source;
}

test("@core plugin host extensions use the plugin switch, configured values and extension id storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-host-"));
    const home = join(root, "home");
    const veraHome = join(home, ".vera");
    try {
        installPlugin(pluginSource(root, "sea-chest", "crow_bridge"), { home });
        const snapshot = readPluginSnapshot({ veraHome });
        const part = snapshot.host_extensions[0]!;
        const storage = join(veraHome, "extension-data", "crow_bridge", "activation.json");
        const machine = join(veraHome, "machine");
        const plain = hostExtensionConfigSet({ extensions: [] }, snapshot);
        const plainEntry = plain.extensions.find((entry) => entry.path === part.directory)!;
        expect(plainEntry).toMatchObject({ enabled: true, config: {} });
        let registry = await startExtensionRegistry({
            extensions: [plainEntry],
            storageRoots: { profile: veraHome, machine },
        });
        try {
            expect(registry.extensionIds()).toEqual(["crow_bridge"]);
            expect(JSON.parse(readFileSync(storage, "utf8"))).toEqual({});
            expect(existsSync(join(veraHome, "extension-data", "sea-chest"))).toBe(false);
        } finally {
            await registry.close();
        }

        const configured = {
            extensions: [{ path: join(part.directory, "..", "host"), enabled: false, config: { weather: "fog" } }],
        };
        const entry = hostExtensionConfigSet(configured, snapshot).extensions.find((item) => item.path === part.directory)!;
        expect(entry).toMatchObject({ enabled: true, config: { weather: "fog" } });
        expect(hostExtensionConfigSet({
            extensions: [{ path: part.directory, enabled: false, config: null }],
        }, snapshot).extensions.find((item) => item.path === part.directory)?.config).toBeNull();
        expect(workerExtensionConfigs(configured, snapshot).some((item) => item.path === part.directory)).toBe(false);
        registry = await startExtensionRegistry({ extensions: [entry], storageRoots: { profile: veraHome, machine } });
        try {
            expect(registry.extensionIds()).toEqual(["crow_bridge"]);
            expect(JSON.parse(readFileSync(storage, "utf8"))).toEqual({ weather: "fog" });
        } finally {
            await registry.close();
        }

        setPluginEnabled("sea-chest", false, { home });
        const disabled = readPluginSnapshot({ veraHome });
        expect(disabled.host_extension_owners).toEqual([{ plugin: "sea-chest", id: "crow_bridge" }]);
        const off = hostExtensionConfigSet({
            extensions: [{ path: part.directory, enabled: true, config: { weather: "rain" } }],
        }, disabled);
        expect(off.extensions.some((item) => item.path === part.directory)).toBe(false);
        expect(workerExtensionConfigs({
            extensions: [{ path: part.directory, enabled: true, config: {} }],
        }, disabled).some((item) => item.path === part.directory)).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core an included extension wins a duplicate plugin id that reaches the registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-included-"));
    const home = join(root, "home");
    const veraHome = join(home, ".vera");
    try {
        installPlugin(pluginSource(root, "sea-chest", "crow.original"), { home });
        const packagePath = join(veraHome, "plugins", "sea-chest", "dev.vera", "host");
        const manifestPath = join(packagePath, "vera.extension.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id: string };
        manifest.id = "vera.help";
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const registryPath = join(veraHome, "machine", "plugins.json");
        const store = JSON.parse(readFileSync(registryPath, "utf8")) as {
            plugins: { components: { host_extension: string } }[];
        };
        store.plugins[0]!.components.host_extension = "vera.help";
        writeFileSync(registryPath, JSON.stringify(store));
        const snapshot = readPluginSnapshot({ veraHome });
        const pluginPath = snapshot.host_extensions[0]!.directory;
        const set = hostExtensionConfigSet({
            extensions: [{ path: pluginPath, enabled: false, config: {} }],
        }, snapshot);
        const copies = set.extensions.filter((entry) =>
            loadExtensionManifest(entry.path).manifest.id === "vera.help"
        );
        expect(copies).toHaveLength(2);
        expect(extensionConfigEntries({ extensions: [] }, snapshot).get("vera.help")?.path)
            .not.toBe(pluginPath);
        const failures: ExtensionRegistryFailure[] = [];
        const registry = await startExtensionRegistry({
            extensions: copies,
            storageRoots: { profile: veraHome, machine: join(veraHome, "machine") },
            onFailure: (failure) => failures.push(failure),
        });
        try {
            expect(registry.extensionIds()).toEqual(["vera.help"]);
            expect(failures).toMatchObject([
                { path: pluginPath, extensionId: "vera.help", message: "Duplicate extension ID: vera.help" },
            ]);
        } finally {
            await registry.close();
        }
        const includedOff = hostExtensionConfigSet({
            disabled_included_extensions: ["vera.help"],
            extensions: [],
        }, snapshot);
        expect(includedOff.extensions.some((entry) => entry.path === pluginPath)).toBe(false);
        expect(includedOff.failures).toEqual([
            { path: pluginPath, extensionId: "vera.help", message: "Duplicate extension ID: vera.help" },
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a plugin host extension joins the model worker set only for middleware", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-worker-"));
    const home = join(root, "home");
    const veraHome = join(home, ".vera");
    try {
        installPlugin(pluginSource(root, "crow-hook", "crow.hook", ["hooks.model_middleware"]), { home });
        const snapshot = readPluginSnapshot({ veraHome });
        const directory = snapshot.host_extensions[0]!.directory;
        const workers = workerExtensionConfigs({ extensions: [] }, snapshot);
        expect(workers.some((entry) => entry.path === directory)).toBe(true);
        writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
            id: "crow.hook", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: [],
        }));
        expect(workerExtensionConfigs({ extensions: [] }, snapshot).some((entry) => entry.path === directory)).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core plugin host extensions use normal capability and literal-secret checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-review-"));
    const home = join(root, "home");
    const veraHome = join(home, ".vera");
    try {
        installPlugin(pluginSource(root, "sea-chest", "crow.safe"), { home });
        installPlugin(pluginSource(root, "crow-broken", "crow.broken", ["tools.register"]), { home });
        const snapshot = readPluginSnapshot({ veraHome });
        const safe = snapshot.host_extensions.find((part) => part.id === "crow.safe")!;
        const set = hostExtensionConfigSet({
            extensions: [{ path: safe.directory, enabled: true, config: { token: "ghp_abcdefghijklmnop" } }],
        }, snapshot);
        const paths = new Set(snapshot.host_extensions.map((part) => part.directory));
        const failures: ExtensionRegistryFailure[] = [];
        const findings: { extensionId: string; configPath: string; prefix: string }[] = [];
        const registry = await startExtensionRegistry({
            extensions: set.extensions.filter((entry) => paths.has(entry.path)),
            storageRoots: { profile: veraHome, machine: join(veraHome, "machine") },
            onFailure: (failure) => failures.push(failure),
            onLiteralSecret: (finding) => findings.push(finding),
        });
        try {
            expect(registry.extensionIds()).toEqual(["crow.safe"]);
            expect(failures).toMatchObject([
                { extensionId: "crow.broken", message: expect.stringContaining("Extension did not declare commands.register") },
            ]);
            expect(findings).toEqual([
                { extensionId: "crow.safe", configPath: "token", prefix: "ghp_" },
            ]);
        } finally {
            await registry.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a duplicate plugin host id fails only that extension in the registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-duplicate-"));
    const home = join(root, "home");
    const veraHome = join(home, ".vera");
    try {
        installPlugin(pluginSource(root, "sea-chest", "crow.shared"), { home });
        installPlugin(pluginSource(root, "crow-healthy", "crow.healthy"), { home });
        const configured = join(root, "configured");
        writeExtension(configured, "crow.shared", "configured-crow");
        const snapshot = readPluginSnapshot({ veraHome });
        const set = hostExtensionConfigSet({
            extensions: [{ path: configured, enabled: true, config: {} }],
        }, snapshot);
        expect(extensionConfigEntries({
            extensions: [{ path: configured, enabled: true, config: {} }],
        }, snapshot).get("crow.shared")?.path).toBe(configured);
        expect(extensionConfigEntries({
            extensions: [{ path: configured, enabled: false, config: {} }],
        }, snapshot).get("crow.shared")?.path).toBe(
            snapshot.host_extensions.find((part) => part.id === "crow.shared")!.directory,
        );
        const pluginPaths = new Set(snapshot.host_extensions.map((part) => part.directory));
        const failures: ExtensionRegistryFailure[] = [];
        const registry = await startExtensionRegistry({
            extensions: set.extensions.filter((entry) => entry.path === configured || pluginPaths.has(entry.path)),
            storageRoots: { profile: veraHome, machine: join(veraHome, "machine") },
            onFailure: (failure) => failures.push(failure),
        });
        try {
            expect(registry.extensionIds()).toEqual(["crow.shared", "crow.healthy"]);
            expect(failures).toMatchObject([
                { extensionId: "crow.shared", message: "Duplicate extension ID: crow.shared" },
            ]);
            expect(registry.commands().map((command) => command.name)).toEqual(["configured-crow", "crow-healthy"]);
        } finally {
            await registry.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a recorded plugin host id suppresses a legacy extension even when the plugin is off", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-legacy-"));
    const home = join(root, "home");
    const veraHome = join(home, ".vera");
    try {
        installPlugin(pluginSource(root, "sea-chest", "crow.shared"), { home });
        const legacy = join(veraHome, "extensions", "crow.shared");
        writeExtension(legacy, "crow.shared", "legacy-crow");
        const external = join(root, "external");
        writeExtension(external, "crow.external", "external-crow");
        const config = {
            extensions: [
                { path: legacy, enabled: true, config: {} },
                { path: external, enabled: true, config: {} },
            ],
        };
        const snapshot = readPluginSnapshot({ veraHome });
        const plugin = snapshot.host_extensions[0]!.directory;
        const set = hostExtensionConfigSet(config, snapshot);
        expect(set.extensions.some((entry) => entry.path === legacy)).toBe(false);
        expect(set.extensions.some((entry) => entry.path === external)).toBe(true);
        expect(set.warnings).toEqual([
            expect.stringContaining("crow.shared"),
        ]);
        expect(set.warnings[0]).toContain("sea-chest");
        const registry = await startExtensionRegistry({
            extensions: set.extensions.filter((entry) => entry.path === legacy || entry.path === external || entry.path === plugin),
            storageRoots: { profile: veraHome, machine: join(veraHome, "machine") },
        });
        try {
            expect(registry.extensionIds()).toEqual(["crow.external", "crow.shared"]);
            expect(registry.commands().map((command) => command.name)).toEqual(["external-crow", "sea-chest"]);
        } finally {
            await registry.close();
        }

        setPluginEnabled("sea-chest", false, { home });
        const off = hostExtensionConfigSet(config, readPluginSnapshot({ veraHome }));
        expect(off.extensions.some((entry) => entry.path === legacy || entry.path === plugin)).toBe(false);
        expect(off.warnings[0]).toContain("sea-chest");
        expect(off.warnings[0]).toContain("crow.shared");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

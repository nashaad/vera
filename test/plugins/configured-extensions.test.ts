import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentCatalog } from "../../src/agents/catalog.ts";
import { loadOptionalVeraConfig } from "../../src/config.ts";
import { loadCustomizationCatalog } from "../../src/customize/catalog.ts";
import { startClientExtensionRegistry, type ClientExtensionRegistry } from "../../src/extensions/client-registry.ts";
import { withoutPluginExtensionPaths } from "../../src/extensions/plugin-paths.ts";
import { installPlugin, setPluginEnabled } from "../../src/plugins/manager.ts";
import { migratePluginsIn } from "../../src/plugins/migrate.ts";
import { AGENT_MCP_SCHEMA, AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";
import { loadSkillCatalog } from "../../src/skills/catalog.ts";
import { startPrintExtensions } from "../../clients/cli/print-extensions.ts";
import {
    configuredTuiClientExtensions,
    createTuiClientExtensionHostController,
    readTuiClientExtensionConfiguration,
} from "../../clients/tui/client-extension-host.ts";
import { reloadTuiClientExtensions } from "../../clients/tui/client-extension-reload.ts";

interface Fixture {
    readonly root: string;
    readonly home: string;
    readonly path: string;
    readonly marker: string;
}

async function migratedHome(run: (fixture: Fixture) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-configured-"));
    const home = join(root, "vera");
    const legacy = join(home, "extensions", "crow.bundle");
    const marker = join(home, "plugin-activated");
    const previousVeraHome = process.env.VERA_HOME;
    const signals = spyOn(process, "kill").mockImplementation(() => { throw new Error("Unexpected process signal"); });
    process.env.VERA_HOME = home;
    try {
        mkdirSync(join(legacy, "skills", "hello"), { recursive: true });
        writeFileSync(join(legacy, "vera.extension.json"), JSON.stringify({
            id: "crow.bundle", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
            capabilities: ["hooks.model_middleware", "client.commands.register"],
            contributes: { skills: ["skills"] },
        }));
        writeFileSync(join(legacy, "extension.ts"), `
            import { writeFileSync } from "node:fs";
            export function activate(vera) {
                writeFileSync(vera.config.marker, "active");
                vera.hooks.registerModelMiddleware((adapter) => adapter);
            }
            export function activateClient(vera) {
                vera.commands.register({
                    name: "bundle-client", description: vera.config.weather,
                    usage: "/bundle-client",
                    run() { return { kind: "notice", level: "info", text: "ready" }; },
                });
            }
        `);
        writeFileSync(join(legacy, "skills", "hello", "SKILL.md"),
            "---\nname: hello\ndescription: A greeting\n---\n\nHello.\n");
        writeFileSync(join(home, "config.json"), JSON.stringify({
            schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto",
            extensions: [{ path: legacy, enabled: true, config: { marker, weather: "calm" } }],
        }));
        const beforeMigration = readTuiClientExtensionConfiguration();
        const migrated = migratePluginsIn(home);
        expect(migrated.report.failures).toEqual([]);
        expect(migrated.report.config_rewritten).toBe(true);
        const path = join(home, "plugins", "crow.bundle", "host");
        const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
            extensions: { path: string }[];
        };
        expect(config.extensions[0]?.path).toBe(path);
        expect(beforeMigration.clientExtensions.some((entry) => entry.path === legacy)).toBe(true);
        expect(readTuiClientExtensionConfiguration().clientExtensions.some((entry) => entry.path === path)).toBe(true);
        await run({ root, home, path, marker });
        expect(signals).not.toHaveBeenCalled();
    } finally {
        signals.mockRestore();
        if (previousVeraHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousVeraHome;
        rmSync(root, { recursive: true, force: true });
    }
}

test("@core migrated plugin skills and Customize rows follow the plugin switch", async () => {
    await migratedHome(async ({ home, path }) => {
        const agents = await loadAgentCatalog({ permissionModes: ["readonly"], interactive: true });
        const active = await loadSkillCatalog({});
        expect(active.skills.filter((skill) => skill.metadata.name === "hello")).toMatchObject([
            { scope: "plugin", plugin: "crow.bundle" },
        ]);
        expect(active.pluginWarnings.some((warning) => warning.includes("hello") && warning.includes("overrides"))).toBe(false);
        const activeSources = (await loadCustomizationCatalog({ agents })).sources;
        expect(activeSources.filter((source) => source.id === "plugins:crow.bundle"))
            .toMatchObject([{ status: "enabled" }]);
        expect(activeSources.some((source) => source.id === "extensions:user:crow.bundle")).toBe(false);
        expect(activeSources.filter((source) => source.id === "skills:hello")).toHaveLength(1);

        setPluginEnabled("crow.bundle", false);
        const disabled = await loadSkillCatalog({});
        expect(disabled.skills.some((skill) => skill.metadata.name === "hello")).toBe(false);
        const disabledSources = (await loadCustomizationCatalog({ agents })).sources;
        expect(disabledSources.filter((source) => source.id === "plugins:crow.bundle"))
            .toMatchObject([{ status: "disabled" }]);
        expect(disabledSources.some((source) => source.id === "extensions:user:crow.bundle" || source.id === "skills:hello")).toBe(false);
        const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { extensions: { path: string }[] };
        expect(config.extensions[0]?.path).toBe(path);
    });
});

test("@core TUI plugin client extensions use plugin state and config at start and reload", async () => {
    await migratedHome(async ({ root, home, path }) => {
        const configPath = join(home, "config.json");
        const stored = JSON.parse(readFileSync(configPath, "utf8")) as {
            extensions: { path: string; enabled: boolean; config: Record<string, unknown> }[];
        };
        const configuredAlias = join(root, "configured-alias");
        symlinkSync(path, configuredAlias);
        stored.extensions[0]!.path = configuredAlias;
        stored.extensions[0]!.enabled = false;
        const orphan = join(home, "plugins", "orphan", "host");
        mkdirSync(orphan, { recursive: true });
        writeFileSync(join(orphan, "vera.extension.json"), JSON.stringify({
            id: "crow.orphan", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
            capabilities: ["client.commands.register"],
        }));
        writeFileSync(join(orphan, "extension.ts"), "export function activateClient() {}\n");
        stored.extensions.push({ path: orphan, enabled: true, config: {} });
        writeFileSync(configPath, JSON.stringify(stored));
        const config = loadOptionalVeraConfig()!;
        expect(readTuiClientExtensionConfiguration().clientExtensions).toEqual(config.extensions ?? []);
        const starter = join(root, "fresh-plugin");
        const freshHost = join(starter, "custom", "client");
        mkdirSync(freshHost, { recursive: true });
        writeFileSync(join(starter, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA, name: "fresh-plugin",
            extensions: { "dev.vera": { extension: "./custom/client" } },
        }));
        writeFileSync(join(starter, "mcp.json"), JSON.stringify({
            $schema: AGENT_MCP_SCHEMA,
            mcpServers: { local: { type: "stdio", command: "node", env: { DATA: "${PLUGIN_DATA}" } } },
        }));
        writeFileSync(join(freshHost, "vera.extension.json"), JSON.stringify({
            id: "crow.fresh", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
            capabilities: ["client.commands.register"],
        }));
        writeFileSync(join(freshHost, "extension.ts"), "export function activateClient() {}\n");
        installPlugin(starter);
        const freshPath = join(home, "plugins", "fresh-plugin", "custom", "client");
        const build = () => configuredTuiClientExtensions([], config.extensions);
        const initial = build();
        expect(existsSync(join(home, "plugins", ".data", "fresh-plugin"))).toBe(false);
        expect(initial.filter((entry) => entry.path === path)).toEqual([
            { path, enabled: true, config: { marker: join(home, "plugin-activated"), weather: "calm" } },
        ]);
        expect(initial.filter((entry) => entry.path === freshPath)).toEqual([
            { path: freshPath, enabled: true, config: {} },
        ]);
        expect(initial.some((entry) => entry.path === orphan || entry.path === configuredAlias)).toBe(false);
        const adapters = {
            preferences: { async get() { return undefined; }, async set() {}, async delete() {} },
            modelSettings: { current: () => undefined, async update() { throw new Error("unused"); }, subscribe: () => () => {} },
            picker: { async request() { throw new Error("unused"); } },
            notice: { post() {} },
        };
        const start = async (extensions: typeof initial, signal?: AbortSignal): Promise<ClientExtensionRegistry> =>
            await startClientExtensionRegistry({
                extensions: extensions.filter((entry) => entry.path === path || entry.path === freshPath),
                ...adapters,
                ...(signal === undefined ? {} : { signal }),
            });
        const controller = createTuiClientExtensionHostController((signal) => start(initial, signal), () => {});
        try {
            await controller.reload();
            expect(controller.current()?.loadedExtensionIds()).toEqual(["crow.bundle", "crow.fresh"]);
            expect(controller.current()?.commands()).toMatchObject([{ name: "bundle-client", description: "calm" }]);
            setPluginEnabled("crow.bundle", false);
            stored.extensions[0]!.enabled = true;
            writeFileSync(configPath, JSON.stringify(stored));
            expect(readTuiClientExtensionConfiguration().clientExtensions.find((entry) => entry.path === configuredAlias)?.enabled).toBe(true);
            const reload = () => reloadTuiClientExtensions({
                configuration: { disabledIncludedExtensions: [], clientExtensions: initial },
                refreshConfiguration: readTuiClientExtensionConfiguration,
                applyConfiguration() {}, host: controller,
                start: (signal, entries) => start(entries, signal),
            });
            expect(await reload()).toEqual(["crow.fresh"]);
            expect(build().some((entry) => entry.path === path)).toBe(false);
            expect(build().some((entry) => entry.path === freshPath)).toBe(true);
            setPluginEnabled("crow.bundle", true);
            expect(await reload()).toEqual(["crow.bundle", "crow.fresh"]);
        } finally {
            await controller.close();
        }
    });
});

test("@core print mode loads configured plugin middleware only while its plugin is on", async () => {
    await migratedHome(async ({ root, home, path, marker }) => {
        const ordinary = join(root, "ordinary");
        const ordinaryMarker = join(root, "ordinary-activated");
        mkdirSync(ordinary, { recursive: true });
        writeFileSync(join(ordinary, "vera.extension.json"), JSON.stringify({
            id: "crow.ordinary", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
            capabilities: ["hooks.model_middleware"],
        }));
        writeFileSync(join(ordinary, "extension.ts"), `
            import { writeFileSync } from "node:fs";
            export function activate(vera) {
                writeFileSync(${JSON.stringify(ordinaryMarker)}, "active");
                vera.hooks.registerModelMiddleware((adapter) => adapter);
            }
        `);
        const configPath = join(home, "config.json");
        const stored = JSON.parse(readFileSync(configPath, "utf8")) as {
            extensions: { path: string; enabled: boolean; config: Record<string, unknown> }[];
        };
        stored.extensions[0]!.enabled = false;
        stored.extensions.push({ path: ordinary, enabled: true, config: {} });
        writeFileSync(configPath, JSON.stringify(stored));
        const active = await startPrintExtensions();
        try {
            expect(active.config.extensions?.some((entry) => entry.path === path)).toBe(true);
            expect(existsSync(marker)).toBe(true);
            expect(existsSync(ordinaryMarker)).toBe(true);
        } finally {
            await active.close();
        }
        rmSync(marker);
        rmSync(ordinaryMarker);
        setPluginEnabled("crow.bundle", false);
        const disabled = await startPrintExtensions();
        try {
            expect(existsSync(marker)).toBe(false);
            expect(existsSync(ordinaryMarker)).toBe(true);
        } finally {
            await disabled.close();
        }
    });
});

test("@core plugin config paths are filtered by lexical and real containment", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-config-paths-"));
    try {
        const home = join(root, "home");
        const alias = join(root, "home-alias");
        const plugin = join(home, "plugins", "example", "host");
        const external = join(root, "external");
        const externalAlias = join(root, "plugin-alias");
        const escape = join(home, "plugins", "example", "escape");
        const sibling = join(home, "plugins-other", "host");
        mkdirSync(plugin, { recursive: true });
        mkdirSync(external, { recursive: true });
        mkdirSync(sibling, { recursive: true });
        symlinkSync(home, alias);
        symlinkSync(plugin, externalAlias);
        symlinkSync(external, escape);
        const entries = [plugin, join(alias, "plugins", "example", "missing"), externalAlias, escape, external, sibling]
            .map((path) => ({ path }));
        expect(withoutPluginExtensionPaths(entries, alias).map((entry) => entry.path)).toEqual([external, sibling]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

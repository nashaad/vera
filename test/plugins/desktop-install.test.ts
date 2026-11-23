import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extensionStatePath } from "../../clients/desktop/src/extensions/paths.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { ExtensionStore } from "../../clients/desktop/src/extensions/store.ts";
import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import { pluginRegistryPathIn } from "../../src/profile-paths.ts";
import { desktopPluginRoots } from "../../src/plugins/desktop-roots.ts";
import { installPlugin, setPluginEnabled } from "../../src/plugins/manager.ts";
import { loadPluginPackage, readPluginPartFolders } from "../../src/plugins/manifest.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";
import { readPluginRegistry } from "../../src/plugins/registry.ts";

function source(root: string, folder: string, name: string, id: string, version = "1.0.0"): string {
    const directory = join(root, folder);
    const desktop = join(directory, "dev.vera", "desktop");
    mkdirSync(desktop, { recursive: true });
    writeFileSync(join(directory, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name }));
    writeFileSync(join(desktop, "vera.desktop.json"), JSON.stringify({ id, version, engine: DESKTOP_ENGINE }));
    return directory;
}

test("plugdesk install and preview refuse a desktop id owned by another plugin, even when off", () => {
    const root = mkdtempSync(join(tmpdir(), "plugdesk-install-"));
    try {
        const home = join(root, "user");
        const veraHome = join(home, ".vera");
        const owner = source(root, "owner", "crow-owner", "crow.desktop");
        const candidate = source(root, "candidate", "crow-candidate", "crow.desktop");
        installPlugin(owner, { home });
        for (const enabled of [true, false]) {
            if (!enabled) setPluginEnabled("crow-owner", false, { home });
            const registryPath = pluginRegistryPathIn(veraHome);
            const before = readFileSync(registryPath, "utf8");
            for (const dry_run of [true, false]) {
                expect(() => installPlugin(candidate, { home, dry_run })).toThrow(
                    "Desktop extension id crow.desktop is already used by plugin crow-owner.",
                );
                expect(readFileSync(registryPath, "utf8")).toBe(before);
                expect(existsSync(join(veraHome, "plugins", "crow-candidate"))).toBe(false);
            }
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("plugdesk allows a same-name replacement to keep its desktop id", () => {
    const root = mkdtempSync(join(tmpdir(), "plugdesk-replace-"));
    try {
        const home = join(root, "user");
        const first = source(root, "first", "crow-owner", "crow.desktop", "1.0.0");
        const next = source(root, "next", "crow-owner", "crow.desktop", "2.0.0");
        installPlugin(first, { home });
        setPluginEnabled("crow-owner", false, { home });
        const preview = installPlugin(next, { home, dry_run: true });
        expect(preview.preview.replaces?.name).toBe("crow-owner");
        expect(preview.preview.components.desktop_extension?.id).toBe("crow.desktop");
        const replaced = installPlugin(next, { home });
        expect(replaced.record).toMatchObject({ name: "crow-owner", enabled: false, components: { desktop_extension: "crow.desktop" } });
        expect(readPluginRegistry(pluginRegistryPathIn(join(home, ".vera"))).plugins).toHaveLength(1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("plugdesk reinstall restores a desktop part whose live id changed", () => {
    const root = mkdtempSync(join(tmpdir(), "plugdesk-reinstall-"));
    try {
        const home = join(root, "user");
        const veraHome = join(home, ".vera");
        const original = source(root, "source", "crow-owner", "crow.original");
        installPlugin(original, { home });
        const store = new ExtensionStore(veraHome, new ExtensionStateStore(extensionStatePath(veraHome)));
        const manifest = join(veraHome, "plugins", "crow-owner", "dev.vera", "desktop", "vera.desktop.json");
        writeFileSync(manifest, JSON.stringify({ id: "crow.changed-longer", version: "1.0.0", engine: DESKTOP_ENGINE }));
        expect(store.entries()).toEqual([]);
        expect(store.listing().diagnostics.map((item) => item.problem)).toContain(
            'Plugin "crow-owner" records desktop extension id "crow.original", but vera.desktop.json names "crow.changed-longer". Install the plugin again from its source.',
        );
        expect(installPlugin(original, { home }).noop).toBe(false);
        expect(store.entries().map((entry) => entry.id)).toEqual(["crow.original"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("plugdesk install and desktop discovery agree on a declared desktop folder", () => {
    const root = mkdtempSync(join(tmpdir(), "plugdesk-declared-"));
    try {
        const home = join(root, "user");
        const veraHome = join(home, ".vera");
        const directory = join(root, "source");
        const desktop = join(directory, "below", "deck");
        mkdirSync(desktop, { recursive: true });
        writeFileSync(join(directory, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "crow-owner",
            extensions: { "dev.vera": { desktop: "./below/deck" } },
        }));
        writeFileSync(join(desktop, "vera.desktop.json"), JSON.stringify({ id: "crow.desktop", version: "1.0.0", engine: DESKTOP_ENGINE }));
        const folders = readPluginPartFolders(directory);
        expect(folders.desktop).toBe(realpathSync(desktop));
        expect(loadPluginPackage(directory).components.desktop_extension?.directory).toBe(folders.desktop);
        installPlugin(directory, { home });
        const installed = join(veraHome, "plugins", "crow-owner", "below", "deck");
        const roots = desktopPluginRoots(veraHome);
        expect(roots.warnings).toEqual([]);
        expect(roots.roots).toEqual([{ plugin: "crow-owner", directory: realpathSync(installed), id: "crow.desktop" }]);
        const store = new ExtensionStore(veraHome, new ExtensionStateStore(extensionStatePath(veraHome)));
        expect(store.entries().map((entry) => entry.id)).toEqual(["crow.desktop"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("plugdesk reads declared and default part folders without loading their contents", () => {
    const root = mkdtempSync(join(tmpdir(), "plugdesk-folders-"));
    try {
        const agent = join(root, "agent");
        mkdirSync(agent, { recursive: true });
        const manifest = join(agent, "plugin.json");
        writeFileSync(manifest, JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "crow-agent",
            extensions: { "dev.vera": { agents: "./roles", extension: "./engine", desktop: "./window" } },
        }));
        const declared = readPluginPartFolders(agent);
        expect([declared.agents, declared.extension, declared.desktop]).toEqual([
            join(agent, "roles"), join(agent, "engine"), join(agent, "window"),
        ]);
        expect(declared.warnings).toEqual([]);
        writeFileSync(manifest, JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "crow-agent" }));
        const defaults = readPluginPartFolders(agent);
        expect([defaults.agents, defaults.extension, defaults.desktop]).toEqual([
            join(agent, "dev.vera", "agents"), join(agent, "dev.vera", "host"), join(agent, "dev.vera", "desktop"),
        ]);
        const bare = join(root, "bare");
        mkdirSync(bare, { recursive: true });
        writeFileSync(join(bare, "vera.desktop.json"), "{}");
        const bareParts = readPluginPartFolders(bare);
        expect([bareParts.agents, bareParts.extension, bareParts.desktop]).toEqual([null, bare, bare]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("plugdesk reports an escaping desktop declaration in install and discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "plugdesk-escape-"));
    try {
        const home = join(root, "user");
        const veraHome = join(home, ".vera");
        const directory = source(root, "source", "crow-owner", "crow.desktop");
        writeFileSync(join(directory, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "crow-owner",
            extensions: { "dev.vera": { desktop: "./../outside" } },
        }));
        const warning = "dev.vera desktop leaves the plugin: ./../outside";
        expect(readPluginPartFolders(directory).warnings).toContain(warning);
        expect(loadPluginPackage(directory).warnings).toContain(warning);
        installPlugin(directory, { home });
        const roots = desktopPluginRoots(veraHome);
        expect(roots.warnings).toContain(`plugin crow-owner: ${warning}`);
        expect(roots.roots[0]?.id).toBe("crow.desktop");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("plugdesk applies the same plugin metadata checks during desktop discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "plugdesk-metadata-"));
    try {
        const home = join(root, "user");
        const veraHome = join(home, ".vera");
        const directory = source(root, "source", "crow-owner", "crow.desktop");
        installPlugin(directory, { home });
        const manifest = join(veraHome, "plugins", "crow-owner", "plugin.json");
        writeFileSync(manifest, JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "crow-owner", keywords: [17] }));
        const installed = join(veraHome, "plugins", "crow-owner");
        expect(() => readPluginPartFolders(installed)).toThrow("plugin.json keywords must be an array of strings");
        expect(() => loadPluginPackage(installed)).toThrow("plugin.json keywords must be an array of strings");
        const roots = desktopPluginRoots(veraHome);
        expect(roots.roots).toEqual([]);
        expect(roots.warnings).toContain("plugin crow-owner: plugin.json keywords must be an array of strings");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

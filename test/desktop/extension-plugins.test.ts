import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import { extensionsDirectory, extensionStatePath } from "../../clients/desktop/src/extensions/paths.ts";
import { MAX_PACKAGE_ENTRIES, MAX_PACKAGE_FILE_BYTES } from "../../clients/desktop/src/extensions/limits.ts";
import { ExtensionService } from "../../clients/desktop/src/extensions/service.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { ExtensionStore } from "../../clients/desktop/src/extensions/store.ts";
import { ThemeService } from "../../clients/desktop/src/theme-service.ts";
import { themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";
import { PLUGIN_REGISTRY_MAX_BYTES, readPluginRegistry, writePluginRegistry, type PluginRecord } from "../../src/plugins/registry.ts";
import { pluginRegistryPathIn } from "../../src/profile-paths.ts";
import { savedTheme } from "./extension-fixtures.ts";
import { removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

interface Trial {
    readonly home: string;
    readonly veraHome: string;
    readonly store: ExtensionStore;
    readonly service: ExtensionService;
}

function trial(included?: string): Trial {
    const home = scratchDirectory();
    const veraHome = join(home, ".vera");
    const store = new ExtensionStore(veraHome, new ExtensionStateStore(extensionStatePath(veraHome)), included);
    const themes = new ThemeService(store, themesDirectory(veraHome));
    const service = new ExtensionService(store, themes, async () => { throw new Error("No task"); });
    return { home, veraHome, store, service };
}

function extension(directory: string, id: string, version = "1.0.0"): void {
    const theme = savedTheme(`Crow ${version}`);
    writeText(join(directory, "vera.desktop.json"), JSON.stringify({
        id, version, engine: DESKTOP_ENGINE, main: "main.js",
        contributes: {
            themes: [{ label: `Crow ${version}`, path: "theme.json" }],
            tasks: [{ id: "scan", title: "Scan", main: "scan.cjs" }],
            commands: [
                { command: `${id}.fly`, title: "Fly" },
                { command: `${id}.scan`, title: "Scan", task: "scan" },
                { command: `${id}.page`, title: "Page", page: "page.js" },
            ],
            keybindings: [{ command: `${id}.fly`, key: "ctrl+alt+f" }],
        },
    }));
    writeText(join(directory, "main.js"), `export const version = "${version}";`);
    writeText(join(directory, "scan.cjs"), "module.exports = {};");
    writeText(join(directory, "page.js"), "document.body;");
    writeText(join(directory, "theme.json"), theme.text);
}

function install(trialHome: Trial, name: string, id: string, layout: "declared" | "default" | "bare" | "foreign", version = "1.0.0"): void {
    const source = join(trialHome.veraHome, "plugins", name);
    let desktop = source;
    if (layout === "declared" || layout === "default") {
        writeText(join(source, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name,
            ...(layout === "declared" ? { extensions: { "dev.vera": { desktop: "./custom/desktop" } } } : {}),
        }));
        desktop = join(source, layout === "declared" ? "custom/desktop" : "dev.vera/desktop");
    } else if (layout === "foreign") {
        writeText(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    }
    extension(desktop, id, version);
    const registry = pluginRegistryPathIn(trialHome.veraHome);
    mkdirSync(join(trialHome.veraHome, "machine"), { recursive: true });
    const record: PluginRecord = {
        name,
        source: { kind: "local", path: source },
        digest: `sha256:${"0".repeat(64)}`,
        entries: 0,
        total_bytes: 0,
        newest_mtime_ms: 0,
        directory: `plugins/${name}`,
        enabled: true,
        installed_at: "2026-11-22T00:00:00.000Z",
        components: { skills: [], agents: [], mcp_servers: [], skill_roots: [], agent_roots: [], host_extension: null, desktop_extension: id },
        ignored: [],
    };
    const current = readPluginRegistry(registry);
    writePluginRegistry(registry, { ...current, plugins: [...current.plugins, record] });
}

function setPluginEnabled(trialHome: Trial, name: string, enabled: boolean): void {
    const registry = pluginRegistryPathIn(trialHome.veraHome);
    const current = readPluginRegistry(registry);
    writePluginRegistry(registry, {
        ...current,
        plugins: current.plugins.map((record) => record.name === name ? { ...record, enabled } : record),
    });
}

test("plugdesk discovers declared, default, bare and foreign desktop plugin layouts", async () => {
    const t = trial();
    install(t, "crow-declared", "crow.declared", "declared");
    install(t, "crow-default", "crow.default", "default");
    install(t, "crow.bare", "crow.bare", "bare");
    install(t, "crow-foreign", "crow.foreign", "foreign");
    expect(t.store.entries().map((entry) => entry.id)).toEqual(["crow.bare", "crow.declared", "crow.default", "crow.foreign"]);
    expect(t.store.themes().map((theme) => theme.slug)).toContain("crow.declared.crow-1-0-0");
    const entry = t.store.entries().find((item) => item.id === "crow.declared");
    expect(entry?.worker).toMatchObject({
        commands: [{ command: "crow.declared.fly" }],
        keybindings: [{ command: "crow.declared.fly", key: "ctrl+alt+f" }],
    });
    expect(entry?.hasUnavailableContributions).toBe(true);
    expect(t.store.commandTarget("crow.declared.scan")).toBeUndefined();
    expect(t.store.pageScript("crow.declared.page")).toBeUndefined();
    expect(await t.service.readMain("crow.declared")).toEqual({ ok: true, source: 'export const version = "1.0.0";' });
});

test("plugdesk discovers extensions only from the store's home", () => {
    const first = trial();
    const second = trial();
    install(first, "crow-first", "crow.first", "declared");
    install(second, "crow-second", "crow.second", "declared");
    expect(first.store.entries().map((entry) => entry.id)).toEqual(["crow.first"]);
    expect(second.store.entries().map((entry) => entry.id)).toEqual(["crow.second"]);
    setPluginEnabled(first, "crow-first", false);
    expect(first.store.entries()).toEqual([]);
    expect(second.store.entries().map((entry) => entry.id)).toEqual(["crow.second"]);
});

test("plugdesk follows plugin state and refuses individual changes", async () => {
    const t = trial();
    install(t, "crow-owner", "crow.worker", "declared");
    const desktopState = extensionStatePath(t.veraHome);
    writeText(desktopState, JSON.stringify({ version: 1, disabled: ["crow.worker"] }));
    const initial = readFileSync(desktopState, "utf8");
    expect(t.store.entries()[0]?.enabled).toBe(true);
    expect(t.service.setEnabled("crow.worker", false)).toEqual({ ok: false, reason: '"crow.worker" belongs to plugin "crow-owner". Use /plugin disable crow-owner.' });
    expect(t.service.remove("crow.worker")).toEqual({ ok: false, reason: '"crow.worker" belongs to plugin "crow-owner". Use vera plugin remove crow-owner.' });
    expect(readFileSync(desktopState, "utf8")).toBe(initial);
    expect(existsSync(join(t.veraHome, "plugins", "crow-owner"))).toBe(true);
    setPluginEnabled(t, "crow-owner", false);
    expect(t.store.entries()).toEqual([]);
    expect(t.store.themes()).toEqual([]);
    expect((await t.service.readMain("crow.worker")).ok).toBe(false);
    expect(t.service.setEnabled("crow.worker", true)).toEqual({ ok: false, reason: '"crow.worker" belongs to plugin "crow-owner". Use /plugin enable crow-owner.' });
    setPluginEnabled(t, "crow-owner", true);
    expect(t.store.entries()[0]?.enabled).toBe(true);
    expect(readFileSync(desktopState, "utf8")).toBe(initial);
});

test("plugdesk reports an included id collision and keeps the included extension", async () => {
    const included = scratchDirectory();
    extension(join(included, "crow.same"), "crow.same", "1.0.0");
    const t = trial(included);
    install(t, "crow-owner", "crow.same", "default", "2.0.0");
    expect(t.store.entries().map((entry) => [entry.id, entry.version, entry.included])).toEqual([["crow.same", "1.0.0", true]]);
    expect(t.store.listing().diagnostics.map((item) => item.problem)).toContain('Desktop extension "crow.same" from plugin "crow-owner" is skipped because an included extension has the same id.');
    expect(t.service.remove("crow.same")).toEqual({ ok: false, reason: '"crow.same" is included with Vera and cannot be removed.' });
    expect((await t.service.readMain("crow.same")).ok).toBe(false);
});

test("plugdesk reports and skips a legacy id collision even while the plugin is off", async () => {
    const t = trial();
    extension(join(extensionsDirectory(t.veraHome), "crow.same"), "crow.same", "1.0.0");
    install(t, "crow-owner", "crow.same", "default", "2.0.0");
    expect(t.store.entries().map((entry) => [entry.id, entry.version])).toEqual([["crow.same", "2.0.0"]]);
    expect(t.store.listing().diagnostics.map((item) => item.problem)).toContain('Desktop extension "crow.same" is skipped because plugin "crow-owner" has the same id.');
    expect(await t.service.readMain("crow.same")).toEqual({ ok: true, source: 'export const version = "2.0.0";' });
    setPluginEnabled(t, "crow-owner", false);
    expect(t.store.entries()).toEqual([]);
    expect(t.store.listing().diagnostics.map((item) => item.problem)).toContain('Desktop extension "crow.same" is skipped because plugin "crow-owner" has the same id.');
    expect(existsSync(join(extensionsDirectory(t.veraHome), "crow.same"))).toBe(true);
});

test("plugdesk skips a changed desktop id and reports how to repair it", async () => {
    const t = trial();
    install(t, "crow-owner", "crow.original", "declared");
    const desktop = join(t.veraHome, "plugins", "crow-owner", "custom", "desktop");
    extension(desktop, "crow.changed");
    expect(t.store.entries()).toEqual([]);
    expect(t.store.themes()).toEqual([]);
    expect((await t.service.readMain("crow.changed")).ok).toBe(false);
    expect(t.store.listing().diagnostics.map((item) => item.problem)).toContain(
        'Plugin "crow-owner" records desktop extension id "crow.original", but vera.desktop.json names "crow.changed". Install the plugin again from its source.',
    );
    extension(desktop, "crow.original");
    expect(t.store.entries().map((entry) => entry.id)).toEqual(["crow.original"]);
});

test("plugdesk does not load a desktop id absent from the plugin record", () => {
    const t = trial();
    install(t, "crow-owner", "crow.original", "default");
    const registry = pluginRegistryPathIn(t.veraHome);
    const current = readPluginRegistry(registry);
    writePluginRegistry(registry, {
        ...current,
        plugins: current.plugins.map((record) => ({
            ...record,
            components: { ...record.components, desktop_extension: null },
        })),
    });
    expect(t.store.entries()).toEqual([]);
    expect(t.store.listing().diagnostics.map((item) => item.problem)).toContain(
        'Plugin "crow-owner" records desktop extension id none, but vera.desktop.json names "crow.original". Install the plugin again from its source.',
    );
});

test("plugdesk does not let a changed plugin id shadow a legacy extension", async () => {
    const t = trial();
    install(t, "crow-owner", "crow.original", "declared");
    extension(join(extensionsDirectory(t.veraHome), "crow.changed"), "crow.changed", "1.0.0");
    extension(join(t.veraHome, "plugins", "crow-owner", "custom", "desktop"), "crow.changed", "2.0.0");
    expect(t.store.entries().map((entry) => [entry.id, entry.version])).toEqual([["crow.changed", "1.0.0"]]);
    expect(await t.service.readMain("crow.changed")).toEqual({ ok: true, source: 'export const version = "1.0.0";' });
    expect(t.store.listing().diagnostics.map((item) => item.problem)).toContain(
        'Plugin "crow-owner" records desktop extension id "crow.original", but vera.desktop.json names "crow.changed". Install the plugin again from its source.',
    );
});

test("plugdesk keeps the first recorded plugin id when duplicates already exist", () => {
    const t = trial();
    install(t, "crow-zulu", "crow.same", "default", "2.0.0");
    install(t, "crow-alpha", "crow.same", "default", "1.0.0");
    expect(t.store.entries().map((entry) => [entry.id, entry.version])).toEqual([["crow.same", "1.0.0"]]);
    const diagnostic = 'Desktop extension "crow.same" from plugin "crow-zulu" is skipped because plugin "crow-alpha" has the same id.';
    expect(t.store.listing().diagnostics.map((item) => item.problem)).toContain(diagnostic);
    setPluginEnabled(t, "crow-alpha", false);
    expect(t.store.entries()).toEqual([]);
    expect(t.store.listing().diagnostics.map((item) => item.problem)).toContain(diagnostic);
});

for (const condition of ["missing", "corrupt", "oversized"] as const) {
    test(`plugdesk keeps legacy discovery working with ${condition === "oversized" ? "an" : "a"} ${condition} registry`, () => {
        const t = trial();
        extension(join(extensionsDirectory(t.veraHome), "crow.legacy"), "crow.legacy");
        const registry = join(t.veraHome, "machine", "plugins.json");
        if (condition === "corrupt") writeText(registry, "{");
        if (condition === "oversized") writeText(registry, " ".repeat(PLUGIN_REGISTRY_MAX_BYTES + 1));
        expect(t.store.entries().map((entry) => entry.id)).toEqual(["crow.legacy"]);
        expect(t.store.listing().diagnostics.some((item) => item.problem.startsWith("Plugins:"))).toBe(condition !== "missing");
    });
}

test("plugdesk refuses a desktop directory redirected outside its plugin", () => {
    const t = trial();
    install(t, "crow-owner", "crow.worker", "declared");
    const directory = join(t.veraHome, "plugins", "crow-owner", "custom", "desktop");
    const outside = join(t.home, "outside");
    extension(outside, "crow.worker");
    rmSync(directory, { recursive: true });
    symlinkSync(outside, directory, "dir");
    expect(t.store.entries()).toEqual([]);
});

test("plugdesk enforces desktop package limits without reading file contents", () => {
    const t = trial();
    install(t, "crow-owner", "crow.worker", "declared");
    const directory = join(t.veraHome, "plugins", "crow-owner", "custom", "desktop");
    for (let index = 0; index < MAX_PACKAGE_ENTRIES; index += 1) writeText(join(directory, `extra-${index}`), "");
    expect(t.store.entries()).toEqual([]);
    expect(t.store.listing().diagnostics[0]?.problem).toContain(`more than ${MAX_PACKAGE_ENTRIES} entries`);
    for (let index = 0; index < MAX_PACKAGE_ENTRIES; index += 1) rmSync(join(directory, `extra-${index}`));
    writeFileSync(join(directory, "oversized"), Buffer.alloc(MAX_PACKAGE_FILE_BYTES + 1));
    expect(t.store.entries()).toEqual([]);
    expect(t.store.listing().diagnostics[0]?.problem).toContain("larger than 4 MiB");
    rmSync(join(directory, "oversized"));
    expect(t.store.entries().map((entry) => entry.id)).toEqual(["crow.worker"]);
});

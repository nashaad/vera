import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { installPlugin, removePlugin } from "../../src/plugins/manager.ts";
import { legacyStores, renameLegacyStores } from "../../src/plugins/migrate-legacy.ts";
import { migratePlugins, migratePluginsIn } from "../../src/plugins/migrate.ts";
import { hasLegacyExtensionStores } from "../../src/plugins/migrate-startup.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";
import { readPluginRegistry } from "../../src/plugins/registry.ts";

function homeFixture(): { root: string; home: string; vera: string } {
    const root = mkdtempSync(join(process.cwd(), ".agent-notes/plugpkg-task/migration-test-"));
    const home = join(root, "home");
    const vera = join(home, ".vera");
    mkdirSync(vera, { recursive: true });
    return { root, home, vera };
}

function hostExtension(vera: string, id: string): string {
    const path = join(vera, "extensions", id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "vera.extension.json"), JSON.stringify({
        id, version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: [],
    }));
    writeFileSync(join(path, "extension.ts"), "export default {};\n");
    return path;
}

function desktopExtension(vera: string, id: string): string {
    const path = join(vera, "machine", "desktop", "extensions", id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "vera.desktop.json"), JSON.stringify({ id, version: "1.0.0", engine: "vera-gui@^1" }));
    return path;
}

function disableDesktop(vera: string, ids: string[]): void {
    writeFileSync(join(vera, "machine", "desktop", "extensions.json"), JSON.stringify({ version: 1, disabled: ids }));
}

function managed(vera: string, ids: { id: string; enabled: boolean }[]): void {
    writeFileSync(join(vera, "extensions.json"), JSON.stringify({
        schema_version: 1,
        extensions: ids.map(({ id, enabled }) => ({
            id, enabled, version: "1.0.0", source: { kind: "local", path: `/source/${id}` },
            digest: `sha256:${"0".repeat(64)}`, directory: `extensions/${id}`,
            installedAt: "2026-01-01T00:00:00.000Z",
        })),
    }));
}

function registry(vera: string) {
    return readPluginRegistry(join(vera, "machine", "plugins.json")).plugins;
}

test("migration merges matching parts, splits states, rewrites config, and keeps rollback copies", () => {
    const f = homeFixture();
    try {
        const shared = hostExtension(f.vera, "crow.shared");
        hostExtension(f.vera, "crow.split");
        desktopExtension(f.vera, "crow.shared");
        desktopExtension(f.vera, "crow.split");
        managed(f.vera, [{ id: "crow.shared", enabled: false }, { id: "crow.split", enabled: true }]);
        disableDesktop(f.vera, ["crow.shared", "crow.split"]);
        writeFileSync(join(f.vera, "config.json"), JSON.stringify({
            extensions: [{ path: shared, enabled: false, config: { color: "blue" } },
                { path: join(f.root, "external"), config: { keep: true } }],
            other: 1,
        }));
        const report = migratePlugins({ home: f.home });
        expect(report.failures).toEqual([]);
        expect(report.migrated).toHaveLength(3);
        expect(report.config_rewritten).toBe(true);
        expect(registry(f.vera).map((p) => [p.name, p.enabled, p.components.host_extension, p.components.desktop_extension]))
            .toEqual([
                ["crow.shared", false, "crow.shared", "crow.shared"],
                ["crow.split", true, "crow.split", null],
                ["crow.split-desktop", false, null, "crow.split"],
            ]);
        const config = JSON.parse(readFileSync(join(f.vera, "config.json"), "utf8"));
        expect(config.extensions[0]).toEqual({
            path: join(f.vera, "plugins", "crow.shared", "host"), enabled: false, config: { color: "blue" },
        });
        expect(config.extensions[1]).toEqual({ path: join(f.root, "external"), config: { keep: true } });
        expect(config.other).toBe(1);
        for (const path of ["extensions.pre-plugins", "extensions.pre-plugins.json",
            "machine/desktop/extensions.pre-plugins", "machine/desktop/extensions.pre-plugins.json"]) {
            expect(existsSync(join(f.vera, path))).toBe(true);
        }
        expect(migratePlugins({ home: f.home })).toEqual({
            migrated: [], skipped: [], failures: [], rollback: [], config_rewritten: false,
        });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("migration keeps the old store for name collisions and caps, then retries recorded parts", () => {
    const f = homeFixture();
    try {
        const source = join(f.root, "existing");
        mkdirSync(source);
        writeFileSync(join(source, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "crow-busy" }));
        installPlugin(source, { home: f.home });
        const busy = hostExtension(f.vera, "crow_busy");
        const ok = hostExtension(f.vera, "crow.ok");
        writeFileSync(join(f.vera, "config.json"), JSON.stringify({ extensions: [
            { path: busy, config: { value: "held back" } },
            { path: ok, config: { value: "moved" } },
        ] }));
        const huge = hostExtension(f.vera, "crow.large");
        writeFileSync(join(huge, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        const first = migratePlugins({ home: f.home });
        expect(first.failures.join("\n")).toContain("already installed");
        expect(first.failures.join("\n")).toContain("larger than");
        expect(first.migrated.join("\n")).toContain("crow.ok");
        const config = JSON.parse(readFileSync(join(f.vera, "config.json"), "utf8"));
        expect(config.extensions[0]).toEqual({ path: busy, config: { value: "held back" } });
        expect(config.extensions[1]).toEqual({ path: join(f.vera, "plugins", "crow.ok", "host"), config: { value: "moved" } });
        expect(existsSync(join(f.vera, "extensions"))).toBe(true);
        expect(existsSync(join(f.vera, "extensions.pre-plugins"))).toBe(false);
        removePlugin("crow-busy", { home: f.home });
        writeFileSync(join(huge, "large.bin"), "small");
        const second = migratePlugins({ home: f.home });
        expect(second.failures).toEqual([]);
        expect(second.skipped.join("\n")).toContain("crow.ok");
        expect(second.migrated).toHaveLength(2);
        expect(existsSync(join(f.vera, "extensions.pre-plugins"))).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("migration leaves legacy stores intact when the config rewrite fails", () => {
    const f = homeFixture();
    try {
        const host = hostExtension(f.vera, "crow.config");
        const configPath = join(f.vera, "config.json");
        writeFileSync(configPath, JSON.stringify({ extensions: [{ path: host, config: { keep: true } }] }));
        mkdirSync(join(f.vera, "machine"), { recursive: true });
        mkdirSync(join(f.vera, "plugins"), { recursive: true });
        chmodSync(f.vera, 0o555);
        let report;
        try { report = migratePlugins({ home: f.home }); } finally { chmodSync(f.vera, 0o755); }
        expect(report.failures.length).toBeGreaterThan(0);
        expect(existsSync(join(f.vera, "extensions"))).toBe(true);
        expect(existsSync(join(f.vera, "extensions.pre-plugins"))).toBe(false);
        expect(JSON.parse(readFileSync(configPath, "utf8")).extensions[0].path).toBe(host);
        expect(registry(f.vera)).toEqual([]);
        expect(existsSync(join(f.vera, "plugins", "crow.config"))).toBe(false);
        const retry = migratePlugins({ home: f.home });
        expect(retry.failures).toEqual([]);
        expect(retry.migrated.join("\n")).toContain("crow.config");
        expect(retry.config_rewritten).toBe(true);
    } finally { chmodSync(f.vera, 0o755); rmSync(f.root, { recursive: true, force: true }); }
});

test("partial migration loads the plugin ahead of its matching legacy extension", async () => {
    const f = homeFixture();
    try {
        const legacy = hostExtension(f.vera, "crow.active");
        const held = hostExtension(f.vera, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        const report = migratePlugins({ home: f.home });
        expect(report.migrated.join("\n")).toContain("crow.active");
        expect(report.failures.length).toBeGreaterThan(0);
        const { readPluginSnapshot } = await import("../../src/plugins/catalog.ts");
        const { hostExtensionConfigSet } = await import("../../src/extensions/host-set.ts");
        const snapshot = readPluginSnapshot({ veraHome: f.vera });
        const set = hostExtensionConfigSet({ extensions: [{ path: legacy, enabled: true, config: {} }] }, snapshot);
        const paths = set.extensions.map((entry) => entry.path);
        expect(paths).not.toContain(legacy);
        expect(paths).toContain(join(f.vera, "plugins", "crow.active", "host"));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("removing a migrated plugin removes its live host and desktop legacy copies", async () => {
    const f = homeFixture();
    try {
        const host = hostExtension(f.vera, "crow.shared");
        const desktop = desktopExtension(f.vera, "crow.shared");
        const held = hostExtension(f.vera, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        managed(f.vera, [{ id: "crow.shared", enabled: false }]);
        disableDesktop(f.vera, ["crow.shared", "crow.other"]);
        const data = join(f.vera, "extension-data", "crow.shared");
        mkdirSync(data, { recursive: true });
        writeFileSync(join(data, "state.txt"), "kept");
        expect(migratePlugins({ home: f.home }).failures.length).toBeGreaterThan(0);
        const { runCli } = await import("../../clients/cli/main.ts");
        const { removePlugin } = await import("../../src/plugins/manager.ts");
        const stdout = { text: "", write(text: string) { this.text += text; } };
        const stderr = { text: "", write(text: string) { this.text += text; } };
        expect(await runCli(["plugin", "remove", "crow.shared"], {
            stdout, stderr, pluginManager: { remove: (name, options) => removePlugin(name, { ...options, home: f.home }) },
        })).toBe(0);
        expect(stdout.text).toContain(host);
        expect(stdout.text).toContain(desktop);
        expect(existsSync(host)).toBe(false);
        expect(existsSync(desktop)).toBe(false);
        expect(existsSync(join(f.vera, "extensions", ".managed", "crow.shared.json"))).toBe(false);
        expect(JSON.parse(readFileSync(join(f.vera, "extensions.json"), "utf8")).extensions).toEqual([]);
        expect(JSON.parse(readFileSync(join(f.vera, "machine", "desktop", "extensions.json"), "utf8")).disabled)
            .toEqual(["crow.other"]);
        expect(migratePlugins({ home: f.home }).migrated.join("\n")).not.toContain("crow.shared");
        expect(readFileSync(join(data, "state.txt"), "utf8")).toBe("kept");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("extension removal removes only the migrated part when host and desktop are split", async () => {
    const f = homeFixture();
    try {
        const host = hostExtension(f.vera, "crow.split");
        const desktop = desktopExtension(f.vera, "crow.split");
        const held = hostExtension(f.vera, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        disableDesktop(f.vera, ["crow.split"]);
        expect(migratePlugins({ home: f.home }).failures.length).toBeGreaterThan(0);
        const { runCli } = await import("../../clients/cli/main.ts");
        const { removeExtension } = await import("../../src/extensions/manager.ts");
        const stdout = { text: "", write(text: string) { this.text += text; } };
        const stderr = { text: "", write(text: string) { this.text += text; } };
        expect(await runCli(["extension", "remove", "crow.split"], {
            stdout, stderr, extensionManager: { remove: (id) => removeExtension(id, { home: f.home }) },
        })).toBe(1);
        expect(stderr.text).toContain("vera plugin remove");
        const { removePlugin } = await import("../../src/plugins/manager.ts");
        const removal = removePlugin("crow.split", { home: f.home });
        expect(removal.legacy_removed).toEqual([host]);
        expect(existsSync(host)).toBe(false);
        expect(existsSync(desktop)).toBe(true);
        expect(JSON.parse(readFileSync(join(f.vera, "machine", "desktop", "extensions.json"), "utf8")).disabled)
            .toEqual(["crow.split"]);
        expect(registry(f.vera).some((record) => record.name === "crow.split-desktop")).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("failed plugin removal restores its legacy files and state", async () => {
    const f = homeFixture();
    try {
        const host = hostExtension(f.vera, "crow.shared");
        const desktop = desktopExtension(f.vera, "crow.shared");
        const held = hostExtension(f.vera, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        managed(f.vera, [{ id: "crow.shared", enabled: false }]);
        disableDesktop(f.vera, ["crow.shared"]);
        expect(migratePlugins({ home: f.home }).failures.length).toBeGreaterThan(0);
        const { removePlugin } = await import("../../src/plugins/manager.ts");
        const plugins = join(f.vera, "plugins");
        chmodSync(plugins, 0o555);
        try {
            expect(() => removePlugin("crow.shared", { home: f.home })).toThrow();
        } finally { chmodSync(plugins, 0o755); }
        expect(existsSync(host)).toBe(true);
        expect(existsSync(desktop)).toBe(true);
        expect(JSON.parse(readFileSync(join(f.vera, "extensions.json"), "utf8")).extensions[0].id).toBe("crow.shared");
        expect(JSON.parse(readFileSync(join(f.vera, "machine", "desktop", "extensions.json"), "utf8")).disabled)
            .toEqual(["crow.shared"]);
        expect(registry(f.vera).some((record) => record.name === "crow.shared")).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("plugin migrate dispatches from the CLI and TUI and reports its work", async () => {
    const f = homeFixture();
    const previous = process.env.VERA_HOME;
    try {
        hostExtension(f.vera, "crow.cli");
        process.env.VERA_HOME = f.vera;
        const { runCli } = await import("../../clients/cli/main.ts");
        const { runPluginCommand } = await import("../../clients/tui/main/plugin-ops.ts");
        const { parsePluginManagerCommand } = await import("../../src/plugins/command.ts");
        const stdout = { text: "", write(text: string) { this.text += text; } };
        const stderr = { text: "", write(text: string) { this.text += text; } };
        expect(parsePluginManagerCommand(["plugin", "migrate", "extra"])).toEqual({ error: "Usage: vera plugin migrate" });
        expect(await runCli(["plugin", "migrate"], { stdout, stderr })).toBe(0);
        expect(stdout.text).toContain("Migrated host crow.cli");
        expect(runPluginCommand({ operation: "migrate" }).text).toContain("No legacy extensions to migrate");
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("extension remove reports and removes its migrated legacy folder", async () => {
    const f = homeFixture();
    try {
        const host = hostExtension(f.vera, "crow.remove");
        const held = hostExtension(f.vera, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        managed(f.vera, [{ id: "crow.remove", enabled: true }]);
        expect(migratePlugins({ home: f.home }).failures.length).toBeGreaterThan(0);
        const { runCli } = await import("../../clients/cli/main.ts");
        const { removeExtension } = await import("../../src/extensions/manager.ts");
        const stdout = { text: "", write(text: string) { this.text += text; } };
        const stderr = { text: "", write(text: string) { this.text += text; } };
        expect(await runCli(["extension", "remove", "crow.remove"], {
            stdout, stderr, extensionManager: { remove: (id) => removeExtension(id, { home: f.home }) },
        })).toBe(0);
        expect(stdout.text).toContain(host);
        expect(existsSync(host)).toBe(false);
        expect(JSON.parse(readFileSync(join(f.vera, "extensions.json"), "utf8")).extensions).toEqual([]);
        expect(migratePlugins({ home: f.home }).migrated.join("\n")).not.toContain("crow.remove");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("migration adopts an identical orphan and preserves it when config writing fails", async () => {
    const f = homeFixture();
    try {
        const host = hostExtension(f.vera, "crow.retry");
        const held = hostExtension(f.vera, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        expect(migratePlugins({ home: f.home }).migrated.join("\n")).toContain("crow.retry");
        const orphan = join(f.vera, "plugins", "crow.retry");
        writeFileSync(join(f.vera, "machine", "plugins.json"), JSON.stringify({ schema_version: 1, plugins: [] }));
        writeFileSync(join(f.vera, "config.json"), JSON.stringify({ extensions: [{ path: host, config: { keep: true } }] }));
        chmodSync(f.vera, 0o555);
        let failed;
        try { failed = migratePlugins({ home: f.home }); } finally { chmodSync(f.vera, 0o755); }
        expect(failed.failures.join("\n")).toContain("Config rewrite failed");
        expect(registry(f.vera)).toEqual([]);
        expect(existsSync(orphan)).toBe(true);
        const retry = migratePlugins({ home: f.home });
        expect(retry.migrated.join("\n")).toContain("crow.retry");
        const { listPlugins } = await import("../../src/plugins/manager.ts");
        expect(listPlugins({ home: f.home }).plugins[0]?.modified).toBe(false);
        expect(JSON.parse(readFileSync(join(f.vera, "config.json"), "utf8")).extensions[0].path)
            .toBe(join(orphan, "host"));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("removing a split desktop plugin leaves its host legacy copy alone", async () => {
    const f = homeFixture();
    try {
        const host = hostExtension(f.vera, "crow.split");
        const desktop = desktopExtension(f.vera, "crow.split");
        const held = hostExtension(f.vera, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        disableDesktop(f.vera, ["crow.split", "crow.other"]);
        expect(migratePlugins({ home: f.home }).failures.length).toBeGreaterThan(0);
        const { removePlugin } = await import("../../src/plugins/manager.ts");
        const removed = removePlugin("crow.split-desktop", { home: f.home });
        expect(removed.legacy_removed).toEqual([desktop]);
        expect(existsSync(desktop)).toBe(false);
        expect(existsSync(host)).toBe(true);
        expect(JSON.parse(readFileSync(join(f.vera, "machine", "desktop", "extensions.json"), "utf8")).disabled)
            .toEqual(["crow.other"]);
        expect(registry(f.vera).some((record) => record.name === "crow.split")).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("removing a migrated plugin preserves completed rollback copies", async () => {
    const f = homeFixture();
    try {
        hostExtension(f.vera, "crow.rollback");
        expect(migratePlugins({ home: f.home }).failures).toEqual([]);
        const backup = join(f.vera, "extensions.pre-plugins", "crow.rollback", "vera.extension.json");
        expect(existsSync(backup)).toBe(true);
        const { removePlugin } = await import("../../src/plugins/manager.ts");
        const removed = removePlugin("crow.rollback", { home: f.home });
        expect(removed.legacy_removed).toBeUndefined();
        expect(existsSync(backup)).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a disabled migrated plugin keeps its live legacy extension disabled", async () => {
    const f = homeFixture();
    try {
        const legacy = hostExtension(f.vera, "crow.off");
        const held = hostExtension(f.vera, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        expect(migratePlugins({ home: f.home }).failures.length).toBeGreaterThan(0);
        const { setPluginEnabled } = await import("../../src/plugins/manager.ts");
        const { readPluginSnapshot } = await import("../../src/plugins/catalog.ts");
        const { hostExtensionConfigSet } = await import("../../src/extensions/host-set.ts");
        setPluginEnabled("crow.off", false, { home: f.home });
        const snapshot = readPluginSnapshot({ veraHome: f.vera });
        const set = hostExtensionConfigSet({ extensions: [{ path: legacy, enabled: true, config: {} }] }, snapshot);
        expect(set.extensions.map((entry) => entry.path)).not.toContain(legacy);
        expect(set.extensions.map((entry) => entry.path)).not.toContain(join(f.vera, "plugins", "crow.off", "host"));
        expect(set.warnings.join("\n")).toContain("plugin crow.off holds the same host extension id");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("migration preserves a one-character extension id", () => {
    const f = homeFixture();
    try {
        hostExtension(f.vera, "x");
        const report = migratePlugins({ home: f.home });
        expect(report.failures).toEqual([]);
        expect(registry(f.vera)[0]).toMatchObject({ name: "x", components: { host_extension: "x" } });
        expect(existsSync(join(f.vera, "plugins", "x", "host", "vera.extension.json"))).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("desktop migration and removal work beneath a symlinked home ancestor", () => {
    const f = homeFixture();
    try {
        const home = join(f.root, "home-link");
        symlinkSync(f.home, home);
        const vera = join(home, ".vera");
        const desktop = desktopExtension(vera, "crow.theme");
        const held = hostExtension(vera, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        disableDesktop(vera, ["crow.theme"]);
        const report = migratePlugins({ home });
        expect(report.migrated.join("\n")).toContain("desktop crow.theme");
        expect(report.failures.join("\n")).toContain("larger than");
        expect(existsSync(desktop)).toBe(true);
        const removal = removePlugin("crow.theme", { home });
        expect(removal.legacy_removed).toEqual([desktop]);
        expect(existsSync(desktop)).toBe(false);
        expect(JSON.parse(readFileSync(join(vera, "machine", "desktop", "extensions.json"), "utf8")).disabled).toEqual([]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("completed stores leave later installs alone, including on plugin removal", async () => {
    const f = homeFixture();
    const previous = process.env.VERA_HOME;
    try {
        hostExtension(f.vera, "crow.shared");
        desktopExtension(f.vera, "crow.shared");
        expect(migratePlugins({ home: f.home }).failures).toEqual([]);
        const host = hostExtension(f.vera, "crow.shared");
        const desktop = desktopExtension(f.vera, "crow.shared");
        const later = desktopExtension(f.vera, "gull.theme");
        managed(f.vera, [{ id: "crow.shared", enabled: false }]);
        disableDesktop(f.vera, ["crow.shared", "gull.theme"]);
        const config = JSON.stringify({ extensions: [{ path: host, enabled: false, config: { keep: true } }] });
        writeFileSync(join(f.vera, "config.json"), config);

        expect(hasLegacyExtensionStores(f.vera)).toBe(false);
        expect(migratePluginsIn(f.vera).report).toEqual({
            migrated: [], skipped: [], failures: [], rollback: [], config_rewritten: false,
        });
        process.env.VERA_HOME = f.vera;
        const { runCli } = await import("../../clients/cli/main.ts");
        const stdout = { text: "", write(text: string) { this.text += text; } };
        const stderr = { text: "", write(text: string) { this.text += text; } };
        expect(await runCli(["plugin", "migrate"], { stdout, stderr })).toBe(0);
        expect(stdout.text).toContain("No legacy extensions to migrate.");
        expect(stderr.text).toBe("");
        expect(registry(f.vera).map((record) => record.name)).toEqual(["crow.shared"]);
        expect(readFileSync(join(f.vera, "config.json"), "utf8")).toBe(config);
        const removal = removePlugin("crow.shared", { home: f.home });
        expect(removal.legacy_removed).toBeUndefined();
        expect(existsSync(host)).toBe(true);
        expect(existsSync(desktop)).toBe(true);
        expect(existsSync(later)).toBe(true);
        expect(JSON.parse(readFileSync(join(f.vera, "extensions.json"), "utf8")).extensions[0].enabled).toBe(false);
        expect(JSON.parse(readFileSync(join(f.vera, "machine", "desktop", "extensions.json"), "utf8")).disabled)
            .toEqual(["crow.shared", "gull.theme"]);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("a completed host store does not block an unmigrated desktop store", () => {
    const f = homeFixture();
    try {
        hostExtension(f.vera, "crow.old");
        expect(migratePlugins({ home: f.home }).failures).toEqual([]);
        const host = hostExtension(f.vera, "crow.later");
        const config = JSON.stringify({ extensions: [{ path: host, config: { keep: true } }] });
        writeFileSync(join(f.vera, "config.json"), config);
        desktopExtension(f.vera, "gull.old");
        const report = migratePlugins({ home: f.home });
        expect(report.failures).toEqual([]);
        expect(report.migrated).toEqual(["desktop gull.old -> gull.old"]);
        expect(registry(f.vera).map((record) => record.name)).toEqual(["crow.old", "gull.old"]);
        expect(existsSync(host)).toBe(true);
        expect(readFileSync(join(f.vera, "config.json"), "utf8")).toBe(config);
        expect(existsSync(join(f.vera, "machine", "desktop", "extensions.pre-plugins", "gull.old"))).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("plugin removal cleans an active legacy store but leaves a completed store alone", () => {
    const f = homeFixture();
    try {
        const host = hostExtension(f.vera, "crow.shared");
        desktopExtension(f.vera, "crow.shared");
        const held = hostExtension(f.vera, "crow.large");
        writeFileSync(join(held, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        expect(migratePlugins({ home: f.home }).failures).toHaveLength(1);
        const desktopStore = join(f.vera, "machine", "desktop", "extensions");
        renameSync(desktopStore, `${desktopStore}.pre-plugins`);
        const desktop = desktopExtension(f.vera, "crow.shared");
        disableDesktop(f.vera, ["crow.shared"]);
        const removal = removePlugin("crow.shared", { home: f.home });
        expect(removal.legacy_removed).toEqual([host]);
        expect(existsSync(host)).toBe(false);
        expect(existsSync(desktop)).toBe(true);
        expect(JSON.parse(readFileSync(join(f.vera, "machine", "desktop", "extensions.json"), "utf8")).disabled)
            .toEqual(["crow.shared"]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a completed desktop store does not block an unmigrated host store", () => {
    const f = homeFixture();
    try {
        desktopExtension(f.vera, "crow.old");
        expect(migratePlugins({ home: f.home }).failures).toEqual([]);
        const desktop = desktopExtension(f.vera, "crow.later");
        const host = hostExtension(f.vera, "gull.old");
        writeFileSync(join(f.vera, "config.json"), JSON.stringify({ extensions: [{ path: host, config: { keep: true } }] }));
        const report = migratePlugins({ home: f.home });
        expect(report.failures).toEqual([]);
        expect(report.migrated).toEqual(["host gull.old -> gull.old"]);
        expect(registry(f.vera).map((record) => record.name)).toEqual(["crow.old", "gull.old"]);
        expect(existsSync(desktop)).toBe(true);
        expect(JSON.parse(readFileSync(join(f.vera, "config.json"), "utf8")).extensions[0])
            .toEqual({ path: join(f.vera, "plugins", "gull.old", "host"), config: { keep: true } });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a state-only rollback copy marks its store as migrated", () => {
    const f = homeFixture();
    try {
        managed(f.vera, []);
        mkdirSync(join(f.vera, "machine", "desktop"), { recursive: true });
        disableDesktop(f.vera, []);
        const first = migratePlugins({ home: f.home });
        expect(first.failures).toEqual([]);
        expect(first.rollback).toContain(join(f.vera, "extensions.pre-plugins.json"));
        expect(first.rollback).toContain(join(f.vera, "machine", "desktop", "extensions.pre-plugins.json"));
        const host = hostExtension(f.vera, "crow.later");
        const desktop = desktopExtension(f.vera, "gull.later");
        expect(hasLegacyExtensionStores(f.vera)).toBe(false);
        expect(migratePlugins({ home: f.home })).toEqual({
            migrated: [], skipped: [], failures: [], rollback: [], config_rewritten: false,
        });
        expect(registry(f.vera)).toEqual([]);
        expect(existsSync(host)).toBe(true);
        expect(existsSync(desktop)).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a rollback copy appearing during migration is preserved and named", () => {
    const f = homeFixture();
    try {
        const host = hostExtension(f.vera, "crow.race");
        const backup = join(f.vera, "extensions.pre-plugins");
        mkdirSync(backup);
        writeFileSync(join(backup, "old.txt"), "kept");
        expect(() => renameLegacyStores(legacyStores(f.vera), { host: true, desktop: false }))
            .toThrow(`Rollback copy already exists: ${backup}. Move it aside to let migration finish.`);
        expect(existsSync(host)).toBe(true);
        expect(readFileSync(join(backup, "old.txt"), "utf8")).toBe("kept");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../clients/cli/main.ts";
import { installExtension, removeExtension, setAnyExtensionEnabled } from "../../src/extensions/manager.ts";
import { renderExtensionInstallPreview, renderExtensionMutation } from "../../src/extensions/manager-command.ts";
import { installPlugin, listPlugins } from "../../src/plugins/manager.ts";
import { AGENT_MCP_SCHEMA, AGENT_PLUGIN_SCHEMA, isPortablePluginName } from "../../src/plugins/naming.ts";

function fixture() {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "vera-plugin-migrate-command-"));
    return { root, home: join(root, "home"), vera: join(root, "home", ".vera") };
}

function writeHost(path: string, id: string, skills = false): void {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "vera.extension.json"), JSON.stringify({
        id, sdk: "1", version: "1.0.0", entrypoint: "extension.ts", capabilities: [],
        ...(skills ? { contributes: { skills: ["skills"] } } : {}),
    }));
    writeFileSync(join(path, "extension.ts"), "export default {};\n");
    if (skills) writeSkill(path, "crow-skill");
}

function writeSkill(path: string, name: string): void {
    const skill = join(path, "skills", name);
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: A skill.\n---\n\nBody.\n`);
}

function sink() {
    return { text: "", write(text: string) { this.text += text; } };
}

test("extension install uses a plugin and extension-owned skills can be removed", async () => {
    const f = fixture();
    try {
        const source = join(f.root, "source");
        writeHost(source, "crow.ext", true);
        const stdout = sink();
        const stderr = sink();
        const dependencies = {
            stdout, stderr,
            extensionManager: {
                install: (path: string, options?: { dryRun?: boolean }) => installExtension(path, { home: f.home, ...options }),
                setEnabled: (id: string, enabled: boolean) => setAnyExtensionEnabled(id, enabled, { home: f.home }),
                remove: (id: string) => removeExtension(id, { home: f.home }),
            },
        };
        expect(await runCli(["extension", "install", source], dependencies)).toBe(0);
        expect(stdout.text).toContain("Extension folders install as plugins");
        expect(listPlugins({ home: f.home }).plugins[0]?.record.components.skills).toEqual(["crow-skill"]);
        expect(await runCli(["extension", "disable", "crow.ext"], dependencies)).toBe(1);
        expect(stderr.text).toContain("vera plugin disable crow.ext");
        stdout.text = "";
        expect(await runCli(["extension", "remove", "crow.ext"], dependencies)).toBe(0);
        expect(stdout.text).toContain("Removed plugin crow.ext");
        expect(listPlugins({ home: f.home }).plugins).toHaveLength(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("extension removal keeps plugins that contain other components", () => {
    const f = fixture();
    try {
        const source = join(f.root, "source");
        writeHost(join(source, "host"), "crow.host", true);
        writeSkill(source, "other-skill");
        writeFileSync(join(source, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA, name: "crow-pack",
            extensions: { "dev.vera": { extension: "./host" } },
        }));
        installPlugin(source, { home: f.home });
        expect(() => removeExtension("crow.host", { home: f.home })).toThrow("vera plugin remove crow-pack");
        expect(listPlugins({ home: f.home }).plugins).toHaveLength(1);
        expect(existsSync(join(f.vera, "plugins", "crow-pack"))).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("extension removal accepts a host and desktop with the same id", () => {
    const f = fixture();
    try {
        const source = join(f.root, "source");
        writeHost(join(source, "host"), "crow.dual", true);
        const desktop = join(source, "desktop");
        mkdirSync(desktop);
        writeFileSync(join(desktop, "vera.desktop.json"), JSON.stringify({ id: "crow.dual", version: "1.0.0", engine: "vera-gui@^1" }));
        writeFileSync(join(source, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA, name: "crow-dual",
            extensions: { "dev.vera": { extension: "./host", desktop: "./desktop" } },
        }));
        installPlugin(source, { home: f.home });
        const removed = removeExtension("crow.dual", { home: f.home });
        expect(renderExtensionMutation("remove", removed)).toContain("Removed plugin crow-dual");
        expect(listPlugins({ home: f.home }).plugins).toHaveLength(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("portable plugin names accept a single letter or digit", () => {
    expect(isPortablePluginName("a")).toBe(true);
    expect(isPortablePluginName("9")).toBe(true);
    expect(isPortablePluginName("-")).toBe(false);
    expect(isPortablePluginName("a--b")).toBe(false);
});

test("extension removal refuses a package with another desktop id or root MCP", () => {
    const f = fixture();
    try {
        const source = join(f.root, "source");
        writeHost(join(source, "host"), "crow.one");
        const desktop = join(source, "desktop");
        mkdirSync(desktop);
        writeFileSync(join(desktop, "vera.desktop.json"), JSON.stringify({ id: "crow.two", version: "1.0.0", engine: "vera-gui@^1" }));
        writeFileSync(join(source, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA, name: "crow-parts",
            extensions: { "dev.vera": { extension: "./host", desktop: "./desktop" } },
        }));
        installPlugin(source, { home: f.home });
        expect(() => removeExtension("crow.one", { home: f.home })).toThrow("vera plugin remove crow-parts");
        const other = join(f.root, "other");
        writeHost(join(other, "host"), "crow.three");
        writeFileSync(join(other, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA, name: "crow-server",
            extensions: { "dev.vera": { extension: "./host" } },
        }));
        writeFileSync(join(other, "mcp.json"), JSON.stringify({
            $schema: AGENT_MCP_SCHEMA, mcpServers: { crow: { type: "stdio", command: "crow" } },
        }));
        installPlugin(other, { home: f.home });
        expect(() => removeExtension("crow.three", { home: f.home })).toThrow("vera plugin remove crow-server");
        expect(listPlugins({ home: f.home }).plugins).toHaveLength(2);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

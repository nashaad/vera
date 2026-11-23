import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginManifestError } from "../../src/plugins/errors.ts";
import {
    AGENT_MCP_SCHEMA,
    AGENT_PLUGIN_SCHEMA,
} from "../../src/plugins/naming.ts";
import { loadPluginPackage } from "../../src/plugins/manifest.ts";

function temporaryRoot(): string {
    return mkdtempSync(join(tmpdir(), "vera-plugin-manifest-"));
}

function writeSkill(root: string, name: string): void {
    const directory = join(root, "skills", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: A ${name} skill.\n---\n\nBody.\n`,
    );
}

function writeAgent(root: string, name: string): void {
    const directory = join(root, "agents");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, `${name}.md`),
        `---\ndescription: A ${name} agent.\n---\n\nBody.\n`,
    );
}

function writeHostExtension(root: string, id = "vera.sample"): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "extension.ts",
        capabilities: [],
    }));
    writeFileSync(join(root, "extension.ts"), "export default {};\n");
}

function writeDesktopExtension(root: string, id = "vera.sample"): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "vera.desktop.json"), JSON.stringify({
        id,
        version: "1.0.0",
        engine: "vera-gui@^1",
        main: "main.js",
        contributes: {},
    }));
}

test("@core an Agent Plugins package reads skills, MCP servers and its Vera host part", () => {
    const root = temporaryRoot();
    try {
        writeFileSync(join(root, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "sample-plugin",
            version: "2.1.0",
            description: "A sample plugin.",
            extensions: { "dev.vera": { extension: "./dev.vera/host" } },
        }));
        writeSkill(root, "sample-skill");
        writeFileSync(join(root, "mcp.json"), JSON.stringify({
            $schema: AGENT_MCP_SCHEMA,
            mcpServers: {
                search: { type: "stdio", command: "search" },
            },
        }));
        writeHostExtension(join(root, "dev.vera", "host"), "vera.sample");

        const loaded = loadPluginPackage(root);
        expect(loaded.layout).toBe("agent-plugins");
        expect(loaded.install_name).toBe("sample-plugin");
        expect(loaded.version).toBe("2.1.0");
        expect(loaded.description).toBe("A sample plugin.");
        expect(loaded.components.skills.map((skill) => skill.name))
            .toEqual(["sample-skill"]);
        expect(loaded.components.mcp_servers.map((server) => server.name))
            .toEqual(["search"]);
        expect(loaded.components.host_extension).toMatchObject({
            id: "vera.sample",
            version: "1.0.0",
        });
        expect(loaded.components.desktop_extension).toBeNull();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a Claude package reads skills, agents and its root host extension", () => {
    const root = temporaryRoot();
    try {
        mkdirSync(join(root, ".claude-plugin"), { recursive: true });
        writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
            name: "Claude_Sample",
            version: "1.0.0",
        }));
        writeSkill(root, "claude-skill");
        writeAgent(root, "reviewer");
        writeFileSync(join(root, ".mcp.json"), JSON.stringify({
            mcpServers: { docs: { command: "docs" } },
        }));
        writeHostExtension(root, "claude.sample");
        mkdirSync(join(root, "commands"));

        const loaded = loadPluginPackage(root);
        expect(loaded.layout).toBe("claude");
        expect(loaded.install_name).toBe("claude-sample");
        expect(loaded.components.skills.map((skill) => skill.name))
            .toEqual(["claude-skill"]);
        expect(loaded.components.agents.map((agent) => agent.name))
            .toEqual(["reviewer"]);
        expect(loaded.components.mcp_servers.map((server) => server.name))
            .toEqual(["docs"]);
        expect(loaded.components.host_extension?.id).toBe("claude.sample");
        expect(loaded.ignored).toContain(
            "ignored: commands (Claude commands are not read)",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a Codex package reads skills and MCP servers without agents", () => {
    const root = temporaryRoot();
    try {
        mkdirSync(join(root, ".codex-plugin"), { recursive: true });
        writeFileSync(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
            name: "codex-sample",
            version: "0.4.0",
        }));
        writeSkill(root, "codex-skill");
        writeAgent(root, "ignored-agent");
        writeFileSync(join(root, ".mcp.json"), JSON.stringify({
            mcpServers: { notes: { command: "notes" } },
        }));

        const loaded = loadPluginPackage(root);
        expect(loaded.layout).toBe("codex");
        expect(loaded.install_name).toBe("codex-sample");
        expect(loaded.components.skills.map((skill) => skill.name))
            .toEqual(["codex-skill"]);
        expect(loaded.components.agents).toEqual([]);
        expect(loaded.components.mcp_servers.map((server) => server.name))
            .toEqual(["notes"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a bare extension folder is a plugin holding that extension", () => {
    const root = temporaryRoot();
    try {
        writeHostExtension(root, "legacy_extension");

        const loaded = loadPluginPackage(root);
        expect(loaded.layout).toBe("extension");
        expect(loaded.install_name).toBe("legacy-extension");
        expect(loaded.components.host_extension?.id).toBe("legacy_extension");
        expect(loaded.components.skills).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a bare desktop extension folder is a plugin holding that extension", () => {
    const root = temporaryRoot();
    try {
        writeDesktopExtension(root, "vera.sample-desktop");

        const loaded = loadPluginPackage(root);
        expect(loaded.layout).toBe("extension");
        expect(loaded.install_name).toBe("vera.sample-desktop");
        expect(loaded.components.host_extension).toBeNull();
        expect(loaded.components.desktop_extension).toMatchObject({
            id: "vera.sample-desktop",
            version: "1.0.0",
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the first marker wins and the other marker is reported", () => {
    const root = temporaryRoot();
    try {
        writeFileSync(join(root, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "first-wins",
        }));
        mkdirSync(join(root, ".claude-plugin"), { recursive: true });
        writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
            name: "second",
        }));

        const loaded = loadPluginPackage(root);
        expect(loaded.layout).toBe("agent-plugins");
        expect(loaded.install_name).toBe("first-wins");
        expect(loaded.ignored).toContain(
            "ignored: .claude-plugin/plugin.json (plugin.json layout wins)",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("an unsupported Agent Plugins schema is rejected", () => {
    const root = temporaryRoot();
    try {
        writeFileSync(join(root, "plugin.json"), JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
            name: "future-plugin",
        }));
        expect(() => loadPluginPackage(root)).toThrow(PluginManifestError);
        expect(() => loadPluginPackage(root)).toThrow("unsupported schema");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a non-portable Agent Plugins name is rejected", () => {
    const root = temporaryRoot();
    try {
        writeFileSync(join(root, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "Not Portable",
        }));
        expect(() => loadPluginPackage(root)).toThrow("plugin.json name");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a declared part that is missing fails that part only", () => {
    const root = temporaryRoot();
    try {
        writeFileSync(join(root, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "partial-plugin",
            extensions: { "dev.vera": { extension: "./missing", desktop: "./also-missing" } },
        }));
        writeSkill(root, "partial-skill");

        const loaded = loadPluginPackage(root);
        expect(loaded.install_name).toBe("partial-plugin");
        expect(loaded.components.skills.map((skill) => skill.name))
            .toEqual(["partial-skill"]);
        expect(loaded.components.host_extension).toBeNull();
        expect(loaded.components.desktop_extension).toBeNull();
        expect(loaded.warnings.some((warning) => warning.startsWith("host extension is missing:")))
            .toBe(true);
        expect(loaded.warnings.some((warning) => warning.startsWith("desktop extension is missing:")))
            .toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a foreign package without a Vera part reports no missing extension", () => {
    const root = temporaryRoot();
    try {
        mkdirSync(join(root, ".claude-plugin"), { recursive: true });
        writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
            name: "claude-only",
        }));
        writeSkill(root, "claude-skill");

        const loaded = loadPluginPackage(root);
        expect(loaded.components.host_extension).toBeNull();
        expect(loaded.components.desktop_extension).toBeNull();
        expect(loaded.warnings.some((warning) =>
            warning.includes("host extension")
            || warning.includes("desktop extension")
            || warning.includes("ENOENT")
        )).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a Vera part declared outside the package is reported, not read", () => {
    const parent = temporaryRoot();
    const root = join(parent, "root");
    const outside = join(parent, "outside");
    try {
        mkdirSync(root);
        writeFileSync(join(root, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "escape-plugin",
            extensions: { "dev.vera": { extension: "./../outside" } },
        }));
        writeHostExtension(outside, "vera.outside");

        const loaded = loadPluginPackage(root);
        expect(loaded.components.host_extension).toBeNull();
        expect(loaded.warnings).toContain(
            "dev.vera extension leaves the plugin: ./../outside",
        );
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

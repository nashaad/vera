import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
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

import { readPluginSnapshot, workerPluginSnapshot } from "../../src/plugins/catalog.ts";
import { hostExtensionConfigSet } from "../../src/extensions/host-set.ts";
import { installPlugin, setPluginEnabled } from "../../src/plugins/manager.ts";
import {
    AGENT_MCP_SCHEMA,
    AGENT_PLUGIN_SCHEMA,
} from "../../src/plugins/naming.ts";
import {
    pluginDataDirectoryIn,
    pluginDirectoryIn,
} from "../../src/profile-paths.ts";

interface TestHome {
    readonly root: string;
    readonly home: string;
    readonly veraHome: string;
}

function temporaryHome(): TestHome {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-snapshot-"));
    const home = join(root, "home");
    return { root, home, veraHome: join(home, ".vera") };
}

function pluginSource(
    root: string,
    servers: Record<string, unknown> = {
        local: { type: "stdio", command: "node" },
    },
): string {
    const source = join(root, "source");
    mkdirSync(join(source, "skills", "hello"), { recursive: true });
    writeFileSync(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "sample-plugin",
    }));
    writeFileSync(
        join(source, "skills", "hello", "SKILL.md"),
        "---\nname: hello\ndescription: A hello skill.\n---\n\nBody.\n",
    );
    writeFileSync(join(source, "mcp.json"), JSON.stringify({
        $schema: AGENT_MCP_SCHEMA,
        mcpServers: servers,
    }));
    return source;
}

function writeHostExtension(source: string, id: string): void {
    const directory = join(source, "dev.vera", "host");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "extension.ts",
        capabilities: ["commands.register"],
    }));
    writeFileSync(join(directory, "extension.ts"), "export function activate() {}\n");
}

test("@core worker package identity uses one lstat without hashing or walking", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = pluginSource(root);
        writeHostExtension(source, "crow.host");
        installPlugin(source, { home });
        const snapshot = readPluginSnapshot({ veraHome });
        const part = snapshot.host_extensions[0]!;
        const bootstrap = {
            entries: [{
                plugin: part.plugin, id: part.id, directory: part.directory,
                package_identity: part.package_identity, enabled: true, config: {},
            }],
            owners: snapshot.host_extension_owners,
        };
        const lstat = spyOn(fs, "lstatSync");
        const readdir = spyOn(fs, "readdirSync");
        const hash = spyOn(crypto, "createHash");
        try {
            fs.lstatSync(part.package_identity.directory, { bigint: true });
            expect(lstat).toHaveBeenCalledTimes(1);
            lstat.mockClear();
            const worker = workerPluginSnapshot(veraHome, bootstrap);
            expect(worker.host_extensions.map((extension) => extension.id)).toEqual(["crow.host"]);
            expect(lstat).toHaveBeenCalledTimes(1);
            expect(lstat.mock.calls[0]?.[0]).toBe(part.package_identity.directory);
            expect(readdir).not.toHaveBeenCalled();
            expect(hash).not.toHaveBeenCalled();
        } finally {
            hash.mockRestore();
            readdir.mockRestore();
            lstat.mockRestore();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a changed host extension id is skipped while the plugin's other parts remain", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = pluginSource(root);
        writeHostExtension(source, "crow_original");
        installPlugin(source, { home });
        const manifest = join(
            pluginDirectoryIn(veraHome, "sample-plugin"),
            "dev.vera", "host", "vera.extension.json",
        );
        const changed = JSON.parse(readFileSync(manifest, "utf8")) as { id: string };
        changed.id = "crow_changed";
        writeFileSync(manifest, JSON.stringify(changed));

        const snapshot = readPluginSnapshot({ veraHome });
        expect(snapshot.host_extensions).toEqual([]);
        expect(hostExtensionConfigSet({
            extensions: [{ path: join(manifest, ".."), enabled: true, config: {} }],
        }, snapshot).extensions.some((entry) => entry.path === join(manifest, ".."))).toBe(false);
        expect(snapshot.plugins.map((record) => record.name)).toEqual(["sample-plugin"]);
        expect(snapshot.mcp_servers.map((server) => server.name)).toEqual(["local"]);
        expect(snapshot.warnings).toContain(
            "plugin sample-plugin: host extension id crow_changed differs from "
                + "the recorded id crow_original; install the plugin again from its source",
        );

        installPlugin(source, { home });
        const repaired = readPluginSnapshot({ veraHome });
        expect(repaired.host_extensions).toMatchObject([
            { plugin: "sample-plugin", id: "crow_original" },
        ]);
        expect(repaired.warnings).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("an unrecorded host part added to an installed plugin is skipped", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = pluginSource(root);
        installPlugin(source, { home });
        writeHostExtension(pluginDirectoryIn(veraHome, "sample-plugin"), "crow_added");
        const snapshot = readPluginSnapshot({ veraHome });
        expect(snapshot.host_extensions).toEqual([]);
        expect(snapshot.warnings).toContain(
            "plugin sample-plugin: host extension id crow_added differs from "
                + "the recorded id (none); install the plugin again from its source",
        );
        expect(snapshot.mcp_servers.map((server) => server.name)).toEqual(["local"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core the host snapshot maps MCP servers from an enabled plugin", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = pluginSource(root, {
            local: {
                type: "stdio",
                command: "node",
                env: { DATA: "${PLUGIN_DATA}" },
            },
            remote: { type: "http", url: "https://example.test/mcp" },
        });
        installPlugin(source, { home });
        const snapshot = readPluginSnapshot({ home });
        expect(snapshot.warnings).toEqual([]);
        expect(snapshot.plugins.map((record) => record.name))
            .toEqual(["sample-plugin"]);
        expect(snapshot.mcp_servers.map((server) => [
            server.plugin,
            server.name,
            server.transport,
        ])).toEqual([
            ["sample-plugin", "local", "stdio"],
            ["sample-plugin", "remote", "http"],
        ]);
        expect(snapshot.mcp_servers[0]!.config).toMatchObject({
            command: ["node"],
            env: {
                PLUGIN_DATA: pluginDataDirectoryIn(veraHome, "sample-plugin"),
            },
        });
        expect(existsSync(pluginDataDirectoryIn(veraHome, "sample-plugin")))
            .toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a disabled plugin contributes no MCP servers", () => {
    const { root, home } = temporaryHome();
    try {
        installPlugin(pluginSource(root), { home });
        setPluginEnabled("sample-plugin", false, { home });
        const snapshot = readPluginSnapshot({ home });
        expect(snapshot.plugins).toEqual([]);
        expect(snapshot.mcp_servers).toEqual([]);
        expect(snapshot.warnings).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a corrupt plugin registry gives an empty snapshot with a warning", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        mkdirSync(join(veraHome, "machine"), { recursive: true });
        writeFileSync(join(veraHome, "machine", "plugins.json"), "{ not json");
        const snapshot = readPluginSnapshot({ home });
        expect(snapshot.plugins).toEqual([]);
        expect(snapshot.mcp_servers).toEqual([]);
        expect(snapshot.warnings.length).toBe(1);
        expect(snapshot.warnings[0]).toStartWith("Plugins:");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a plugin with only skills gets no data folder", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        installPlugin(pluginSource(root, {}), { home });
        const snapshot = readPluginSnapshot({ home });
        expect(snapshot.mcp_servers).toEqual([]);
        expect(existsSync(pluginDataDirectoryIn(veraHome, "sample-plugin")))
            .toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a FIFO at the plugin registry is refused instead of read", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        mkdirSync(join(veraHome, "machine"), { recursive: true });
        const path = join(veraHome, "machine", "plugins.json");
        const made = spawnSync("mkfifo", [path]);
        if (made.status !== 0) return;
        const snapshot = readPluginSnapshot({ home });
        expect(snapshot.warnings).toHaveLength(1);
        expect(snapshot.warnings[0]).toContain("not a regular file");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a registry over the plugin cap is refused", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        mkdirSync(join(veraHome, "machine"), { recursive: true });
        const record = (index: number) => ({
            name: `plugin-${index}`,
            source: { kind: "local", path: `/tmp/plugin-${index}` },
            digest: `sha256:${"a".repeat(64)}`,
            entries: 1,
            total_bytes: 1,
            newest_mtime_ms: 1,
            directory: `plugins/plugin-${index}`,
            enabled: false,
            installed_at: "2026-01-01T00:00:00.000Z",
            components: {
                skills: [],
                agents: [],
                mcp_servers: [],
                skill_roots: [],
                agent_roots: [],
                host_extension: null,
                desktop_extension: null,
            },
            ignored: [],
        });
        writeFileSync(
            join(veraHome, "machine", "plugins.json"),
            JSON.stringify({
                schema_version: 1,
                plugins: Array.from({ length: 201 }, (_, index) => record(index)),
            }),
        );
        const snapshot = readPluginSnapshot({ home });
        expect(snapshot.plugins).toEqual([]);
        expect(snapshot.warnings).toHaveLength(1);
        expect(snapshot.warnings[0]).toContain("at most 200 plugins are kept");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a missing plugin folder is reported and contributes no servers", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        installPlugin(pluginSource(root), { home });
        rmSync(pluginDirectoryIn(veraHome, "sample-plugin"), {
            recursive: true,
            force: true,
        });
        const snapshot = readPluginSnapshot({ home });
        expect(snapshot.mcp_servers).toEqual([]);
        expect(snapshot.warnings).toContain(
            "plugin sample-plugin: the installed folder is missing",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

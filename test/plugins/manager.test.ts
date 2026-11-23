import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    installPlugin,
    listPlugins,
    pluginStorePaths,
    removePlugin,
    setPluginEnabled,
    showPlugin,
} from "../../src/plugins/manager.ts";
import {
    AGENT_PLUGIN_SCHEMA,
} from "../../src/plugins/naming.ts";
import { PluginManagerError } from "../../src/plugins/registry.ts";
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
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-manager-"));
    const home = join(root, "home");
    return { root, home, veraHome: join(home, ".vera") };
}

function writeSkill(root: string, name: string): void {
    const directory = join(root, "skills", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: A ${name} skill.\n---\n\nBody.\n`,
    );
}

function agentPluginSource(
    root: string,
    name = "sample-plugin",
): string {
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name,
        version: "1.0.0",
        description: "A sample plugin.",
    }));
    writeSkill(source, "hello");
    return source;
}

function extensionSource(root: string): string {
    const source = join(root, "extension-source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "vera.extension.json"), JSON.stringify({
        id: "legacy_extension",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "extension.ts",
        capabilities: [],
    }));
    writeFileSync(join(source, "extension.ts"), "export default {};\n");
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
        capabilities: [],
    }));
    writeFileSync(join(directory, "extension.ts"), "export default {};\n");
}

test("@core plugin install and preview refuse included and core host extension ids", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        mkdirSync(veraHome, { recursive: true });
        writeFileSync(join(veraHome, "config.json"), JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
            disabled_included_extensions: ["vera.mcp", "vera.customize"],
        }));
        for (const [id, owner] of [
            ["vera.mcp", "an included"],
            ["vera.customize", "a core"],
        ] as const) {
            const source = agentPluginSource(join(root, id));
            writeHostExtension(source, id);
            for (const dry_run of [true, false]) {
                expect(() => installPlugin(source, { home, dry_run })).toThrow(
                    `Host extension id ${id} is already used by ${owner} extension.`,
                );
                expect(listPlugins({ home }).plugins).toHaveLength(0);
            }
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core plugin install and preview refuse another plugin's host extension id", () => {
    const { root, home } = temporaryHome();
    try {
        const owner = agentPluginSource(join(root, "owner"), "crow-owner");
        writeHostExtension(owner, "crow_bridge");
        installPlugin(owner, { home });
        setPluginEnabled("crow-owner", false, { home });
        const other = agentPluginSource(join(root, "other"), "crow-other");
        writeHostExtension(other, "crow_bridge");

        for (const dry_run of [true, false]) {
            expect(() => installPlugin(other, { home, dry_run })).toThrow(
                "Host extension id crow_bridge is already used by plugin crow-owner.",
            );
            expect(listPlugins({ home }).plugins.map(({ record }) => record.name))
                .toEqual(["crow-owner"]);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core replacing a plugin may keep its host extension id", () => {
    const { root, home } = temporaryHome();
    try {
        const first = agentPluginSource(join(root, "first"), "crow-owner");
        const replacement = agentPluginSource(join(root, "replacement"), "crow-owner");
        writeHostExtension(first, "crow_bridge");
        writeHostExtension(replacement, "crow_bridge");
        writeSkill(replacement, "plunder");
        installPlugin(first, { home });
        setPluginEnabled("crow-owner", false, { home });

        const preview = installPlugin(replacement, { home, dry_run: true });
        expect(preview.preview.replaces?.name).toBe("crow-owner");
        expect(preview.preview.enabled).toBe(false);
        const installed = installPlugin(replacement, { home });
        expect(installed.record).toMatchObject({
            name: "crow-owner",
            enabled: false,
            components: { host_extension: "crow_bridge" },
        });
        expect(showPlugin("crow-owner", { home }).package.components.skills.map(({ name }) => name))
            .toContain("plunder");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core plugin install, list, show, enable, disable and remove use the home store", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        const installed = installPlugin(source, { home });

        expect(installed.noop).toBe(false);
        expect(installed.record).toMatchObject({
            name: "sample-plugin",
            version: "1.0.0",
            description: "A sample plugin.",
            source: { kind: "local", path: source },
            directory: "plugins/sample-plugin",
            enabled: true,
            components: {
                skills: ["hello"],
                agents: [],
                mcp_servers: [],
                host_extension: null,
                desktop_extension: null,
            },
        });
        expect(installed.preview.layout).toBe("agent-plugins");
        expect(installed.record!.entries).toBeGreaterThan(0);
        expect(installed.record!.total_bytes).toBeGreaterThan(0);
        expect(installed.record!.newest_mtime_ms).toBeGreaterThan(0);
        expect("files" in installed.record!).toBe(false);
        expect(existsSync(join(
            pluginDirectoryIn(veraHome, "sample-plugin"),
            "skills",
            "hello",
            "SKILL.md",
        ))).toBe(true);
        expect(readdirSync(pluginStorePaths({ home }).plugins_directory)
            .some((entry) => entry.startsWith(".staging-")))
            .toBe(false);

        const listed = listPlugins({ home });
        expect(listed.plugins).toHaveLength(1);
        expect(listed.plugins[0]).toMatchObject({
            record: { name: "sample-plugin", enabled: true },
            modified: false,
            problem: null,
        });
        expect(listed.orphans).toEqual([]);

        const dataDirectory = pluginDataDirectoryIn(veraHome, "sample-plugin");
        mkdirSync(dataDirectory, { recursive: true });
        writeFileSync(join(dataDirectory, "state.txt"), "0123456789");

        const shown = showPlugin("sample-plugin", { home });
        expect(shown.package.layout).toBe("agent-plugins");
        expect(shown.modified).toBe(false);
        expect(shown.digest).toBe(installed.record!.digest);
        expect(shown.data_bytes).toBe(10);

        const disabled = setPluginEnabled("sample-plugin", false, { home });
        expect(disabled.enabled).toBe(false);
        expect(listPlugins({ home }).plugins[0]?.record.enabled).toBe(false);

        const enabled = setPluginEnabled("sample-plugin", true, { home });
        expect(enabled.enabled).toBe(true);

        const removal = removePlugin("sample-plugin", { home });
        expect(removal.record.name).toBe("sample-plugin");
        expect(removal.data_kept).toBe(true);
        expect(removal.data_bytes).toBe(10);
        expect(existsSync(pluginDirectoryIn(veraHome, "sample-plugin")))
            .toBe(false);
        expect(existsSync(dataDirectory)).toBe(true);
        expect(listPlugins({ home }).plugins).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a reinstall with the same digest is a no-op and a changed digest replaces in place", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        const first = installPlugin(source, { home });
        setPluginEnabled("sample-plugin", false, { home });

        const same = installPlugin(source, { home });
        expect(same.noop).toBe(true);
        expect(same.record).toMatchObject({
            enabled: false,
            installed_at: first.record!.installed_at,
        });

        writeFileSync(
            join(source, "skills", "hello", "SKILL.md"),
            "---\nname: hello\ndescription: A hello skill.\n---\n\nChanged body.\n",
        );
        const changed = installPlugin(source, { home });
        expect(changed.noop).toBe(false);
        expect(changed.preview.replaces).toMatchObject({ name: "sample-plugin" });
        expect(changed.record).toMatchObject({ enabled: false });
        expect(changed.record!.digest).not.toBe(first.record!.digest);
        expect(readFileSync(
            join(
                pluginDirectoryIn(veraHome, "sample-plugin"),
                "skills",
                "hello",
                "SKILL.md",
            ),
            "utf8",
        )).toContain("Changed body.");
        expect(readdirSync(pluginStorePaths({ home }).plugins_directory)
            .some((entry) => entry.startsWith(".replaced-")))
            .toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core every layout installs, including a bare extension folder", () => {
    const { root, home } = temporaryHome();
    try {
        const agent = agentPluginSource(join(root, "agent"));
        const claude = join(root, "claude");
        mkdirSync(join(claude, ".claude-plugin"), { recursive: true });
        writeFileSync(join(claude, ".claude-plugin", "plugin.json"), JSON.stringify({
            name: "claude_plugin",
        }));
        writeSkill(claude, "claude-skill");
        writeFileSync(join(claude, ".mcp.json"), JSON.stringify({
            mcpServers: { docs: { command: "docs" } },
        }));

        const codex = join(root, "codex");
        mkdirSync(join(codex, ".codex-plugin"), { recursive: true });
        writeFileSync(join(codex, ".codex-plugin", "plugin.json"), JSON.stringify({
            name: "codex-plugin",
        }));
        writeSkill(codex, "codex-skill");

        const bare = extensionSource(root);

        expect(installPlugin(agent, { home }).record).toMatchObject({
            name: "sample-plugin",
            components: { skills: ["hello"] },
        });
        expect(installPlugin(claude, { home }).record).toMatchObject({
            name: "claude-plugin",
            components: { skills: ["claude-skill"], mcp_servers: ["docs"] },
        });
        expect(installPlugin(codex, { home }).record).toMatchObject({
            name: "codex-plugin",
            components: { skills: ["codex-skill"] },
        });
        expect(installPlugin(bare, { home }).record).toMatchObject({
            name: "legacy-extension",
            components: { host_extension: "legacy_extension" },
        });

        expect(listPlugins({ home }).plugins.map((entry) => entry.record.name))
            .toEqual([
                "claude-plugin",
                "codex-plugin",
                "legacy-extension",
                "sample-plugin",
            ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a dry run previews without creating the plugin store", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        const result = installPlugin(source, { home, dry_run: true });
        expect(result.record).toBeNull();
        expect(result.preview).toMatchObject({
            name: "sample-plugin",
            layout: "agent-plugins",
            enabled: true,
            dry_run: true,
        });
        expect(existsSync(join(veraHome, "plugins"))).toBe(false);
        expect(existsSync(pluginStorePaths({ home }).registry_path))
            .toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a symlink in the package is refused", () => {
    const { root, home } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        const outside = join(root, "outside.ts");
        writeFileSync(outside, "export default {};\n");
        symlinkSync(outside, join(source, "linked.ts"));
        expect(() => installPlugin(source, { home }))
            .toThrow("Symlinks are not supported in package sources");
        expect(listPlugins({ home }).plugins).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a symlinked source folder is refused", () => {
    const { root, home } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        const link = join(root, "source-link");
        symlinkSync(source, link);
        expect(() => installPlugin(link, { home }))
            .toThrow("Plugin source is a symlink");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a file over the per-file cap is refused", () => {
    const { root, home } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        writeFileSync(join(source, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
        expect(() => installPlugin(source, { home }))
            .toThrow("Package file is larger than 4194304 bytes");
        expect(listPlugins({ home }).plugins).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a package over the entry cap is refused", () => {
    const { root, home } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        const many = join(source, "many");
        mkdirSync(many);
        for (let index = 0; index < 2_001; index += 1) {
            writeFileSync(join(many, `file-${index}.txt`), "");
        }
        expect(() => installPlugin(source, { home }))
            .toThrow("Package has more than 2000 entries");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a corrupt registry refuses reads and writes without being replaced", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        mkdirSync(veraHome, { recursive: true });
        const registry = pluginStorePaths({ home }).registry_path;
        mkdirSync(dirname(registry), { recursive: true });
        writeFileSync(registry, "{ not json");
        expect(() => listPlugins({ home })).toThrow(PluginManagerError);
        expect(() => installPlugin(source, { home }))
            .toThrow("is not valid JSON");
        expect(readFileSync(registry, "utf8")).toBe("{ not json");
        expect(existsSync(join(veraHome, "plugins"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a folder without a record is an orphan and a missing folder is reported", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        installPlugin(source, { home });
        const orphan = pluginDirectoryIn(veraHome, "orphan");
        mkdirSync(orphan, { recursive: true });
        writeFileSync(join(orphan, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "orphan",
        }));

        const listed = listPlugins({ home });
        expect(listed.plugins.map((entry) => entry.record.name))
            .toEqual(["sample-plugin"]);
        expect(listed.orphans).toEqual([orphan]);

        rmSync(pluginDirectoryIn(veraHome, "sample-plugin"), {
            recursive: true,
            force: true,
        });
        const missing = listPlugins({ home }).plugins[0];
        expect(missing?.problem).toBe("the installed folder is missing");
        expect(() => showPlugin("sample-plugin", { home }))
            .toThrow("is recorded but its folder is missing");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a changed file marks a plugin modified in list and show", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        installPlugin(source, { home });
        writeFileSync(
            join(pluginDirectoryIn(veraHome, "sample-plugin"), "README.md"),
            "edited after install\n",
        );

        expect(listPlugins({ home }).plugins[0]?.modified).toBe(true);
        const shown = showPlugin("sample-plugin", { home });
        expect(shown.modified).toBe(true);
        expect(shown.digest).not.toBe(shown.record.digest);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("remove --purge deletes the plugin data and remove keeps it otherwise", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        installPlugin(source, { home });
        const dataDirectory = pluginDataDirectoryIn(veraHome, "sample-plugin");
        mkdirSync(dataDirectory, { recursive: true });
        writeFileSync(join(dataDirectory, "state.txt"), "data");

        expect(removePlugin("sample-plugin", { home, purge: true }))
            .toMatchObject({ data_kept: false });
        expect(existsSync(dataDirectory)).toBe(false);

        installPlugin(source, { home });
        mkdirSync(dataDirectory, { recursive: true });
        writeFileSync(join(dataDirectory, "state.txt"), "data");
        expect(removePlugin("sample-plugin", { home }))
            .toMatchObject({ data_kept: true });
        expect(existsSync(dataDirectory)).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("plugin mutations refuse a live lock and reclaim a dead one", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        mkdirSync(veraHome, { recursive: true });
        const lockPath = `${pluginStorePaths({ home }).registry_path}.lock`;
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
        expect(() => installPlugin(source, { home }))
            .toThrow("Another operation is using");
        writeFileSync(lockPath, JSON.stringify({ pid: 999_999 }));
        expect(installPlugin(source, { home }).record?.name)
            .toBe("sample-plugin");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("two concurrent installs leave a readable registry", async () => {
    const { root, home } = temporaryHome();
    try {
        const first = agentPluginSource(join(root, "first"), "first-plugin");
        const second = agentPluginSource(join(root, "second"), "second-plugin");
        const script = join(root, "install-child.ts");
        writeFileSync(script, `
            import { installPlugin } from ${
    JSON.stringify(new URL("../../src/plugins/manager.ts", import.meta.url).href)
};
            try {
                installPlugin(process.env.PLUGIN_SOURCE!, { home: process.env.PLUGIN_HOME! });
                process.stdout.write("ok");
            } catch (error) {
                process.stdout.write(\`error:\${error instanceof Error ? error.message : String(error)}\`);
            }
        `);
        const spawn = (source: string) => Bun.spawn(
            [process.execPath, script],
            {
                env: {
                    ...process.env,
                    PLUGIN_SOURCE: source,
                    PLUGIN_HOME: home,
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        const firstChild = spawn(first);
        const secondChild = spawn(second);
        const [firstOutput, secondOutput] = await Promise.all([
            new Response(firstChild.stdout).text(),
            new Response(secondChild.stdout).text(),
        ]);
        const [firstExit, secondExit] = await Promise.all([
            firstChild.exited,
            secondChild.exited,
        ]);
        expect(firstExit).toBe(0);
        expect(secondExit).toBe(0);

        const listed = listPlugins({ home });
        expect(listed.plugins.every((entry) => entry.problem === null)).toBe(true);
        for (const [output, name, source] of [
            [firstOutput, "first-plugin", first],
            [secondOutput, "second-plugin", second],
        ] as const) {
            if (output === "ok") {
                expect(listed.plugins.some((entry) =>
                    entry.record.name === name
                    && entry.record.source.path === source
                )).toBe(true);
            } else {
                expect(output).toContain("Another operation is using");
            }
        }
        const pluginsDirectory = pluginStorePaths({ home }).plugins_directory;
        expect(readdirSync(pluginsDirectory)
            .some((entry) => entry.startsWith(".staging-")
                || entry.startsWith(".replaced-")))
            .toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a different folder with the same Agent Plugins name replaces that plugin", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const first = agentPluginSource(join(root, "first"), "shared-name");
        const second = agentPluginSource(join(root, "second"), "shared-name");
        writeSkill(second, "second-skill");
        installPlugin(first, { home });
        const replaced = installPlugin(second, { home });
        expect(replaced.noop).toBe(false);
        expect(replaced.record).toMatchObject({
            name: "shared-name",
            source: { kind: "local", path: second },
            components: { skills: ["hello", "second-skill"] },
        });
        expect(replaced.preview.replaces).toEqual({
            name: "shared-name",
            source_path: first,
        });
        expect(existsSync(join(
            pluginDirectoryIn(veraHome, "shared-name"),
            "skills",
            "second-skill",
            "SKILL.md",
        ))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a different Claude or Codex folder with the same name replaces that plugin", () => {
    const { root, home } = temporaryHome();
    try {
        for (const [layout, manifestPath] of [
            ["claude", ".claude-plugin/plugin.json"],
            ["codex", ".codex-plugin/plugin.json"],
        ] as const) {
            const first = join(root, `${layout}-one`);
            mkdirSync(join(first, manifestPath, ".."), { recursive: true });
            writeFileSync(join(first, manifestPath), JSON.stringify({ name: "review_tools" }));
            const second = join(root, `${layout}-two`);
            mkdirSync(join(second, manifestPath, ".."), { recursive: true });
            writeFileSync(join(second, manifestPath), JSON.stringify({ name: "review_tools" }));
            writeFileSync(join(second, "changes.txt"), "a second copy");

            expect(installPlugin(first, { home }).record?.name).toBe("review-tools");
            const replaced = installPlugin(second, { home });
            expect(replaced.record?.name).toBe("review-tools");
            expect(replaced.preview.replaces).toEqual({
                name: "review-tools",
                source_path: first,
            });
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a same-digest reinstall repairs a missing or modified installed copy", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        installPlugin(source, { home });
        const installed = pluginDirectoryIn(veraHome, "sample-plugin");
        rmSync(installed, { recursive: true, force: true });
        const repaired = installPlugin(source, { home });
        expect(repaired.noop).toBe(false);
        expect(repaired.preview.replaces).toMatchObject({ name: "sample-plugin" });
        expect(existsSync(join(installed, "plugin.json"))).toBe(true);

        writeFileSync(join(installed, "README.md"), "edited\n");
        const restored = installPlugin(source, { home });
        expect(restored.noop).toBe(false);
        expect(existsSync(join(installed, "README.md"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a symlinked plugin data directory is refused", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        installPlugin(source, { home });
        const outside = join(root, "outside-data");
        mkdirSync(outside);
        writeFileSync(join(outside, "state.txt"), "state");
        const dataDirectory = pluginDataDirectoryIn(veraHome, "sample-plugin");
        mkdirSync(dirname(dataDirectory), { recursive: true });
        symlinkSync(outside, dataDirectory);
        expect(() => showPlugin("sample-plugin", { home }))
            .toThrow("Plugin data directory is a symlink");
        expect(() => removePlugin("sample-plugin", { home, purge: true }))
            .toThrow("Plugin data directory is a symlink");
        expect(existsSync(join(outside, "state.txt"))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a symlinked lock file is refused", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = agentPluginSource(root);
        mkdirSync(veraHome, { recursive: true });
        const lockPath = `${pluginStorePaths({ home }).registry_path}.lock`;
        mkdirSync(dirname(lockPath), { recursive: true });
        const target = join(root, "lock-target");
        writeFileSync(target, "");
        symlinkSync(target, lockPath);
        expect(() => installPlugin(source, { home }))
            .toThrow("Lock file is a symlink");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

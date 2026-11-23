import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../clients/cli/main.ts";
import { runPluginCommand } from "../../clients/tui/main/plugin-ops.ts";
import {
    parsePluginManagerCommand,
    pluginManagerUsage,
    tokenizePluginManagerArguments,
} from "../../src/plugins/command.ts";
import {
    installPlugin,
    listPlugins,
    setPluginEnabled,
    showPlugin,
    type PluginManagerOperations,
} from "../../src/plugins/manager.ts";
import {
    AGENT_MCP_SCHEMA,
    AGENT_PLUGIN_SCHEMA,
} from "../../src/plugins/naming.ts";

function temporaryHome(): {
    readonly root: string;
    readonly home: string;
    readonly veraHome: string;
} {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-command-"));
    const home = join(root, "home");
    return { root, home, veraHome: join(home, ".vera") };
}

function pluginSource(root: string): string {
    const source = join(root, "source");
    const skill = join(source, "skills", "hello");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "sample-plugin",
        version: "1.0.0",
    }));
    writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: hello\ndescription: A hello skill.\n---\n\nBody.\n",
    );
    return source;
}

function writeHostExtension(source: string, id: string): void {
    const extension = join(source, "dev.vera", "host");
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(extension, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "extension.ts",
        capabilities: [],
    }));
    writeFileSync(join(extension, "extension.ts"), "export default {};\n");
}

function outputSink(): { text: string; write: (text: string) => void } {
    const sink = {
        text: "",
        write(text: string) {
            sink.text += text;
        },
    };
    return sink;
}

test("plugin commands parse install, show, enable, disable and remove", () => {
    expect(parsePluginManagerCommand(["plugin", "list"])).toEqual({
        command: { operation: "list" },
    });
    expect(parsePluginManagerCommand([
        "plugin",
        "install",
        "/tmp/My Plugin",
        "--dry-run",
    ])).toEqual({
        command: {
            operation: "install",
            source: "/tmp/My Plugin",
            dry_run: true,
        },
    });
    expect(parsePluginManagerCommand(["plugin", "show", "sample"]))
        .toEqual({ command: { operation: "show", name: "sample" } });
    expect(parsePluginManagerCommand(["plugin", "enable", "sample"]))
        .toEqual({ command: { operation: "enable", name: "sample" } });
    expect(parsePluginManagerCommand(["plugin", "disable", "sample"]))
        .toEqual({ command: { operation: "disable", name: "sample" } });
    expect(parsePluginManagerCommand([
        "plugin",
        "remove",
        "sample",
        "--purge",
    ])).toEqual({
        command: { operation: "remove", name: "sample", purge: true },
    });
    expect(parsePluginManagerCommand(["plugin", "remove", "sample"])).toEqual({
        command: { operation: "remove", name: "sample", purge: false },
    });
    expect(parsePluginManagerCommand([
        "plugin",
        "install",
        "/tmp/x",
        "--dry-run",
        "--purge",
    ])).toEqual({ error: "Usage: vera plugin install <path> [--dry-run]" });
    expect(parsePluginManagerCommand(["plugin", "bogus"])).toMatchObject({
        error: expect.stringContaining("Unknown plugin operation"),
    });
    expect(parsePluginManagerCommand(["extension", "list"])).toBeUndefined();
});

test("plugin parser usage accepts a command label", () => {
    const cases = [
        { args: ["plugin"], suffix: "list|show|install|enable|disable|remove|migrate <…>" },
        { args: ["plugin", "list", "extra"], suffix: "list" },
        { args: ["plugin", "show"], suffix: "show <name>" },
        { args: ["plugin", "install"], suffix: "install <path> [--dry-run]" },
        { args: ["plugin", "enable"], suffix: "enable <name>" },
        { args: ["plugin", "disable"], suffix: "disable <name>" },
        { args: ["plugin", "remove"], suffix: "remove <name> [--purge]" },
        { args: ["plugin", "migrate", "extra"], suffix: "migrate" },
    ];
    for (const { args, suffix } of cases) {
        expect(parsePluginManagerCommand(args)).toEqual({ error: `Usage: vera plugin ${suffix}` });
        expect(parsePluginManagerCommand(args, "/plugins")).toEqual({ error: `Usage: /plugins ${suffix}` });
    }
    const suffix = "list|show|install|enable|disable|remove|migrate <…>";
    expect(pluginManagerUsage()).toBe(`Usage: vera plugin ${suffix}`);
    expect(pluginManagerUsage("/plugins")).toBe(`Usage: /plugins ${suffix}`);
    expect(parsePluginManagerCommand(["plugin", "unknown"])).toEqual({
        error: `Unknown plugin operation 'unknown'. Usage: vera plugin ${suffix}`,
    });
    expect(parsePluginManagerCommand(["plugin", "unknown"], "/plugins")).toEqual({
        error: `Unknown plugin operation 'unknown'. Usage: /plugins ${suffix}`,
    });
});

test("vera plugin CLI reports its own usage label", async () => {
    const stdout = outputSink();
    const stderr = outputSink();
    const dependencies = { stdout, stderr, dispatchToHostRelease: async () => undefined };

    expect(await runCli(["plugin", "show"], dependencies)).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("Usage: vera plugin show <name>\n");

    stderr.text = "";
    expect(await runCli(["plugin", "unknown"], dependencies)).toBe(1);
    expect(stderr.text).toBe(
        "Unknown plugin operation 'unknown'. Usage: vera plugin list|show|install|enable|disable|remove|migrate <…>\n",
    );
});

test("the plugin tokenizer accepts a quoted path", () => {
    const parsed = tokenizePluginManagerArguments(
        "install \"My Plugins/sample\" --dry-run",
    );
    expect(parsed).toEqual({
        words: ["install", "My Plugins/sample", "--dry-run"],
    });
    expect(tokenizePluginManagerArguments("install \"unclosed"))
        .toEqual({ error: "Unclosed quote in plugin command" });
});

test("vera plugin list and install --dry-run reach the manager and print", async () => {
    const { root, home } = temporaryHome();
    try {
        const source = pluginSource(root);
        const stdout = outputSink();
        const stderr = outputSink();
        const dependencies = {
            stdout,
            stderr,
            dispatchToHostRelease: async () => undefined,
            pluginManager: {
                list: () => listPlugins({ home }),
                install: (request: { source: string; dry_run: boolean }) =>
                    installPlugin(request.source, {
                        home,
                        dry_run: request.dry_run,
                    }),
            },
        };
        expect(await runCli(["plugin", "list"], dependencies)).toBe(0);
        expect(stdout.text).toBe("No plugins installed.\n");

        stdout.text = "";
        expect(await runCli(
            ["plugin", "install", source, "--dry-run"],
            dependencies,
        )).toBe(0);
        expect(stdout.text).toContain("Plugin install plan (dry run)");
        expect(stdout.text).toContain("name:        sample-plugin");
        expect(stdout.text).toContain("skills:      hello");

        stdout.text = "";
        expect(await runCli(["plugin", "install", source], dependencies)).toBe(0);
        expect(stdout.text).toContain("Installed sample-plugin.");

        stdout.text = "";
        expect(await runCli(["plugin", "list"], dependencies)).toBe(0);
        expect(stdout.text).toContain("Plugins");
        expect(stdout.text).toContain("sample-plugin");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("plugin commands show a dash for a missing version", async () => {
    const { root, home } = temporaryHome();
    const signals = spyOn(process, "kill").mockImplementation(() => {
        throw new Error("Test must not send signals");
    });
    try {
        const source = pluginSource(root);
        writeFileSync(join(source, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "sample-plugin",
        }));
        const stdout = outputSink();
        const dependencies = {
            stdout,
            stderr: outputSink(),
            dispatchToHostRelease: async () => undefined,
            pluginManager: {
                list: () => listPlugins({ home }),
                show: (name: string) => showPlugin(name, { home }),
                install: (request: { source: string; dry_run: boolean }) =>
                    installPlugin(request.source, { home, dry_run: request.dry_run }),
            },
        };
        expect(await runCli(["plugin", "install", source, "--dry-run"], dependencies)).toBe(0);
        expect(stdout.text).toContain("version:     -\n");

        stdout.text = "";
        expect(await runCli(["plugin", "install", source], dependencies)).toBe(0);
        expect(stdout.text).toContain("version:     -\n");

        stdout.text = "";
        expect(await runCli(["plugin", "list"], dependencies)).toBe(0);
        expect(stdout.text).toMatch(/^sample-plugin\s+-\s+enabled/m);

        stdout.text = "";
        expect(await runCli(["plugin", "show", "sample-plugin"], dependencies)).toBe(0);
        expect(stdout.text).toContain("version:     -\n");
        expect(signals).not.toHaveBeenCalled();
    } finally {
        signals.mockRestore();
        rmSync(root, { recursive: true, force: true });
    }
});

test("the /plugins operation path opens a dialog or a notice", () => {
    const { root, home } = temporaryHome();
    try {
        const source = pluginSource(root);
        const operations: PluginManagerOperations = {
            install: (request) => installPlugin(request.source, {
                home,
                dry_run: request.dry_run,
            }),
            list: () => listPlugins({ home }),
            show: () => {
                throw new Error("unused");
            },
            setEnabled: (name, enabled) => setPluginEnabled(name, enabled, { home }),
            remove: () => {
                throw new Error("unused");
            },
        };

        const preview = runPluginCommand(
            { operation: "install", source, dry_run: true },
            operations,
        );
        expect(preview.surface).toBe("dialog");
        expect(preview.text).toContain("Plugin install plan (dry run)");

        const install = runPluginCommand(
            { operation: "install", source, dry_run: false },
            operations,
        );
        expect(install.text).toContain("Installed sample-plugin.");
        expect(install.text).toContain(
            "A running session picks up the plugin's skills on its next turn.",
        );

        const listed = runPluginCommand({ operation: "list" }, operations);
        expect(listed.surface).toBe("dialog");
        expect(listed.text).toContain("Plugins");
        expect(listed.text).toContain("sample-plugin");

        const disabled = runPluginCommand(
            { operation: "disable", name: "sample-plugin" },
            operations,
        );
        expect(disabled.surface).toBe("notice");
        expect(disabled.text).toContain("Disabled sample-plugin.");
        expect(disabled.text).toContain(
            "A running session stops seeing the plugin's skills on its next turn.",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core plugin show and install preview report MCP servers and the off switch", async () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = pluginSource(root);
        writeFileSync(join(source, "mcp.json"), JSON.stringify({
            $schema: AGENT_MCP_SCHEMA,
            mcpServers: {
                local: { type: "stdio", command: "node", title: "Local" },
                sse: { type: "sse", url: "https://example.test/sse" },
            },
        }));
        mkdirSync(veraHome, { recursive: true });
        writeFileSync(join(veraHome, "config.json"), JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
            disabled_included_extensions: ["vera.mcp"],
        }));
        const stdout = outputSink();
        const stderr = outputSink();
        const dependencies = {
            stdout,
            stderr,
            dispatchToHostRelease: async () => undefined,
            pluginManager: {
                install: (request: { source: string; dry_run: boolean }) =>
                    installPlugin(request.source, {
                        home,
                        dry_run: request.dry_run,
                    }),
                show: (name: string) => showPlugin(name, { home }),
            },
        };
        expect(await runCli(["plugin", "install", source], dependencies)).toBe(0);
        expect(stdout.text).toContain("mcp servers: local (stdio)");
        expect(stdout.text).toContain(
            "mcp skipped: sse: sse transport is not supported",
        );
        expect(stdout.text).toContain(
            "MCP servers are off because vera.mcp is off",
        );

        stdout.text = "";
        expect(await runCli(["plugin", "show", "sample-plugin"], dependencies))
            .toBe(0);
        expect(stdout.text).toContain("mcp servers: local (stdio)");
        expect(stdout.text).toContain(
            'mcp note:    plugin sample-plugin: server local: '
                + 'unknown field "title" is ignored',
        );
        expect(stdout.text).toContain(
            "MCP servers are off because vera.mcp is off",
        );

        stdout.text = "";
        expect(await runCli(
            ["plugin", "install", source, "--dry-run"],
            dependencies,
        )).toBe(0);
        expect(stdout.text).toContain(
            "MCP servers are off because vera.mcp is off",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core plugin show and install preview identify a differently named host extension", async () => {
    const { root, home } = temporaryHome();
    try {
        const source = pluginSource(root);
        writeHostExtension(source, "crow_bridge");
        const stdout = outputSink();
        const dependencies = {
            stdout,
            stderr: outputSink(),
            dispatchToHostRelease: async () => undefined,
            pluginManager: {
                install: (request: { source: string; dry_run: boolean }) =>
                    installPlugin(request.source, { home, dry_run: request.dry_run }),
                show: (name: string) => showPlugin(name, { home }),
            },
        };

        expect(await runCli(["plugin", "install", source, "--dry-run"], dependencies)).toBe(0);
        expect(stdout.text).toContain("name:        sample-plugin");
        expect(stdout.text).toContain("host:        crow_bridge 1.0.0");

        stdout.text = "";
        expect(await runCli(["plugin", "install", source], dependencies)).toBe(0);
        expect(stdout.text).toContain("name:        sample-plugin");
        expect(stdout.text).toContain("host:        crow_bridge 1.0.0");

        stdout.text = "";
        expect(await runCli(["plugin", "show", "sample-plugin"], dependencies)).toBe(0);
        expect(stdout.text).toContain("Plugin sample-plugin");
        expect(stdout.text).toContain("host:        crow_bridge 1.0.0");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core plugin CLI reports a host extension ID conflict on install and preview", async () => {
    const { root, home } = temporaryHome();
    try {
        const source = pluginSource(root);
        writeHostExtension(source, "vera.mcp");
        const stdout = outputSink();
        const stderr = outputSink();
        const dependencies = {
            stdout,
            stderr,
            dispatchToHostRelease: async () => undefined,
            pluginManager: {
                install: (request: { source: string; dry_run: boolean }) =>
                    installPlugin(request.source, { home, dry_run: request.dry_run }),
            },
        };
        for (const args of [
            ["plugin", "install", source, "--dry-run"],
            ["plugin", "install", source],
        ]) {
            stderr.text = "";
            expect(await runCli(args, dependencies)).toBe(1);
            expect(stderr.text).toContain(
                "Host extension id vera.mcp is already used by an included extension.",
            );
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

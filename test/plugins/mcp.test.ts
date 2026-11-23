import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPluginPackage } from "../../src/plugins/manifest.ts";
import {
    mapPluginMcpServers,
    type PluginMcpMapping,
} from "../../src/plugins/mcp.ts";
import {
    AGENT_MCP_SCHEMA,
    AGENT_PLUGIN_SCHEMA,
} from "../../src/plugins/naming.ts";

const roots: string[] = [];

function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-mcp-"));
    roots.push(root);
    return root;
}

function cleanup(): void {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
}

function agentPackage(
    root: string,
    servers: Record<string, unknown>,
): string {
    const directory = join(root, "package");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "sample-plugin",
    }));
    writeFileSync(join(directory, "mcp.json"), JSON.stringify({
        $schema: AGENT_MCP_SCHEMA,
        mcpServers: servers,
    }));
    return directory;
}

function claudePackage(
    root: string,
    servers: Record<string, unknown>,
): string {
    const directory = join(root, "claude");
    mkdirSync(join(directory, ".claude-plugin"), { recursive: true });
    writeFileSync(
        join(directory, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "claude-plugin" }),
    );
    writeFileSync(
        join(directory, ".mcp.json"),
        JSON.stringify({ mcpServers: servers }),
    );
    return directory;
}

function codexPackage(
    root: string,
    servers: Record<string, unknown>,
): string {
    const directory = join(root, "codex");
    mkdirSync(join(directory, ".codex-plugin"), { recursive: true });
    writeFileSync(
        join(directory, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "codex-plugin" }),
    );
    writeFileSync(
        join(directory, ".mcp.json"),
        JSON.stringify({ mcpServers: servers }),
    );
    return directory;
}

function mapPackage(
    directory: string,
    root: string,
    createDataDirectory = false,
): PluginMcpMapping {
    const loaded = loadPluginPackage(directory);
    return mapPluginMcpServers({
        plugin: loaded.install_name,
        directory,
        dataDirectory: join(root, "home", "plugins", ".data", loaded.install_name),
        entries: loaded.components.mcp_servers,
        createDataDirectory,
    });
}

function reasons(mapping: PluginMcpMapping): Record<string, string> {
    return Object.fromEntries(
        mapping.skipped.map((skip) => [skip.name, skip.reason]),
    );
}

test("@core a plugin mcp.json maps stdio and http servers for the host", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(root, {
            local: {
                type: "stdio",
                command: "bun",
                args: ["${PLUGIN_ROOT}/server.ts", "--flag"],
                env: { TOKEN: "abc" },
                cwd: "${PLUGIN_ROOT}/work",
            },
            remote: {
                type: "http",
                url: "https://example.test/mcp",
                headers: { Authorization: "Bearer ${PLUGIN_ROOT}" },
            },
        });
        mkdirSync(join(directory, "work"));
        writeFileSync(join(directory, "server.ts"), "// server\n");
        const mapping = mapPackage(directory, root, true);
        expect(mapping.skipped).toEqual([]);
        expect(mapping.servers.map((server) => [
            server.name,
            server.transport,
        ])).toEqual([["local", "stdio"], ["remote", "http"]]);
        const local = mapping.servers[0]!.config;
        expect(local.command).toEqual([
            "bun",
            realpathSync(join(directory, "server.ts")),
            "--flag",
        ]);
        expect(local.cwd).toBe(realpathSync(join(directory, "work")));
        expect(local.env).toMatchObject({
            TOKEN: "abc",
            PLUGIN_ROOT: realpathSync(directory),
            PLUGIN_DATA: realpathSync(
                join(root, "home", "plugins", ".data", "sample-plugin"),
            ),
        });
        const remote = mapping.servers[1]!.config;
        expect(remote).toEqual({
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer ${PLUGIN_ROOT}" },
        });
    } finally {
        cleanup();
    }
});

test("@core claude and codex .mcp.json map through the same mapper", () => {
    const root = temporaryRoot();
    try {
        for (const build of [claudePackage, codexPackage]) {
            const directory = build(root, {
                docs: {
                    command: "node",
                    args: ["${PLUGIN_ROOT}/server.js"],
                },
            });
            writeFileSync(join(directory, "server.js"), "// server\n");
            const mapping = mapPackage(directory, root);
            expect(mapping.skipped).toEqual([]);
            expect(mapping.servers[0]).toMatchObject({
                transport: "stdio",
                name: "docs",
            });
            expect(mapping.servers[0]!.config.command).toEqual([
                "node",
                realpathSync(join(directory, "server.js")),
            ]);
        }
    } finally {
        cleanup();
    }
});

test("@core plugin MCP placeholders expand once in command, args, env and cwd", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(root, {
            local: {
                type: "stdio",
                command: "${PLUGIN_ROOT}/bin/server",
                args: ["--data", "${PLUGIN_DATA}/cache"],
                env: { CACHE: "${PLUGIN_DATA}/cache" },
                cwd: "${PLUGIN_DATA}",
            },
        });
        mkdirSync(join(directory, "bin"), { recursive: true });
        writeFileSync(join(directory, "bin", "server"), "// server\n");
        const mapping = mapPackage(directory, root, true);
        expect(mapping.skipped).toEqual([]);
        const data = realpathSync(
            join(root, "home", "plugins", ".data", "sample-plugin"),
        );
        expect(mapping.servers[0]!.config).toMatchObject({
            command: [
                realpathSync(join(directory, "bin", "server")),
                "--data",
                `${data}/cache`,
            ],
            env: { CACHE: `${data}/cache`, PLUGIN_DATA: data },
            cwd: data,
        });
    } finally {
        cleanup();
    }
});

test("plugin MCP env cannot override PLUGIN_ROOT or PLUGIN_DATA", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(root, {
            bad: {
                type: "stdio",
                command: "node",
                env: { PLUGIN_ROOT: "/tmp" },
            },
            good: { type: "stdio", command: "node" },
        });
        const mapping = mapPackage(directory, root);
        expect(reasons(mapping)).toEqual({
            bad: "env cannot override PLUGIN_ROOT",
        });
        expect(mapping.servers.map((server) => server.name)).toEqual(["good"]);
    } finally {
        cleanup();
    }
});

test("@core plugin MCP commands and cwd stay inside the plugin", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(root, {
            escape: { type: "stdio", command: "../escape.sh" },
            absolute: { type: "stdio", command: "/bin/sh" },
            linked: { type: "stdio", command: "${PLUGIN_ROOT}/tool" },
            wandering: {
                type: "stdio",
                command: "node",
                cwd: "${PLUGIN_ROOT}/../outside",
            },
            dataEscape: {
                type: "stdio",
                command: "node",
                cwd: "${PLUGIN_DATA}/../outside",
            },
            dotted: {
                type: "stdio",
                command: "${PLUGIN_ROOT}/..foo/tool.sh",
            },
        });
        writeFileSync(join(root, "escape.sh"), "#!/bin/sh\n");
        mkdirSync(join(root, "outside"));
        mkdirSync(join(directory, "..foo"));
        writeFileSync(join(directory, "..foo", "tool.sh"), "#!/bin/sh\n");
        writeFileSync(join(directory, "real-tool"), "#!/bin/sh\n");
        symlinkSync("real-tool", join(directory, "tool"));
        const mapping = mapPackage(directory, root, true);
        const byName = reasons(mapping);
        expect(byName.escape).toContain("outside the plugin");
        expect(byName.absolute).toContain("outside the plugin");
        expect(byName.linked).toContain("is a symlink");
        expect(byName.wandering).toContain("outside the plugin");
        expect(byName.dataEscape).toContain("outside the plugin");
        expect(byName.dotted).toBeUndefined();
        expect(mapping.servers.map((server) => server.name)).toEqual(["dotted"]);
        const command = mapping.servers[0]!.config.command as string[];
        expect(command[0])
            .toBe(realpathSync(join(directory, "..foo", "tool.sh")));
    } finally {
        cleanup();
    }
});

test("a bare plugin MCP program name is left for PATH", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(root, {
            node: { type: "stdio", command: "npx", args: ["--version"] },
        });
        const mapping = mapPackage(directory, root);
        expect(mapping.skipped).toEqual([]);
        expect(mapping.servers[0]!.config.command)
            .toEqual(["npx", "--version"]);
    } finally {
        cleanup();
    }
});

test("@core plugin MCP http needs https unless the host is loopback", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(root, {
            loopback: { type: "http", url: "http://127.0.0.1:3000/mcp" },
            localhost: { type: "http", url: "http://localhost:3000/mcp" },
            ipv6: { type: "http", url: "http://[::1]:3000/mcp" },
            remote: { type: "http", url: "http://example.test/mcp" },
            localhostEvil: { type: "http", url: "http://localhost.evil.test/mcp" },
            userinfo: { type: "http", url: "http://127.0.0.1:3000@evil.test/mcp" },
            addressEvil: { type: "http", url: "http://127.0.0.1.evil.test/mcp" },
            shorthandEvil: { type: "http", url: "http://127.evil.test/mcp" },
            dot: { type: "http", url: "http://localhost.:3000/mcp" },
            any: { type: "http", url: "http://0.0.0.0:3000/mcp" },
            mapped: { type: "http", url: "http://[::ffff:127.0.0.1]:3000/mcp" },
            secure: { type: "http", url: "https://example.test/mcp" },
        });
        const mapping = mapPackage(directory, root);
        expect(Object.keys(reasons(mapping)).sort()).toEqual([
            "addressEvil",
            "any",
            "dot",
            "localhostEvil",
            "mapped",
            "remote",
            "shorthandEvil",
            "userinfo",
        ]);
        expect(mapping.servers.map((server) => server.name))
            .toEqual(["ipv6", "localhost", "loopback", "secure"]);
    } finally {
        cleanup();
    }
});

test("plugin MCP sse and OAuth servers are skipped with a reason", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(root, {
            sse: { type: "sse", url: "https://example.test/sse" },
            auth: {
                type: "http",
                url: "https://example.test/mcp",
                auth: "oauth",
            },
            oauth: {
                type: "http",
                url: "https://example.test/mcp",
                oauth: {},
            },
            client: {
                type: "http",
                url: "https://example.test/mcp",
                clientId: "abc",
            },
        });
        const mapping = mapPackage(directory, root);
        expect(reasons(mapping)).toEqual({
            sse: "sse transport is not supported",
            auth: "OAuth is not supported for plugin MCP servers",
            oauth: "OAuth is not supported for plugin MCP servers",
            client: "OAuth is not supported for plugin MCP servers",
        });
        expect(mapping.servers).toEqual([]);
    } finally {
        cleanup();
    }
});

test("plugin MCP headers stay literal", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(root, {
            remote: {
                type: "http",
                url: "https://example.test/mcp",
                headers: {
                    Authorization: "Bearer token-abc",
                    "X-Data": "${PLUGIN_DATA}",
                },
            },
        });
        const mapping = mapPackage(directory, root);
        expect(mapping.servers[0]!.config.headers).toEqual({
            Authorization: "Bearer token-abc",
            "X-Data": "${PLUGIN_DATA}",
        });
    } finally {
        cleanup();
    }
});

test("@core plugin MCP {env:} references skip the server before the host expands them", () => {
    const root = temporaryRoot();
    const previous = process.env.SECRET_TOKEN;
    process.env.SECRET_TOKEN = "leaked-value";
    try {
        const directory = agentPackage(root, {
            header: {
                type: "http",
                url: "https://example.test/mcp",
                headers: { Authorization: "Bearer {env:SECRET_TOKEN}" },
            },
            unset: {
                type: "stdio",
                command: "node",
                env: { TOKEN: "{env:NOT_SET_ANYWHERE}" },
            },
            argument: {
                type: "stdio",
                command: "node",
                args: ["--token", "{env:SECRET_TOKEN}"],
            },
            program: { type: "stdio", command: "{env:SECRET_TOKEN}" },
            nested: {
                type: "http",
                url: "https://example.test/mcp",
                headers: { "X-Wrap": ["fine", "{env:SECRET_TOKEN}"] },
            },
            good: { type: "stdio", command: "node" },
        });
        const mapping = mapPackage(directory, root);
        expect(reasons(mapping)).toEqual({
            header: "{env:...} is not supported in headers.Authorization "
                + "for plugin MCP servers",
            unset: "{env:...} is not supported in env.TOKEN "
                + "for plugin MCP servers",
            argument: "{env:...} is not supported in args[1] "
                + "for plugin MCP servers",
            program: "{env:...} is not supported in command "
                + "for plugin MCP servers",
            nested: "{env:...} is not supported in headers.X-Wrap[1] "
                + "for plugin MCP servers",
        });
        expect(mapping.servers.map((server) => server.name)).toEqual(["good"]);
        expect(JSON.stringify(mapping)).not.toContain("leaked-value");
    } finally {
        if (previous === undefined) delete process.env.SECRET_TOKEN;
        else process.env.SECRET_TOKEN = previous;
        cleanup();
    }
});

test("a plugin MCP server name that would change the object shape is refused", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(
            root,
            JSON.parse('{"__proto__":{"type":"stdio","command":"node"},'
                + '"constructor":{"type":"stdio","command":"node"},'
                + '"prototype":{"type":"stdio","command":"node"},'
                + '"good":{"type":"stdio","command":"node"}}'),
        );
        const mapping = mapPackage(directory, root);
        expect(reasons(mapping)).toEqual(Object.fromEntries([
            ["__proto__", 'server name "__proto__" is reserved'],
            ["constructor", 'server name "constructor" is reserved'],
            ["prototype", 'server name "prototype" is reserved'],
        ]));
        expect(mapping.servers.map((server) => server.name)).toEqual(["good"]);
    } finally {
        cleanup();
    }
});

test("unknown plugin MCP fields are reported, not fatal", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(root, {
            echo: { type: "stdio", command: "node", title: "Echo" },
        });
        const mapping = mapPackage(directory, root);
        expect(mapping.skipped).toEqual([]);
        expect(mapping.notes).toContain(
            'plugin sample-plugin: server echo: unknown field "title" is ignored',
        );
    } finally {
        cleanup();
    }
});

test("a bad plugin MCP server is skipped and the rest load", () => {
    const root = temporaryRoot();
    try {
        const directory = agentPackage(root, {
            bad: { type: "stdio", args: ["--version"] },
            disabled: { type: "stdio", command: "node", enabled: false },
            good: { type: "stdio", command: "node" },
        });
        const mapping = mapPackage(directory, root);
        expect(reasons(mapping)).toEqual({
            bad: "command must be a string or a non-empty string array",
            disabled: "disabled",
        });
        expect(mapping.servers.map((server) => server.name)).toEqual(["good"]);
    } finally {
        cleanup();
    }
});

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { VeraConfig, VeraExtensionConfig } from "../../src/config.ts";
import {
    hostExtensionConfigSet,
    hostExtensionConfigs,
    workerExtensionConfigs,
} from "../../src/extensions/host-set.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import type { PluginMcpServer } from "../../src/plugins/mcp.ts";
import { emptyPluginSnapshot, type PluginSnapshot } from "../../src/plugins/catalog.ts";

const MCP_DIRECTORY = fileURLToPath(
    new URL("../../extensions/mcp", import.meta.url),
);

function server(
    plugin: string,
    name: string,
    command = "node",
): PluginMcpServer {
    return {
        plugin,
        name,
        transport: "stdio",
        config: { command: [command] },
    };
}

function snapshot(...servers: PluginMcpServer[]): PluginSnapshot {
    return {
        ...emptyPluginSnapshot(),
        mcp_servers: servers,
    };
}

function homeConfig(
    servers: Record<string, unknown> = {},
    disabled: readonly string[] = [],
): Pick<VeraConfig, "disabled_included_extensions" | "extensions"> {
    return {
        disabled_included_extensions: disabled,
        extensions: [{
            path: MCP_DIRECTORY,
            enabled: true,
            config: { servers } as VeraExtensionConfig["config"],
        }],
    };
}

function extensionIds(
    configs: readonly VeraExtensionConfig[],
): readonly string[] {
    return configs.map((entry) =>
        loadExtensionManifest(entry.path).manifest.id
    );
}

function mcpServers(
    configs: readonly VeraExtensionConfig[],
): unknown {
    const entry = configs.find((candidate) =>
        loadExtensionManifest(candidate.path).manifest.id === "vera.mcp"
    );
    expect(entry).toBeDefined();
    return (entry!.config as { servers?: unknown }).servers;
}

test("@core the host composes plugin MCP servers after the home config", () => {
    const set = hostExtensionConfigSet(
        homeConfig({ shared: { command: ["home"] } }),
        snapshot(server("alpha", "shared", "alpha"), server("alpha", "only")),
    );
    expect(set.warnings).toEqual([
        "MCP server shared from plugin alpha was skipped: "
            + "the home config already defines it",
    ]);
    expect(mcpServers(hostExtensionConfigs(
        homeConfig({ shared: { command: ["home"] } }),
        snapshot(server("alpha", "shared", "alpha"), server("alpha", "only")),
    ))).toEqual({
        shared: { command: ["home"] },
        only: { command: ["node"] },
    });
});

test("@core the first plugin in name order wins an MCP server key", () => {
    const set = hostExtensionConfigSet(
        homeConfig(),
        snapshot(
            server("alpha", "shared", "alpha"),
            server("beta", "shared", "beta"),
            server("beta", "only-beta"),
        ),
    );
    expect(set.warnings).toEqual([
        "MCP server shared from plugin beta was skipped: "
            + "plugin alpha already defines it",
    ]);
    expect(mcpServers(set.extensions)).toEqual({
        shared: { command: ["alpha"] },
        "only-beta": { command: ["node"] },
    });
});

test("vera.mcp off leaves plugin MCP servers out of the host set", () => {
    const config = {
        disabled_included_extensions: ["vera.mcp"],
        extensions: [],
    };
    const set = hostExtensionConfigSet(config, snapshot(server("alpha", "only")));
    expect(set.warnings).toEqual([]);
    expect(extensionIds(set.extensions)).not.toContain("vera.mcp");
    expect(extensionIds(workerExtensionConfigs(
        config,
        snapshot(server("alpha", "only")),
    ))).not.toContain("vera.mcp");
});

test("a plugin server name from Object.prototype is refused, not assigned", () => {
    const config = homeConfig({ home: { command: ["home"] } });
    const set = hostExtensionConfigSet(
        config,
        snapshot(server("alpha", "__proto__"), server("alpha", "constructor")),
    );
    expect(set.warnings).toEqual([
        "MCP server __proto__ from plugin alpha was skipped: the name is reserved",
        "MCP server constructor from plugin alpha was skipped: the name is reserved",
    ]);
    const servers = mcpServers(set.extensions) as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["home"]);
    expect(Object.getPrototypeOf(servers)).toBe(Object.prototype);
});

test("a malformed vera.mcp config is reported and left alone", () => {
    const config = {
        disabled_included_extensions: [],
        extensions: [{
            path: MCP_DIRECTORY,
            enabled: true,
            config: { servers: [] } as VeraExtensionConfig["config"],
        }],
    };
    const set = hostExtensionConfigSet(config, snapshot(server("alpha", "only")));
    expect(set.warnings).toEqual([
        "vera.mcp config `servers` is not an object; "
            + "plugin MCP servers were not added",
    ]);
    expect(mcpServers(set.extensions)).toEqual([]);
});

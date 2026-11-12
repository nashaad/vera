import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
    McpConfigError,
    parseMcpConfig,
} from "../../extensions/mcp/config.ts";
import {
    bridgedCommandName,
    bridgedName,
    bridgedToolNames,
    promptArguments,
} from "../../extensions/mcp/extension.ts";
import { contentText, McpServerClient } from "../../extensions/mcp/client.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { executeToolHandler } from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import {
    decideToolPermission,
} from "../../src/engine/permissions.ts";

const FIXTURE_SERVER = fileURLToPath(
    new URL("./fixtures/mcp-stdio-server.ts", import.meta.url),
);
const TOOL_NAMES_SERVER = fileURLToPath(
    new URL("./fixtures/mcp-tool-names-server.ts", import.meta.url),
);
const EXTENSION_DIRECTORY = fileURLToPath(
    new URL("../../extensions/mcp", import.meta.url),
);

const fixtureConfig = {
    servers: {
        fixture: { command: ["bun", FIXTURE_SERVER] },
    },
};

test("parseMcpConfig accepts stdio and http servers and drops disabled ones", () => {
    const servers = parseMcpConfig({
        servers: {
            local: { command: ["bun", "server.ts"], env: { KEY: "v" } },
            remote: { url: "https://example.test/mcp", headers: { a: "b" } },
            off: { command: ["x"], enabled: false },
        },
    });
    expect(servers.map((server) => server.name)).toEqual(["local", "remote"]);
    expect(servers[0]).toMatchObject({ kind: "stdio", env: { KEY: "v" } });
    expect(servers[1]).toMatchObject({ kind: "http", url: "https://example.test/mcp" });
});

test("parseMcpConfig rejects ambiguous and malformed servers", () => {
    expect(() => parseMcpConfig({ servers: { a: {} } }))
        .toThrow(McpConfigError);
    expect(() => parseMcpConfig({
        servers: { a: { command: ["x"], url: "https://x" } },
    })).toThrow(McpConfigError);
    expect(() => parseMcpConfig({ servers: { "Bad Name": { command: ["x"] } } }))
        .toThrow(McpConfigError);
    expect(parseMcpConfig(undefined)).toEqual([]);
    expect(parseMcpConfig({})).toEqual([]);
});

test("bridgedName prefixes, flattens, lowercases, and caps", () => {
    expect(bridgedCommandName("linear_app", "Summarize.PR"))
        .toBe("mcp-linear-app-summarize-pr");
    expect(bridgedName("github", "search_issues"))
        .toBe("mcp_github_search_issues");
    expect(bridgedName("linear-app", "list.my/issues"))
        .toBe("mcp_linear_app_list_my_issues");
    expect(bridgedName("parrot", "GetParrot"))
        .toBe("mcp_parrot_getparrot");
    expect(bridgedName("s", "x".repeat(100)).length).toBe(64);
});

test("bridgedToolNames suffixes names that bridge alike", () => {
    expect(bridgedToolNames("parrot", ["GetParrot", "getparrot", "Perch"]))
        .toEqual([
            { remote: "GetParrot", name: "mcp_parrot_getparrot" },
            {
                remote: "getparrot",
                name: "mcp_parrot_getparrot_2",
                collisionName: "mcp_parrot_getparrot",
                collidedWith: "GetParrot",
            },
            { remote: "Perch", name: "mcp_parrot_perch" },
        ]);
    expect(bridgedToolNames("s", ["x".repeat(100), "X".repeat(100)]).at(1))
        .toMatchObject({ name: `${`mcp_s_${"x".repeat(100)}`.slice(0, 62)}_2` });
});

test("promptArguments maps positionally and the last argument takes the rest", () => {
    expect(promptArguments(["name"], "Ada Lovelace"))
        .toEqual({ name: "Ada Lovelace" });
    expect(promptArguments(["id", "note"], "42 fix the flaky test"))
        .toEqual({ id: "42", note: "fix the flaky test" });
    expect(promptArguments(["a", "b"], "only"))
        .toEqual({ a: "only" });
    expect(promptArguments([], "anything")).toEqual({});
});

test("contentText flattens text, placeholders, and embedded resources", () => {
    expect(contentText([
        { type: "text", text: "one" },
        { type: "image", mimeType: "image/png" },
        { type: "resource", resource: { text: "two" } },
        { type: "resource_link", uri: "file://x" },
    ])).toBe("one\n\n[image image/png]\n\ntwo\n\n[resource file://x]");
});

test("client connects to a real stdio server, lists, calls, and reconnects", async () => {
    const client = new McpServerClient({
        kind: "stdio",
        name: "fixture",
        command: ["bun", FIXTURE_SERVER],
        env: {},
    });
    await client.connect();
    expect(client.tools.map((tool) => tool.name)).toEqual(["echo", "die"]);
    expect(client.tools[0]?.readOnly).toBe(true);
    expect(client.prompts.map((prompt) => prompt.name)).toEqual(["greet"]);

    const signal = new AbortController().signal;
    const echoed = await client.callTool("echo", { text: "hi" }, signal);
    expect(echoed).toEqual({ text: "echo: hi", isError: false });

    expect(await client.getPrompt("greet", { name: "Nash" }))
        .toBe("Hello, Nash!");
    expect(await client.readResource("mem://a", signal))
        .toBe("resource body for mem://a");

    // Killing the server exercises the one-reconnect-per-call path.
    await client.callTool("die", {}, signal).catch(() => {});
    const revived = await client.callTool("echo", { text: "back" }, signal);
    expect(revived.text).toBe("echo: back");
    client.close();
});

test("registry loads a server with an uppercase tool name", async () => {
    const registry = await startExtensionRegistry({
        extensions: [{
            path: EXTENSION_DIRECTORY,
            enabled: true,
            config: {
                servers: {
                    parrot: { command: ["bun", TOOL_NAMES_SERVER] },
                },
            },
        }],
        onFailure: (failure) => {
            throw new Error(failure.message);
        },
    });
    try {
        const tools = registry.tools();
        expect(tools.map((tool) => tool.definition.name)).toEqual([
            "mcp_parrot_perch",
            "mcp_parrot_getparrot",
            "mcp_resource",
        ]);
        await expect(executeToolHandler(
            {
                type: "tool_call",
                id: "call-1",
                name: "mcp_parrot_getparrot",
                input: {},
            },
            new ToolRuntime(process.cwd()),
            new AbortController().signal,
            tools,
        )).resolves.toMatchObject({
            kind: "output",
            output: "pieces of eight",
            isError: false,
        });
    } finally {
        await registry.close();
    }
});

test("a tool the registry refuses is skipped and the rest of the server loads", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
    };
    let registry: Awaited<ReturnType<typeof startExtensionRegistry>> | undefined;
    try {
        registry = await startExtensionRegistry({
            extensions: [{
                path: EXTENSION_DIRECTORY,
                enabled: true,
                config: {
                    servers: {
                        parrot: {
                            command: ["bun", TOOL_NAMES_SERVER],
                            env: { MCP_FIXTURE_BAD_SCHEMA: "1" },
                        },
                    },
                },
            }],
            onFailure: (failure) => {
                throw new Error(failure.message);
            },
        });
        expect(registry.tools().map((tool) => tool.definition.name)).toEqual([
            "mcp_parrot_perch",
            "mcp_parrot_getparrot",
            "mcp_resource",
        ]);
        expect(logged).toContain(
            "[vera.mcp] server parrot: tool broken was skipped: "
            + "Invalid extension tool registration",
        );
    } finally {
        console.error = original;
        await registry?.close();
    }
});

test("registry activates the bridge and the model-facing tool round-trips", async () => {
    const registry = await startExtensionRegistry({
        extensions: [{
            path: EXTENSION_DIRECTORY,
            enabled: true,
            config: fixtureConfig,
        }],
        onFailure: (failure) => {
            throw new Error(failure.message);
        },
    });
    try {
        const tools = registry.tools();
        expect(tools.map((tool) => tool.definition.name)).toEqual([
            "mcp_fixture_echo",
            "mcp_fixture_die",
            "mcp_resource",
        ]);
        expect(registry.commands().map((command) => command.name))
            .toEqual(["mcp-fixture-greet"]);

        expect(decideToolPermission(
            "ask",
            {
                id: "call-1",
                name: "mcp_fixture_echo",
                input: { text: "dag" },
            },
            process.cwd(),
            [],
            { extensionTools: tools },
        )).toMatchObject({
            behavior: "ask",
            actions: [{ action: { operation: "mcp.fixture" } }],
        });

        await expect(executeToolHandler(
            {
                type: "tool_call",
                id: "call-1",
                name: "mcp_fixture_echo",
                input: { text: "dag" },
            },
            new ToolRuntime(process.cwd()),
            new AbortController().signal,
            tools,
        )).resolves.toMatchObject({
            kind: "output",
            output: "echo: dag",
            isError: false,
        });

        const prompt = await registry.invokeCommand(
            "mcp-fixture-greet",
            "Nash",
            process.cwd(),
        );
        expect(prompt.body).toEqual({ kind: "text", text: "Hello, Nash!" });
    } finally {
        await registry.close();
    }
});

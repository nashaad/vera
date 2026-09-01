import { McpServerClient } from "./client.ts";
import { parseMcpConfig, type McpServerConfig } from "./config.ts";
import { freshAccessToken, loginServer, TokenStore } from "./oauth.ts";

const CONNECT_TIMEOUT_MS = 3_500;

interface VeraExtensionApiShape {
    readonly config: unknown;
    readonly storage: { readonly profile: string; readonly machine: string };
    readonly tools: {
        register(spec: Record<string, unknown>): void;
    };
    readonly commands: {
        register(spec: Record<string, unknown>): void;
    };
    onDispose(dispose: () => void): void;
}

export async function activate(vera: VeraExtensionApiShape): Promise<void> {
    const servers = parseMcpConfig(vera.config);
    if (servers.length === 0) {
        return;
    }
    const store = new TokenStore(vera.storage.machine);
    const oauthServers = servers.filter(
        (server) => server.kind === "http" && server.auth === "oauth",
    );
    if (oauthServers.length > 0) {
        registerLoginCommand(vera, oauthServers, store);
    }

    const clients = await Promise.all(servers.map(async (config) => {
        const authorized = await withStoredToken(config, store);
        if (authorized === undefined) {
            console.error(
                `[vera.mcp] server ${config.name} has no login yet; `
                + `run /mcp-login ${config.name}, then restart the host`,
            );
            return undefined;
        }
        const client = new McpServerClient(authorized);
        try {
            await withTimeout(
                client.connect(),
                CONNECT_TIMEOUT_MS,
                `mcp server ${config.name} did not finish initializing`,
            );
            return client;
        } catch (error) {
            client.close();
            console.error(
                `[vera.mcp] skipping server ${config.name}: ${message(error)}`,
            );
            return undefined;
        }
    }));
    const connected = clients.filter(
        (client): client is McpServerClient => client !== undefined,
    );
    if (connected.length === 0) {
        return;
    }
    vera.onDispose(() => {
        for (const client of connected) {
            client.close();
        }
    });

    for (const client of connected) {
        registerTools(vera, client);
        registerPrompts(vera, client);
    }
    registerResourceTool(vera, connected);
}

async function withStoredToken(
    config: McpServerConfig,
    store: TokenStore,
): Promise<McpServerConfig | undefined> {
    if (config.kind !== "http" || config.auth !== "oauth") {
        return config;
    }
    const accessToken = await freshAccessToken(store, config.name);
    if (accessToken === undefined) {
        return undefined;
    }
    return {
        ...config,
        headers: { ...config.headers, authorization: `Bearer ${accessToken}` },
    };
}

function registerLoginCommand(
    vera: VeraExtensionApiShape,
    oauthServers: readonly McpServerConfig[],
    store: TokenStore,
): void {
    const byName = new Map(oauthServers.map((server) => [server.name, server]));
    const names = [...byName.keys()].join(", ");
    vera.commands.register({
        name: "mcp-login",
        description: `Log in to an OAuth MCP server (${names}).`,
        usage: "/mcp-login <server>",
        run(request: { argumentsText: string }) {
            const name = request.argumentsText.trim();
            const server = byName.get(name);
            if (server === undefined || server.kind !== "http") {
                return {
                    kind: "text",
                    text: name.length === 0
                        ? `OAuth MCP servers: ${names}. Usage: /mcp-login <server>`
                        : `No OAuth MCP server named ${name}. Configured: ${names}`,
                };
            }
            void loginServer({
                serverName: server.name,
                serverUrl: server.url,
                store,
                ...(server.clientId === undefined
                    ? {}
                    : { clientId: server.clientId }),
            }).then(
                () => console.error(
                    `[vera.mcp] login for ${server.name} complete; `
                    + "restart the host to load its tools",
                ),
                (error) => console.error(
                    `[vera.mcp] login for ${server.name} failed: `
                    + message(error),
                ),
            );
            return {
                kind: "text",
                text: `Opening the browser to log in to ${server.name}. `
                    + "Finish there; tools load on the next host start.",
            };
        },
    });
}

function registerTools(
    vera: VeraExtensionApiShape,
    client: McpServerClient,
): void {
    for (const tool of client.tools) {
        vera.tools.register({
            name: bridgedName(client.name, tool.name),
            description: tool.description.length > 0
                ? `${tool.description} (MCP server: ${client.name})`
                : `MCP tool ${tool.name} on server ${client.name}.`,
            inputSchema: tool.inputSchema,
            parallel: tool.readOnly,
            permissionOperation: `mcp.${client.name}`,
            async run(request: {
                input: Readonly<Record<string, unknown>>;
                signal: AbortSignal;
            }) {
                const result = await client.callTool(
                    tool.name,
                    request.input,
                    request.signal,
                );
                return {
                    output: result.text.length > 0
                        ? result.text
                        : "(empty result)",
                    ...(result.isError ? { isError: true } : {}),
                };
            },
        });
    }
}

function registerPrompts(
    vera: VeraExtensionApiShape,
    client: McpServerClient,
): void {
    for (const prompt of client.prompts) {
        const argumentNames = prompt.arguments.map((argument) =>
            argument.required ? `<${argument.name}>` : `[${argument.name}]`);
        const commandName = bridgedCommandName(client.name, prompt.name);
        vera.commands.register({
            name: commandName,
            description: prompt.description.length > 0
                ? prompt.description
                : `MCP prompt ${prompt.name} on server ${client.name}`,
            usage: [`/${commandName}`, ...argumentNames].join(" "),
            async run(request: { argumentsText: string; signal: AbortSignal }) {
                const args = promptArguments(
                    prompt.arguments.map((argument) => argument.name),
                    request.argumentsText,
                );
                const text = await client.getPrompt(
                    prompt.name,
                    args,
                    request.signal,
                );
                return {
                    kind: "text",
                    text: text.length > 0 ? text : "(empty prompt)",
                };
            },
        });
    }
}

function registerResourceTool(
    vera: VeraExtensionApiShape,
    clients: readonly McpServerClient[],
): void {
    const byName = new Map(clients.map((client) => [client.name, client]));
    vera.tools.register({
        name: "mcp_resource",
        description:
            "Read a resource from a connected MCP server by URI. Servers: "
            + clients.map((client) => client.name).join(", ") + ".",
        inputSchema: {
            type: "object",
            properties: {
                server: {
                    type: "string",
                    description: "Name of the configured MCP server.",
                },
                uri: {
                    type: "string",
                    description: "Resource URI as the server exposes it.",
                },
            },
            required: ["server", "uri"],
            additionalProperties: false,
        },
        parallel: true,
        permissionOperation: "mcp.resource",
        async run(request: {
            input: Readonly<Record<string, unknown>>;
            signal: AbortSignal;
        }) {
            const server = request.input.server;
            const uri = request.input.uri;
            if (typeof server !== "string" || typeof uri !== "string") {
                throw new Error("mcp_resource requires server and uri strings");
            }
            const client = byName.get(server);
            if (client === undefined) {
                throw new Error(
                    `No connected MCP server named ${server}. Connected: `
                    + [...byName.keys()].join(", "),
                );
            }
            const text = await client.readResource(uri, request.signal);
            return { output: text.length > 0 ? text : "(empty resource)" };
        },
    });
}

export function bridgedName(server: string, remoteName: string): string {
    const safe = remoteName.replaceAll(/[^a-zA-Z0-9_]+/g, "_");
    return `mcp_${server.replaceAll("-", "_")}_${safe}`.slice(0, 64);
}

export function bridgedCommandName(server: string, remoteName: string): string {
    const safe = remoteName.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-");
    return `mcp-${server.replaceAll("_", "-")}-${safe}`.slice(0, 64);
}

export function promptArguments(
    names: readonly string[],
    argumentsText: string,
): Readonly<Record<string, string>> {
    const text = argumentsText.trim();
    if (names.length === 0 || text.length === 0) {
        return {};
    }
    const words = text.split(/\s+/);
    const args: Record<string, string> = {};
    for (const [index, name] of names.entries()) {
        if (index >= words.length) {
            break;
        }
        args[name] = index === names.length - 1
            ? words.slice(index).join(" ")
            : words[index]!;
    }
    return args;
}

function withTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
        work.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

import { McpServerClient } from "./client.ts";
import { parseMcpConfig } from "./config.ts";

// The registry gives the whole activation 5 seconds by default, so each
// server gets a slightly smaller budget and they all connect in parallel.
// A server that cannot answer in time is skipped, not fatal.
const CONNECT_TIMEOUT_MS = 3_500;

interface VeraExtensionApiShape {
    readonly config: unknown;
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

    const clients = await Promise.all(servers.map(async (config) => {
        const client = new McpServerClient(config);
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

/**
 * `mcp_<server>_<remote name>`, with characters no provider accepts in a
 * tool name flattened to underscores and the whole name capped at 64.
 */
export function bridgedName(server: string, remoteName: string): string {
    const safe = remoteName.replaceAll(/[^a-zA-Z0-9_]+/g, "_");
    return `mcp_${server.replaceAll("-", "_")}_${safe}`.slice(0, 64);
}

/**
 * Command names allow only lowercase letters, digits, and hyphens, so prompt
 * commands take the hyphen spelling of the same `mcp` prefix convention.
 */
export function bridgedCommandName(server: string, remoteName: string): string {
    const safe = remoteName.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-");
    return `mcp-${server.replaceAll("_", "-")}-${safe}`.slice(0, 64);
}

/**
 * Positional mapping of the command's argument text onto the prompt's
 * declared arguments; the final argument absorbs the rest of the line so a
 * free-text last parameter needs no quoting.
 */
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

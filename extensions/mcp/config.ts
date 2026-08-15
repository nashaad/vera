// A server name becomes part of every registered tool and command name, so it
// is restricted to characters every model provider accepts in a tool name.
const SERVER_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

export interface StdioServerConfig {
    readonly kind: "stdio";
    readonly name: string;
    readonly command: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly cwd?: string;
}

export interface HttpServerConfig {
    readonly kind: "http";
    readonly name: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export class McpConfigError extends Error {}

/**
 * Parses the extension config: `{ servers: { <name>: <server> } }` where a
 * server is either `{ command: [...], env?, cwd?, enabled? }` for stdio or
 * `{ url, headers?, enabled? }` for HTTP with static headers. A server that
 * declares both `command` and `url`, or neither, is a config error rather
 * than a guess. Disabled servers are dropped here so the rest of the
 * extension never sees them.
 */
export function parseMcpConfig(value: unknown): readonly McpServerConfig[] {
    if (value === null || value === undefined) {
        return [];
    }
    if (!isPlainObject(value)) {
        throw new McpConfigError("mcp config must be an object");
    }
    const servers = value.servers;
    if (servers === undefined) {
        return [];
    }
    if (!isPlainObject(servers)) {
        throw new McpConfigError("mcp config `servers` must be an object");
    }
    const parsed: McpServerConfig[] = [];
    for (const [name, entry] of Object.entries(servers)) {
        if (!SERVER_NAME_PATTERN.test(name)) {
            throw new McpConfigError(
                `mcp server name ${JSON.stringify(name)} must match ${SERVER_NAME_PATTERN}`,
            );
        }
        const server = parseServer(name, entry);
        if (server !== undefined) {
            parsed.push(server);
        }
    }
    return parsed;
}

function parseServer(
    name: string,
    value: unknown,
): McpServerConfig | undefined {
    if (!isPlainObject(value)) {
        throw new McpConfigError(`mcp server ${name} must be an object`);
    }
    if (value.enabled === false) {
        return undefined;
    }
    if (value.enabled !== undefined && value.enabled !== true) {
        throw new McpConfigError(`mcp server ${name}: enabled must be a boolean`);
    }
    const hasCommand = value.command !== undefined;
    const hasUrl = value.url !== undefined;
    if (hasCommand === hasUrl) {
        throw new McpConfigError(
            `mcp server ${name} must declare exactly one of command or url`,
        );
    }
    if (hasCommand) {
        if (
            !Array.isArray(value.command)
            || value.command.length === 0
            || !value.command.every((part) =>
                typeof part === "string" && part.length > 0)
        ) {
            throw new McpConfigError(
                `mcp server ${name}: command must be a non-empty string array`,
            );
        }
        if (value.cwd !== undefined && typeof value.cwd !== "string") {
            throw new McpConfigError(`mcp server ${name}: cwd must be a string`);
        }
        return {
            kind: "stdio",
            name,
            command: value.command,
            env: stringRecord(name, "env", value.env),
            ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
        };
    }
    if (typeof value.url !== "string" || !/^https?:\/\//.test(value.url)) {
        throw new McpConfigError(
            `mcp server ${name}: url must be an http(s) URL`,
        );
    }
    return {
        kind: "http",
        name,
        url: value.url,
        headers: stringRecord(name, "headers", value.headers),
    };
}

function stringRecord(
    server: string,
    field: string,
    value: unknown,
): Readonly<Record<string, string>> {
    if (value === undefined) {
        return {};
    }
    if (
        !isPlainObject(value)
        || !Object.values(value).every((entry) => typeof entry === "string")
    ) {
        throw new McpConfigError(
            `mcp server ${server}: ${field} must map strings to strings`,
        );
    }
    return value as Record<string, string>;
}

function isPlainObject(
    value: unknown,
): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseMcpConfig } from "../../extensions/mcp/config.ts";
import { AGENT_MCP_SCHEMA, PLUGIN_MCP_MAX_BYTES } from "./naming.ts";
import {
    errorMessage,
    isFile,
    isPlainObject,
    readJsonObject,
} from "./package-files.ts";

/** A server as the package declares it, before Vera maps it. */
export interface PluginMcpServerSource {
    readonly name: string;
    readonly transport: "stdio" | "http" | "unsupported";
    readonly source: Readonly<Record<string, unknown>>;
    /** Set when the server cannot load at all, such as an `sse` server. */
    readonly skipped?: string;
    /** Unknown fields, shown to the person and never fatal. */
    readonly notes: readonly string[];
}

/** A server ready for the `vera.mcp` config. */
export interface PluginMcpServer {
    readonly plugin: string;
    readonly name: string;
    readonly transport: "stdio" | "http";
    readonly config: Readonly<Record<string, unknown>>;
}

export interface PluginMcpSkip {
    readonly plugin: string;
    readonly name: string;
    readonly reason: string;
}

export interface PluginMcpMapping {
    readonly servers: readonly PluginMcpServer[];
    readonly skipped: readonly PluginMcpSkip[];
    readonly notes: readonly string[];
}

export interface MapPluginMcpOptions {
    readonly plugin: string;
    /** The plugin package directory; `${PLUGIN_ROOT}` expands to it. */
    readonly directory: string;
    /** `plugins/.data/<name>`; `${PLUGIN_DATA}` expands to it. */
    readonly dataDirectory: string;
    readonly entries: readonly PluginMcpServerSource[];
    /** Host start creates the data directory; previews and `show` do not. */
    readonly createDataDirectory?: boolean;
}

const STDIO_FIELDS = new Set([
    "type",
    "command",
    "args",
    "env",
    "cwd",
    "enabled",
]);
const HTTP_FIELDS = new Set(["type", "url", "headers", "enabled"]);
const OAUTH_FIELDS = ["auth", "oauth", "clientId"] as const;
// Object.prototype keys would change the composed config rather than add a server.
export const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
    "__proto__",
    "constructor",
    "prototype",
]);

export function loadMcpServers(
    path: string,
    label: string,
    agentPlugins: boolean,
    warnings: string[],
): readonly PluginMcpServerSource[] {
    if (!isFile(path)) return [];
    let value: Record<string, unknown>;
    try {
        value = readJsonObject(path, PLUGIN_MCP_MAX_BYTES, label);
    } catch (error) {
        warnings.push(`${label}: ${errorMessage(error)}`);
        return [];
    }
    if (agentPlugins) {
        const keys = Object.keys(value);
        if (
            value.$schema !== AGENT_MCP_SCHEMA
            || keys.some((key) => key !== "$schema" && key !== "mcpServers")
        ) {
            warnings.push(
                `${label} must contain only the Agent Plugins $schema and mcpServers`,
            );
            return [];
        }
    }
    const servers = value.mcpServers;
    if (!isPlainObject(servers)) {
        warnings.push(`${label} mcpServers must be an object`);
        return [];
    }
    const sources: PluginMcpServerSource[] = [];
    for (const name of Object.keys(servers).toSorted()) {
        const server = servers[name];
        if (!isPlainObject(server)) {
            warnings.push(`${label} server ${name} must be an object`);
            continue;
        }
        if (agentPlugins && typeof server.type !== "string") {
            warnings.push(`${label} server ${name} must declare a type`);
            continue;
        }
        const type = typeof server.type === "string" ? server.type : undefined;
        const transport = transportOf(type, server);
        const notes = unknownFieldNotes(server, transport);
        sources.push({
            name,
            transport,
            source: server,
            ...skippedReason(type, server),
            notes,
        });
    }
    return sources;
}

function transportOf(
    type: string | undefined,
    server: Readonly<Record<string, unknown>>,
): "stdio" | "http" | "unsupported" {
    if (type === "stdio") return "stdio";
    if (type === "http" || type === "streamable-http") return "http";
    if (type === undefined) {
        if (server.command !== undefined) return "stdio";
        if (server.url !== undefined) return "http";
    }
    return "unsupported";
}

function skippedReason(
    type: string | undefined,
    server: Readonly<Record<string, unknown>>,
): { readonly skipped?: string } {
    if (server.enabled === false) return { skipped: "disabled" };
    if (type === "sse") return { skipped: "sse transport is not supported" };
    if (OAUTH_FIELDS.some((field) => field in server)) {
        return { skipped: "OAuth is not supported for plugin MCP servers" };
    }
    if (
        type !== undefined
        && type !== "stdio"
        && type !== "http"
        && type !== "streamable-http"
    ) {
        return { skipped: `unsupported transport "${type}"` };
    }
    return {};
}

function unknownFieldNotes(
    server: Readonly<Record<string, unknown>>,
    transport: "stdio" | "http" | "unsupported",
): readonly string[] {
    const known = transport === "stdio"
        ? STDIO_FIELDS
        : transport === "http"
        ? HTTP_FIELDS
        : new Set([...STDIO_FIELDS, ...HTTP_FIELDS]);
    return Object.keys(server)
        .filter((key) =>
            !known.has(key)
            && !(OAUTH_FIELDS as readonly string[]).includes(key)
        )
        .toSorted()
        .map((key) => `unknown field "${key}" is ignored`);
}

export function mapPluginMcpServers(
    options: MapPluginMcpOptions,
): PluginMcpMapping {
    const directory = resolve(options.directory);
    const dataDirectory = resolve(options.dataDirectory);
    let root: string;
    try {
        root = realpathSync(directory);
    } catch (error) {
        return {
            servers: [],
            skipped: options.entries.map((entry) => ({
                plugin: options.plugin,
                name: entry.name,
                reason: `plugin folder is unavailable: ${errorMessage(error)}`,
            })),
            notes: [],
        };
    }
    let dataRoot: string;
    try {
        dataRoot = prepareDataRoot(dataDirectory);
    } catch (error) {
        return {
            servers: [],
            skipped: options.entries.map((entry) => ({
                plugin: options.plugin,
                name: entry.name,
                reason: errorMessage(error),
            })),
            notes: [],
        };
    }
    const servers: PluginMcpServer[] = [];
    const skipped: PluginMcpSkip[] = [];
    const notes: string[] = [];
    let dataCreated = false;
    for (const entry of options.entries) {
        for (const note of entry.notes) {
            notes.push(
                `plugin ${options.plugin}: server ${entry.name}: ${note}`,
            );
        }
        if (RESERVED_MCP_SERVER_NAMES.has(entry.name)) {
            skipped.push({
                plugin: options.plugin,
                name: entry.name,
                reason: `server name "${entry.name}" is reserved`,
            });
            continue;
        }
        const envPath = envReferencePath(entry.source);
        if (envPath !== undefined) {
            skipped.push({
                plugin: options.plugin,
                name: entry.name,
                reason: `{env:...} is not supported in ${envPath} for plugin MCP servers`,
            });
            continue;
        }
        if (entry.skipped !== undefined) {
            skipped.push({
                plugin: options.plugin,
                name: entry.name,
                reason: entry.skipped,
            });
            continue;
        }
        try {
            const mapped = entry.transport === "http"
                ? mapHttp(entry)
                : mapStdio(entry, {
                    root,
                    dataRoot,
                    createData: options.createDataDirectory === true,
                });
            const validated = parseMcpConfig({
                servers: { [entry.name]: mapped },
            });
            if (validated.length === 0) {
                skipped.push({
                    plugin: options.plugin,
                    name: entry.name,
                    reason: "disabled",
                });
                continue;
            }
            const transport = entry.transport === "http" ? "http" : "stdio";
            servers.push({
                plugin: options.plugin,
                name: entry.name,
                transport,
                config: mapped,
            });
            if (options.createDataDirectory === true && !dataCreated) {
                mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
                dataCreated = true;
            }
        } catch (error) {
            skipped.push({
                plugin: options.plugin,
                name: entry.name,
                reason: errorMessage(error),
            });
        }
    }
    return { servers, skipped, notes };
}

// The directory is created only after a server maps, so a skill-only plugin has none.
function prepareDataRoot(path: string): string {
    if (!existsSync(path)) return path;
    const details = lstatSync(path);
    if (details.isSymbolicLink()) {
        throw new Error(`plugin data directory is a symlink: ${path}`);
    }
    if (!details.isDirectory()) {
        throw new Error(`plugin data directory is not a directory: ${path}`);
    }
    return realpathSync(path);
}

function envReferencePath(value: unknown, prefix = ""): string | undefined {
    if (typeof value === "string") {
        return value.includes("{env:") && prefix.length > 0 ? prefix : undefined;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            const found = envReferencePath(value[index], `${prefix}[${index}]`);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    if (isPlainObject(value)) {
        for (const [key, entry] of Object.entries(value)) {
            const found = envReferencePath(
                entry,
                prefix.length === 0 ? key : `${prefix}.${key}`,
            );
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

interface PathRoots {
    readonly root: string;
    readonly dataRoot: string;
    readonly createData: boolean;
}

function mapStdio(
    entry: PluginMcpServerSource,
    roots: PathRoots,
): Record<string, unknown> {
    const source = entry.source;
    const rawCommand = source.command;
    const argv: string[] = [];
    if (Array.isArray(rawCommand)) {
        if (
            rawCommand.length === 0
            || !rawCommand.every((part) => typeof part === "string")
        ) {
            throw new Error("command must be a non-empty string array");
        }
        argv.push(...rawCommand);
    } else if (typeof rawCommand === "string" && rawCommand.length > 0) {
        argv.push(rawCommand);
    } else {
        throw new Error("command must be a string or a non-empty string array");
    }
    if (source.args !== undefined) {
        if (
            !Array.isArray(source.args)
            || !source.args.every((part) =>
                typeof part === "string" && part.length > 0
            )
        ) {
            throw new Error("args must be a string array");
        }
        argv.push(...source.args);
    }
    const expanded = argv.map((part) => expandPlaceholders(part, roots));
    const command = [
        containCommand(expanded[0]!, roots),
        ...expanded.slice(1),
    ];
    const env = mapEnvironment(source.env, roots);
    const cwd = source.cwd === undefined
        ? roots.root
        : typeof source.cwd === "string"
        ? containDirectory(source.cwd, roots)
        : (() => {
            throw new Error("cwd must be a string");
        })();
    return { command, env, cwd };
}

function mapHttp(entry: PluginMcpServerSource): Record<string, unknown> {
    const url = entry.source.url;
    if (typeof url !== "string") {
        throw new Error("url must be a string");
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`url is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("url must use http or https");
    }
    if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
        throw new Error(`http is only allowed to a loopback host: ${url}`);
    }
    const headers = entry.source.headers;
    if (headers !== undefined) {
        if (
            !isPlainObject(headers)
            || !Object.values(headers).every((value) =>
                typeof value === "string"
            )
        ) {
            throw new Error("headers must map strings to strings");
        }
    }
    // Header values stay literal: no `{env:...}` or `${...}` expansion.
    return { url, ...(headers === undefined ? {} : { headers }) };
}

function isLoopback(hostname: string): boolean {
    const host = hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname;
    return host === "localhost"
        || host === "::1"
        || (isIP(host) === 4 && host.startsWith("127."));
}

function containCommand(expanded: string, roots: PathRoots): string {
    if (!namesPath(expanded)) {
        return expanded;
    }
    return containPath(expanded, "command", roots, "file");
}

function containDirectory(raw: string, roots: PathRoots): string {
    return containPath(expandPlaceholders(raw, roots), "cwd", roots, "directory");
}

function namesPath(value: string): boolean {
    return value.includes("/") || value.includes("\\");
}

function containPath(
    raw: string,
    label: "command" | "cwd",
    roots: PathRoots,
    kind: "file" | "directory",
): string {
    const expanded = raw;
    const absolute = isAbsolute(expanded)
        ? resolve(expanded)
        : resolve(roots.root, expanded);
    if (!isInside(roots.root, absolute) && !isInside(roots.dataRoot, absolute)) {
        throw new Error(`${label} is outside the plugin: ${expanded}`);
    }
    let details;
    try {
        details = lstatSync(absolute);
    } catch {
        if (
            kind === "directory"
            && isInside(roots.dataRoot, absolute)
            && roots.createData
        ) {
            mkdirSync(absolute, { recursive: true, mode: 0o700 });
            return realpathSync(absolute);
        }
        throw new Error(`${label} does not exist: ${expanded}`);
    }
    if (details.isSymbolicLink()) {
        throw new Error(`${label} is a symlink: ${expanded}`);
    }
    if (kind === "file" ? !details.isFile() : !details.isDirectory()) {
        throw new Error(`${label} is not a ${kind}: ${expanded}`);
    }
    const real = realpathSync(absolute);
    if (!isInside(roots.root, real) && !isInside(roots.dataRoot, real)) {
        throw new Error(`${label} leaves the plugin: ${expanded}`);
    }
    return real;
}

function mapEnvironment(
    value: unknown,
    roots: PathRoots,
): Record<string, string> {
    const env: Record<string, string> = {};
    if (value !== undefined) {
        if (
            !isPlainObject(value)
            || !Object.values(value).every((entry) =>
                typeof entry === "string"
            )
        ) {
            throw new Error("env must map strings to strings");
        }
        for (const [key, entry] of Object.entries(value)) {
            if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") {
                throw new Error(`env cannot override ${key}`);
            }
            env[expandPlaceholders(key, roots)] = expandPlaceholders(
                entry as string,
                roots,
            );
        }
    }
    env.PLUGIN_ROOT = roots.root;
    env.PLUGIN_DATA = roots.dataRoot;
    return env;
}

function expandPlaceholders(value: string, roots: PathRoots): string {
    return value.replace(
        /\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g,
        (_match, name: string) =>
            name === "PLUGIN_ROOT" ? roots.root : roots.dataRoot,
    );
}

function isInside(root: string, path: string): boolean {
    const offset = relative(root, path);
    return offset === ""
        || (offset !== ".."
            && !offset.startsWith(`..${sep}`)
            && !isAbsolute(offset));
}

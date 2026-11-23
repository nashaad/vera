import { realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { loadAgents } from "./agents.ts";
import type { PluginComponents } from "./components.ts";
import { PluginManifestError } from "./errors.ts";
import {
    loadDesktopExtension,
    loadHostExtension,
    noteIgnoredPath,
} from "./extension-parts.ts";
import { loadMcpServers } from "./mcp.ts";
import {
    AGENT_PLUGIN_MANIFEST_FILENAME,
    AGENT_PLUGIN_SCHEMA,
    CLAUDE_PLUGIN_MANIFEST_PATH,
    CODEX_PLUGIN_MANIFEST_PATH,
    DESKTOP_EXTENSION_MANIFEST_FILENAME,
    HOST_EXTENSION_MANIFEST_FILENAME,
    PLUGIN_MANIFEST_MAX_BYTES,
    isPortablePluginName,
    portablePluginName,
} from "./naming.ts";
import {
    errorMessage,
    isDirectory,
    isFile,
    isPlainObject,
    isWithin,
    readJsonObject,
} from "./package-files.ts";
import { loadSkills } from "./skills.ts";

export type PluginLayout =
    | "agent-plugins"
    | "claude"
    | "codex"
    | "extension";

export interface LoadedPluginPackage {
    readonly directory: string;
    readonly layout: PluginLayout;
    readonly install_name: string;
    readonly version?: string;
    readonly description?: string;
    readonly components: PluginComponents;
    readonly ignored: readonly string[];
    readonly warnings: readonly string[];
}

const PLUGIN_MANIFEST_KEYS = new Set([
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
]);

const VERA_DECLARATION_KEYS = new Set(["agents", "extension", "desktop"]);

interface PluginFolderBase {
    readonly directory: string;
    readonly agents: string | null;
    readonly extension: string;
    readonly desktop: string;
    readonly extension_declared: boolean;
    readonly desktop_declared: boolean;
    readonly ignored: readonly string[];
    readonly warnings: readonly string[];
}

interface NamedPluginPartFolders extends PluginFolderBase {
    readonly layout: "agent-plugins" | "claude" | "codex";
    readonly install_name: string;
    readonly version?: string;
    readonly description?: string;
}

interface BarePluginPartFolders extends PluginFolderBase {
    readonly layout: "extension";
}

type PluginPartFolders = NamedPluginPartFolders | BarePluginPartFolders;

export function readPluginPartFolders(configuredDirectory: string): PluginPartFolders {
    const directory = realDirectory(configuredDirectory);
    const markers = pluginMarkers(directory);
    const chosen = markers.find((marker) => marker.present);
    if (chosen === undefined) {
        throw new PluginManifestError(
            `No plugin manifest in ${directory}. Looked for plugin.json, `
                + `${CLAUDE_PLUGIN_MANIFEST_PATH}, ${CODEX_PLUGIN_MANIFEST_PATH}, `
                + `${HOST_EXTENSION_MANIFEST_FILENAME} and ${DESKTOP_EXTENSION_MANIFEST_FILENAME}.`,
        );
    }

    const ignored: string[] = [];
    const warnings: string[] = [];
    for (const marker of markers) {
        if (marker === chosen || !marker.present) continue;
        ignored.push(`ignored: ${marker.label} (${chosen.label} layout wins)`);
    }

    if (chosen.layout === "agent-plugins") {
        return readAgentPluginFolders(directory, ignored, warnings);
    }
    if (chosen.layout === "claude" || chosen.layout === "codex") {
        return readForeignPluginFolders(directory, chosen.layout, ignored, warnings);
    }
    return {
        directory,
        layout: "extension",
        agents: null,
        extension: directory,
        desktop: directory,
        extension_declared: false,
        desktop_declared: false,
        ignored,
        warnings,
    };
}

export function loadPluginPackage(configuredDirectory: string): LoadedPluginPackage {
    const parts = readPluginPartFolders(configuredDirectory);
    const { directory, layout } = parts;
    const ignored = [...parts.ignored];
    const warnings = [...parts.warnings];

    const parsed = parts.layout === "extension"
        ? parseExtensionPackage(parts, warnings)
        : parts.layout === "agent-plugins"
        ? parseAgentPluginsPackage(parts, warnings)
        : parseForeignPackage(parts, warnings);

    return {
        directory,
        layout,
        install_name: parsed.install_name,
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
        ...(parsed.description === undefined
            ? {}
            : { description: parsed.description }),
        components: parsed.components,
        ignored,
        warnings,
    };
}

interface PluginMarker {
    readonly layout: PluginLayout;
    readonly label: string;
    readonly present: boolean;
}

function pluginMarkers(directory: string): readonly PluginMarker[] {
    return [
        {
            layout: "agent-plugins",
            label: AGENT_PLUGIN_MANIFEST_FILENAME,
            present: isFile(join(directory, AGENT_PLUGIN_MANIFEST_FILENAME)),
        },
        {
            layout: "claude",
            label: CLAUDE_PLUGIN_MANIFEST_PATH,
            present: isFile(join(directory, CLAUDE_PLUGIN_MANIFEST_PATH)),
        },
        {
            layout: "codex",
            label: CODEX_PLUGIN_MANIFEST_PATH,
            present: isFile(join(directory, CODEX_PLUGIN_MANIFEST_PATH)),
        },
        {
            layout: "extension",
            label: HOST_EXTENSION_MANIFEST_FILENAME,
            present: isFile(join(directory, HOST_EXTENSION_MANIFEST_FILENAME))
                || isFile(join(directory, DESKTOP_EXTENSION_MANIFEST_FILENAME)),
        },
    ];
}

interface ParsedPackage {
    readonly install_name: string;
    readonly version?: string;
    readonly description?: string;
    readonly components: PluginComponents;
}

function readAgentPluginFolders(
    directory: string,
    ignored: string[],
    warnings: string[],
): NamedPluginPartFolders {
    const path = join(directory, AGENT_PLUGIN_MANIFEST_FILENAME);
    const value = readJsonObject(path, PLUGIN_MANIFEST_MAX_BYTES, "plugin.json");
    if (value.$schema !== AGENT_PLUGIN_SCHEMA) {
        throw new PluginManifestError(
            `plugin.json targets an unsupported schema: ${String(value.$schema)}`,
        );
    }
    const name = value.name;
    if (typeof name !== "string" || !isPortablePluginName(name)) {
        throw new PluginManifestError(
            "plugin.json name must use lowercase letters, digits, hyphens and periods, "
                + "start and end with a letter or digit, and stay within 64 characters",
        );
    }
    for (const key of Object.keys(value)) {
        if (!PLUGIN_MANIFEST_KEYS.has(key)) {
            ignored.push(`ignored: plugin.json field "${key}"`);
        }
    }
    const version = optionalText(value.version, "plugin.json version");
    const description = optionalText(value.description, "plugin.json description");
    validateMetadata(value);

    const declared = veraDeclaration(directory, value.extensions, ignored, warnings);
    return {
        directory,
        layout: "agent-plugins",
        install_name: name,
        ...(version === undefined ? {} : { version }),
        ...(description === undefined ? {} : { description }),
        agents: declared.agents ?? join(directory, "dev.vera", "agents"),
        extension: declared.extension ?? join(directory, "dev.vera", "host"),
        desktop: declared.desktop ?? join(directory, "dev.vera", "desktop"),
        extension_declared: declared.extension !== undefined,
        desktop_declared: declared.desktop !== undefined,
        ignored,
        warnings,
    };
}

function parseAgentPluginsPackage(
    parts: NamedPluginPartFolders,
    warnings: string[],
): ParsedPackage {
    const { directory } = parts;
    const host = loadHostExtension(
        parts.extension,
        directory,
        warnings,
        parts.extension_declared,
    );
    const desktop = loadDesktopExtension(
        parts.desktop,
        directory,
        warnings,
        parts.desktop_declared,
    );
    const skills = loadSkills(
        [join(directory, "skills"), ...(host?.skill_roots ?? [])],
        directory,
        warnings,
    );
    const agents = parts.agents === null ? [] : loadAgents(parts.agents, directory, warnings);
    const mcp = loadMcpServers(
        join(directory, "mcp.json"),
        "mcp.json",
        true,
        warnings,
    );

    return {
        install_name: parts.install_name,
        ...(parts.version === undefined ? {} : { version: parts.version }),
        ...(parts.description === undefined ? {} : { description: parts.description }),
        components: {
            skills,
            agents,
            mcp_servers: mcp,
            host_extension: host?.component ?? null,
            desktop_extension: desktop ?? null,
        },
    };
}

function readForeignPluginFolders(
    directory: string,
    layout: "claude" | "codex",
    ignored: string[],
    warnings: string[],
): NamedPluginPartFolders {
    const relativeManifest = layout === "claude"
        ? CLAUDE_PLUGIN_MANIFEST_PATH
        : CODEX_PLUGIN_MANIFEST_PATH;
    const value = readJsonObject(
        join(directory, relativeManifest),
        PLUGIN_MANIFEST_MAX_BYTES,
        relativeManifest,
    );
    const name = value.name;
    if (typeof name !== "string" || name.trim().length === 0) {
        throw new PluginManifestError(`${relativeManifest} must have a name`);
    }
    const version = optionalText(value.version, `${relativeManifest} version`);
    const description = optionalText(
        value.description,
        `${relativeManifest} description`,
    );

    if (layout === "claude") {
        noteIgnoredPath(directory, "commands", ignored, "Claude commands are not read");
        noteIgnoredPath(directory, "hooks", ignored, "Claude hooks are not read");
        noteIgnoredPath(directory, "lsp", ignored, "LSP configuration is not read");
        noteIgnoredPath(
            directory,
            ".lsp.json",
            ignored,
            "LSP configuration is not read",
        );
    } else {
        noteIgnoredPath(directory, ".app.json", ignored, "Codex apps are not read");
        noteIgnoredPath(directory, "hooks", ignored, "Codex hooks are not read");
    }

    const installName = portablePluginName(name)
        ?? portablePluginName(basename(directory));
    if (installName === undefined) {
        throw new PluginManifestError(
            `${relativeManifest} name "${name}" cannot be used as a plugin name`,
        );
    }
    return {
        directory,
        layout,
        install_name: installName,
        ...(version === undefined ? {} : { version }),
        ...(description === undefined ? {} : { description }),
        agents: layout === "claude" ? join(directory, "agents") : null,
        extension: directory,
        desktop: directory,
        extension_declared: false,
        desktop_declared: false,
        ignored,
        warnings,
    };
}

function parseForeignPackage(
    parts: NamedPluginPartFolders,
    warnings: string[],
): ParsedPackage {
    const { directory } = parts;
    const host = loadHostExtension(parts.extension, directory, warnings);
    const desktop = loadDesktopExtension(parts.desktop, directory, warnings);
    const skills = loadSkills(
        [join(directory, "skills"), ...(host?.skill_roots ?? [])],
        directory,
        warnings,
    );
    const agents = parts.agents === null ? [] : loadAgents(parts.agents, directory, warnings);
    const mcp = loadMcpServers(
        join(directory, ".mcp.json"),
        ".mcp.json",
        false,
        warnings,
    );

    return {
        install_name: parts.install_name,
        ...(parts.version === undefined ? {} : { version: parts.version }),
        ...(parts.description === undefined ? {} : { description: parts.description }),
        components: {
            skills,
            agents,
            mcp_servers: mcp,
            host_extension: host?.component ?? null,
            desktop_extension: desktop ?? null,
        },
    };
}

function parseExtensionPackage(
    parts: BarePluginPartFolders,
    warnings: string[],
): ParsedPackage {
    const { directory } = parts;
    const host = loadHostExtension(parts.extension, directory, warnings);
    const desktop = loadDesktopExtension(parts.desktop, directory, warnings);
    if (host === undefined && desktop === undefined) {
        throw new PluginManifestError(
            `No readable Vera extension manifest in ${directory}`,
        );
    }
    const candidate = host?.component.id ?? desktop?.id;
    if (candidate === undefined) {
        throw new PluginManifestError(`Could not name the extension in ${directory}`);
    }
    const installName = portablePluginName(candidate)
        ?? portablePluginName(basename(directory));
    if (installName === undefined) {
        throw new PluginManifestError(
            `Extension ${candidate} cannot be used as a plugin name`,
        );
    }
    return {
        install_name: installName,
        ...(host === undefined ? {} : { version: host.component.version }),
        components: {
            skills: loadSkills(host?.skill_roots ?? [], directory, warnings),
            agents: [],
            mcp_servers: [],
            host_extension: host?.component ?? null,
            desktop_extension: desktop ?? null,
        },
    };
}

function veraDeclaration(
    directory: string,
    value: unknown,
    ignored: string[],
    warnings: string[],
): {
    readonly agents?: string;
    readonly extension?: string;
    readonly desktop?: string;
} {
    if (value === undefined) return {};
    if (!isPlainObject(value)) {
        ignored.push("ignored: plugin.json extensions is not an object");
        return {};
    }
    const declared = value["dev.vera"];
    if (declared === undefined) return {};
    if (!isPlainObject(declared)) {
        warnings.push(
            "dev.vera must be an object; Vera parts use their default directories",
        );
        return {};
    }
    for (const key of Object.keys(declared)) {
        if (!VERA_DECLARATION_KEYS.has(key)) {
            ignored.push(`ignored: dev.vera field "${key}"`);
        }
    }
    const read = (key: "agents" | "extension" | "desktop"): string | undefined => {
        const raw = declared[key];
        if (raw === undefined) return undefined;
        if (typeof raw !== "string" || !raw.startsWith("./")) {
            warnings.push(`dev.vera ${key} must be a path beginning "./"`);
            return undefined;
        }
        const path = resolve(directory, raw);
        if (!isWithin(directory, path)) {
            warnings.push(`dev.vera ${key} leaves the plugin: ${raw}`);
            return undefined;
        }
        return path;
    };
    const agents = read("agents");
    const extension = read("extension");
    const desktop = read("desktop");
    return {
        ...(agents === undefined ? {} : { agents }),
        ...(extension === undefined ? {} : { extension }),
        ...(desktop === undefined ? {} : { desktop }),
    };
}

function validateMetadata(value: Record<string, unknown>): void {
    for (const key of ["homepage", "repository", "license"] as const) {
        if (value[key] !== undefined && typeof value[key] !== "string") {
            throw new PluginManifestError(`plugin.json ${key} must be a string`);
        }
    }
    if (
        value.keywords !== undefined
        && (!Array.isArray(value.keywords)
            || value.keywords.some((keyword) => typeof keyword !== "string"))
    ) {
        throw new PluginManifestError("plugin.json keywords must be an array of strings");
    }
    if (value.author !== undefined) {
        if (!isPlainObject(value.author)) {
            throw new PluginManifestError("plugin.json author must be an object");
        }
        for (const key of Object.keys(value.author)) {
            if (!["name", "email", "url"].includes(key)) {
                throw new PluginManifestError(
                    `plugin.json author has an unknown field "${key}"`,
                );
            }
            if (typeof value.author[key] !== "string") {
                throw new PluginManifestError(
                    `plugin.json author ${key} must be a string`,
                );
            }
        }
    }
}

function optionalText(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        throw new PluginManifestError(`${label} must be a string`);
    }
    const text = value.trim();
    return text.length === 0 ? undefined : text;
}

function realDirectory(configuredDirectory: string): string {
    let directory: string;
    try {
        directory = realpathSync(resolve(configuredDirectory));
    } catch (error) {
        throw new PluginManifestError(
            `Plugin directory is unavailable at ${configuredDirectory}: ${errorMessage(error)}`,
        );
    }
    if (!isDirectory(directory)) {
        throw new PluginManifestError(`Plugin path is not a directory: ${directory}`);
    }
    return directory;
}

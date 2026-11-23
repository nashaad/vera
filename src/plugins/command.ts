import { homedir } from "node:os";
import { join } from "node:path";

import { tokenizeCommandArguments } from "../command-arguments.ts";
import {
    pluginRestartNotes,
    type PluginInstallPreview,
    type PluginListResult,
    type PluginRemoval,
    type PluginShowResult,
} from "./manager.ts";
import {
    pluginSummaryLine,
    summarizePluginComponents,
} from "./components.ts";
import type { PluginMcpMapping } from "./mcp.ts";
import type { PluginRecord } from "./registry.ts";

export type PluginManagerCommand =
    | { readonly operation: "list" }
    | { readonly operation: "migrate" }
    | { readonly operation: "show"; readonly name: string }
    | {
        readonly operation: "install";
        readonly source: string;
        readonly dry_run: boolean;
    }
    | {
        readonly operation: "enable";
        readonly name: string;
    }
    | {
        readonly operation: "disable";
        readonly name: string;
    }
    | {
        readonly operation: "remove";
        readonly name: string;
        readonly purge: boolean;
    };

export function tokenizePluginManagerArguments(
    text: string,
): { readonly words: readonly string[] } | { readonly error: string } {
    return tokenizeCommandArguments(text, "plugin command");
}

export function parsePluginManagerCommand(
    args: readonly string[],
): { readonly command: PluginManagerCommand } | { readonly error: string } | undefined {
    if (args[0] !== "plugin") return undefined;
    const operation = args[1];
    if (operation === undefined) return { error: pluginManagerUsage() };
    const words = args.slice(2);
    const dryRun = words.includes("--dry-run");
    const purge = words.includes("--purge");
    const positional = words.filter((word) =>
        word !== "--dry-run" && word !== "--purge"
    );

    if (operation === "migrate") {
        if (words.length !== 0) return { error: "Usage: vera plugin migrate" };
        return { command: { operation: "migrate" } };
    }
    if (operation === "list") {
        if (dryRun || purge || positional.length > 0) {
            return { error: "Usage: vera plugin list" };
        }
        return { command: { operation: "list" } };
    }
    if (operation === "show") {
        if (dryRun || purge || positional.length !== 1) {
            return { error: "Usage: vera plugin show <name>" };
        }
        return { command: { operation: "show", name: positional[0]! } };
    }
    if (operation === "install") {
        if (purge || positional.length !== 1) {
            return {
                error: "Usage: vera plugin install <path> [--dry-run]",
            };
        }
        return {
            command: {
                operation: "install",
                source: expandHome(positional[0]!),
                dry_run: dryRun,
            },
        };
    }
    if (operation === "enable" || operation === "disable") {
        if (dryRun || purge || positional.length !== 1) {
            return { error: `Usage: vera plugin ${operation} <name>` };
        }
        return { command: { operation, name: positional[0]! } };
    }
    if (operation === "remove") {
        if (dryRun || positional.length !== 1) {
            return { error: "Usage: vera plugin remove <name> [--purge]" };
        }
        return {
            command: { operation: "remove", name: positional[0]!, purge },
        };
    }
    return {
        error: `Unknown plugin operation '${operation}'. ${pluginManagerUsage()}`,
    };
}

export function pluginManagerUsage(): string {
    return "Usage: vera plugin list|show|install|enable|disable|remove|migrate <…>";
}

export function renderPluginInstallPreview(preview: PluginInstallPreview): string {
    const components = preview.components;
    return [
        preview.dry_run ? "Plugin install plan (dry run)" : "Plugin install",
        "",
        `name:        ${preview.name}`,
        `version:     ${preview.version ?? "-"}`,
        `layout:      ${preview.layout}`,
        `source:      ${preview.source_path}`,
        ...(preview.replaces === null
            ? []
            : [`Replaces ${preview.replaces.name}, installed from ${preview.replaces.source_path}`]),
        `destination: ${preview.directory}`,
        `digest:      ${preview.digest}`,
        `size:        ${preview.entries} entries, ${preview.total_bytes} bytes`,
        `enabled:     ${preview.enabled ? "yes" : "no"}`,
        `skills:      ${names(components.skills.map((skill) => skill.name))}`,
        `agents:      ${names(components.agents.map((agent) => agent.name))}`,
        ...mcpLines(preview.mcp, preview.mcp_enabled),
        `host:        ${components.host_extension === null
            ? "none"
            : `${components.host_extension.id} ${components.host_extension.version} `
                + `(${components.host_extension.capabilities.join(", ") || "no capabilities"})`}`,
        `desktop:     ${components.desktop_extension === null
            ? "none"
            : `${components.desktop_extension.id} ${components.desktop_extension.version}`}`,
        ...preview.ignored.map((line) => `note:        ${line}`),
        ...preview.warnings.map((line) => `warning:     ${line}`),
        "",
    ].join("\n");
}

export function renderPluginList(result: PluginListResult): string {
    if (result.plugins.length === 0 && result.orphans.length === 0) {
        return "No plugins installed.\n";
    }
    const lines = ["Plugins", ""];
    for (const entry of result.plugins) {
        const record = entry.record;
        const state = record.enabled ? "enabled" : "disabled";
        const version = record.version === undefined ? "-" : `v${record.version}`;
        lines.push(
            `${record.name.padEnd(24)} ${version.padEnd(12)} ${state.padEnd(10)} `
                + pluginSummaryLine(record.components),
        );
        lines.push(`  path: ${entry.path}`);
        lines.push(`  source: ${record.source.path}`);
        lines.push(`  digest: ${record.digest}`);
        if (entry.modified) {
            lines.push("  modified: files changed since install");
        }
        if (entry.problem !== null) lines.push(`  error: ${entry.problem}`);
    }
    for (const orphan of result.orphans) {
        lines.push(`orphan: ${orphan} (not installed)`);
    }
    return `${lines.join("\n")}\n`;
}

export function renderPluginShow(result: PluginShowResult): string {
    const record = result.record;
    const components = result.package.components;
    return [
        `Plugin ${record.name}`,
        "",
        `version:     ${record.version ?? "-"}`,
        `description: ${record.description ?? "none"}`,
        `layout:      ${result.package.layout}`,
        `state:       ${record.enabled ? "enabled" : "disabled"}`,
        `path:        ${result.path}`,
        `source:      ${record.source.path}`,
        `installed:   ${record.installed_at}`,
        `digest:      ${result.digest}`,
        `modified:    ${result.modified ? "yes" : "no"}`,
        `skills:      ${names(components.skills.map((skill) => skill.name))}`,
        `agents:      ${names(components.agents.map((agent) => agent.name))}`,
        ...mcpLines(result.mcp, result.mcp_enabled),
        `host:        ${components.host_extension === null
            ? "none"
            : `${components.host_extension.id} ${components.host_extension.version} `
                + `(${components.host_extension.capabilities.join(", ") || "no capabilities"})`}`,
        `desktop:     ${components.desktop_extension === null
            ? "none"
            : `${components.desktop_extension.id} ${components.desktop_extension.version}`}`,
        `data:        ${result.data_directory} (${result.data_bytes} bytes)`,
        ...record.ignored.map((line) => `note:        ${line}`),
        ...result.package.warnings.map((line) => `warning:     ${line}`),
        "",
    ].join("\n");
}

export function renderPluginMutation(
    operation: "enable" | "disable",
    record: PluginRecord,
): string {
    const notes = pluginRestartNotes(record.components, operation);
    return [
        `${operation === "enable" ? "Enabled" : "Disabled"} ${record.name}.`,
        ...notes,
    ].join("\n") + "\n";
}

export function renderPluginRemoval(removal: PluginRemoval): string {
    const lines = [
        `Removed ${removal.record.name}.`,
        ...(removal.legacy_removed ?? []).map((path) => `Removed legacy extension at ${path}.`),
        removal.data_kept
            ? `Plugin data kept at ${removal.data_directory} (${removal.data_bytes} bytes).`
            : `Deleted plugin data at ${removal.data_directory}.`,
        ...pluginRestartNotes(removal.record.components, "disable"),
    ];
    return `${lines.join("\n")}\n`;
}

export function renderPluginInstallResult(
    preview: PluginInstallPreview,
    noop: boolean,
): string {
    if (noop) {
        return `${preview.name} is already installed with the same contents.\n`;
    }
    const notes = pluginRestartNotes(summarizePluginComponents(preview.components));
    const installed = preview.replaces === null
        ? `Installed ${preview.name}.`
        : `Installed ${preview.name}, replacing the copy from ${preview.replaces.source_path}.`;
    const lines = [
        renderPluginInstallPreview(preview).trimEnd(),
        "",
        installed,
        ...notes,
    ];
    return `${lines.join("\n")}\n`;
}

function mcpLines(
    mapping: PluginMcpMapping,
    enabled: boolean,
): readonly string[] {
    const lines = [
        `mcp servers: ${names(mapping.servers.map((server) =>
            `${server.name} (${server.transport})`
        ))}`,
    ];
    for (const skip of mapping.skipped) {
        lines.push(`mcp skipped: ${skip.name}: ${skip.reason}`);
    }
    for (const note of mapping.notes) {
        lines.push(`mcp note:    ${note}`);
    }
    if (!enabled) {
        lines.push("mcp:         MCP servers are off because vera.mcp is off");
    }
    return lines;
}

function names(values: readonly string[]): string {
    return values.length === 0 ? "none" : values.join(", ");
}

// The composer passes paths unexpanded; a shell would have expanded ~ already.
function expandHome(path: string): string {
    if (path === "~") return homedir();
    return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

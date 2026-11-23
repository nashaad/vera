import { homedir } from "node:os";
import { join } from "node:path";

import { tokenizeCommandArguments } from "../command-arguments.ts";
import { renderPluginInstallPreview } from "../plugins/command.ts";
import type {
    ExtensionInstallPreview,
    ExtensionListEntry,
} from "./manager.ts";

export type ExtensionManagerCommand =
    | { readonly operation: "list" }
    | {
        readonly operation: "install";
        readonly source: string;
        readonly dryRun: boolean;
    }
    | {
        readonly operation: "enable" | "disable" | "remove";
        readonly id: string;
    }
    | { readonly operation: "reload" };

export function tokenizeExtensionManagerArguments(
    text: string,
): { readonly words: readonly string[] } | { readonly error: string } {
    return tokenizeCommandArguments(text, "extension command");
}

export function parseExtensionManagerCommand(
    args: readonly string[],
): { readonly command: ExtensionManagerCommand } | { readonly error: string } | undefined {
    if (args[0] !== "extension") return undefined;
    const operation = args[1];
    if (operation === undefined) {
        return { error: extensionManagerUsage() };
    }

    const words = args.slice(2);
    const dryRun = words.includes("--dry-run");
    const positional = words.filter((word) => word !== "--dry-run");

    if (operation === "list") {
        if (dryRun || positional.length > 0) {
            return { error: "Usage: vera extension list" };
        }
        return { command: { operation: "list" } };
    }
    if (operation === "install") {
        if (positional.length !== 1) {
            return { error: "Usage: vera extension install <path> [--dry-run]" };
        }
        return {
            command: {
                operation: "install",
                source: expandHome(positional[0]!),
                dryRun,
            },
        };
    }
    if (operation === "enable" || operation === "disable" || operation === "remove") {
        if (dryRun || positional.length !== 1) {
            return { error: `Usage: vera extension ${operation} <id>` };
        }
        return { command: { operation, id: positional[0]! } };
    }
    if (operation === "reload" && words.length === 0) {
        return { command: { operation: "reload" } };
    }
    return { error: `Unknown extension operation '${operation}'. ${extensionManagerUsage()}` };
}

export function extensionManagerUsage(): string {
    return "Usage: vera extension list|install|enable|disable|remove|reload <…>";
}

export function renderExtensionList(entries: readonly ExtensionListEntry[]): string {
    if (entries.length === 0) return "No extensions installed.\n";
    const lines = ["Extensions", ""];
    for (const entry of entries) {
        const state = entry.managed || entry.included
            ? entry.enabled ? "enabled" : "disabled"
            : "unmanaged";
        const version = entry.version === undefined ? "?" : `v${entry.version}`;
        const capabilities = entry.capabilities?.join(",") ?? "?";
        lines.push(
            `${entry.id.padEnd(24)} ${version.padEnd(12)} `
                + `${state.padEnd(10)} ${capabilities}`,
        );
        lines.push(`  path: ${entry.path}`);
        if (entry.source !== undefined) lines.push(`  source: ${entry.source}`);
        if (entry.digest !== undefined) lines.push(`  digest: ${entry.digest}`);
        if (entry.error !== undefined) lines.push(`  error: ${entry.error}`);
    }
    return `${lines.join("\n")}\n`;
}

export function renderExtensionInstallPreview(
    preview: ExtensionInstallPreview,
): string {
    if (preview.plugin !== undefined) {
        return `Extension folders install as plugins.\n${renderPluginInstallPreview(preview.plugin)}`;
    }
    return [
        preview.dryRun ? "Extension install plan (dry run)" : "Extension install",
        "",
        `id:          ${preview.id}`,
        `version:     ${preview.version}`,
        `source:      ${preview.source}`,
        `destination: ${preview.destination}`,
        `digest:      ${preview.digest}`,
        `capabilities: ${preview.capabilities.join(", ") || "none"}`,
        ...(preview.unreviewedTools.length === 0
            ? []
            : [`unreviewed:   ${preview.unreviewedTools.join(", ")}`]),
        "",
    ].join("\n");
}

export function renderExtensionMutation(
    operation: "enable" | "disable" | "remove",
    record: { readonly id: string; readonly plugin?: string; readonly data_directory?: string; readonly legacy_removed?: readonly string[] },
): string {
    if (operation === "remove") {
        if (record.plugin !== undefined) {
            return [
                `Removed plugin ${record.plugin} (extension ${record.id}).`,
                ...(record.legacy_removed ?? []).map((path) => `Removed legacy extension at ${path}.`),
                `Plugin data kept at ${record.data_directory}.`,
                "",
            ].join("\n");
        }
        return `Removed ${record.id}.\n`;
    }
    return `${operation === "enable" ? "Enabled" : "Disabled"} ${record.id}.\n`;
}

// The composer passes paths unexpanded; a shell would have expanded ~ already.
function expandHome(path: string): string {
    if (path === "~") return homedir();
    return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

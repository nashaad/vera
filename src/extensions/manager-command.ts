import type {
    ExtensionInstallPreview,
    ExtensionListEntry,
    ManagedExtensionRecord,
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
    const words: string[] = [];
    let current = "";
    let quoted: "'" | '"' | undefined;
    let escaped = false;
    let started = false;
    for (const character of text) {
        if (escaped) {
            current += character;
            escaped = false;
            started = true;
            continue;
        }
        if (character === "\\" && quoted !== "'") {
            escaped = true;
            started = true;
            continue;
        }
        if (quoted !== undefined) {
            if (character === quoted) {
                quoted = undefined;
            } else {
                current += character;
            }
            started = true;
            continue;
        }
        if (character === "'" || character === '"') {
            quoted = character;
            started = true;
        } else if (/\s/.test(character)) {
            if (started) {
                words.push(current);
                current = "";
                started = false;
            }
        } else {
            current += character;
            started = true;
        }
    }
    if (escaped) current += "\\";
    if (quoted !== undefined) {
        return { error: "Unclosed quote in extension command" };
    }
    if (started) words.push(current);
    return { words };
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
                source: positional[0]!,
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
    return "Usage: vera extension list|install|enable|disable|remove <…>";
}

export function renderExtensionList(entries: readonly ExtensionListEntry[]): string {
    if (entries.length === 0) return "No extensions installed.\n";
    const lines = ["Extensions", ""];
    for (const entry of entries) {
        const state = entry.managed
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
    return [
        preview.dryRun ? "Extension install plan (dry run)" : "Extension install",
        "",
        `id:          ${preview.id}`,
        `version:     ${preview.version}`,
        `source:      ${preview.source}`,
        `destination: ${preview.destination}`,
        `digest:      ${preview.digest}`,
        `capabilities: ${preview.capabilities.join(", ") || "none"}`,
        "",
    ].join("\n");
}

export function renderExtensionMutation(
    operation: "enable" | "disable" | "remove",
    record: ManagedExtensionRecord,
): string {
    if (operation === "remove") {
        return `Removed ${record.id}.\n`;
    }
    return `${operation === "enable" ? "Enabled" : "Disabled"} ${record.id}.\n`;
}

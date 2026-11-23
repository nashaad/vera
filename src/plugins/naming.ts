export const AGENT_PLUGIN_MANIFEST_FILENAME = "plugin.json";
export const AGENT_PLUGIN_SCHEMA =
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AGENT_MCP_SCHEMA =
    "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const CLAUDE_PLUGIN_MANIFEST_PATH = ".claude-plugin/plugin.json";
export const CODEX_PLUGIN_MANIFEST_PATH = ".codex-plugin/plugin.json";
export const HOST_EXTENSION_MANIFEST_FILENAME = "vera.extension.json";
export const DESKTOP_EXTENSION_MANIFEST_FILENAME = "vera.desktop.json";

export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;
export const PLUGIN_MCP_MAX_BYTES = 256 * 1024;
export const PLUGIN_SKILL_MAX_BYTES = 256 * 1024;
export const PLUGIN_AGENT_MAX_BYTES = 1024 * 1024;
export const MAX_PLUGIN_NAME_CHARACTERS = 64;

export function isPortablePluginName(value: string): boolean {
    if (value.length < 1 || value.length > MAX_PLUGIN_NAME_CHARACTERS) {
        return false;
    }
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) return false;
    return !value.includes("--") && !value.includes("..");
}

// The name a folder installs under when its own manifest is not portable.
export function portablePluginName(value: string): string | undefined {
    const name = value.trim().toLowerCase()
        .replace(/_/g, "-")
        .replace(/[^a-z0-9.-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/\.{2,}/g, ".")
        .replace(/^[^a-z0-9]+/, "")
        .replace(/[^a-z0-9]+$/, "")
        .slice(0, MAX_PLUGIN_NAME_CHARACTERS)
        .replace(/[^a-z0-9]+$/, "");
    if (name.length === 0) return undefined;
    return isPortablePluginName(name) ? name : undefined;
}

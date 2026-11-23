export interface PluginInstallPreview {
    readonly name: string;
    readonly version?: string;
    readonly description?: string;
    readonly source_path: string;
    readonly replaces: { readonly name: string; readonly source_path: string } | null;
    readonly skills: readonly string[];
    readonly agents: readonly string[];
    readonly mcp: {
        readonly servers: readonly { readonly name: string; readonly transport: "stdio" | "http" }[];
        readonly skipped: readonly { readonly name: string; readonly reason: string }[];
        readonly notes: readonly string[];
    };
    readonly mcp_enabled: boolean;
    readonly host_extension_id: string | null;
    readonly desktop_extension_id: string | null;
    readonly needs_host_restart: boolean;
    readonly needs_desktop_restart: boolean;
    readonly ignored: readonly string[];
    readonly warnings: readonly string[];
}

export interface PluginInstallResult {
    readonly preview: PluginInstallPreview;
}

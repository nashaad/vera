import { isAbsolute } from "node:path";

import type { PluginInstallPreview, PluginInstallResult } from "../../../ui/src/protocol/plugin-install.ts";

export const PLUGIN_INSTALL_TASK_SERVICE = "Vera Plugin Install";
export const PLUGIN_INSTALL_TASK_FILE = "plugin-install.cjs";

export type PluginInstallPreviewDto = PluginInstallPreview;

export type PluginInstallTask =
    | { readonly kind: "preview"; readonly source: string }
    | { readonly kind: "install"; readonly source: string };

export type PluginInstallResultDto = PluginInstallResult;

export type PluginInstallTaskReply =
    | { readonly ok: true; readonly preview: PluginInstallPreviewDto; readonly result?: PluginInstallResultDto }
    | { readonly ok: false; readonly reason: string };

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function string(value: unknown, maxLength = 512): value is string {
    return typeof value === "string" && value.length <= maxLength;
}

function strings(value: unknown, maxItems = 2_000, maxLength = 512): value is string[] {
    return Array.isArray(value) && value.length <= maxItems && value.every((item) => string(item, maxLength));
}

function stringOrNull(value: unknown): value is string | null {
    return value === null || string(value);
}

function parsePreview(value: unknown): PluginInstallPreviewDto | undefined {
    const fields = record(value);
    if (fields === undefined || !string(fields.name, 256) || !string(fields.source_path, 8_192)
        || (fields.version !== undefined && !string(fields.version, 256))
        || (fields.description !== undefined && !string(fields.description, 8_192))
        || !stringOrNull(fields.host_extension_id) || !stringOrNull(fields.desktop_extension_id)
        || typeof fields.mcp_enabled !== "boolean" || typeof fields.needs_host_restart !== "boolean"
        || typeof fields.needs_desktop_restart !== "boolean" || !strings(fields.skills, 2_000, 256) || !strings(fields.agents, 2_000, 256)
        || !strings(fields.ignored, 2_000, 512) || !strings(fields.warnings, 2_000, 8_192)) return undefined;
    let replaces: PluginInstallPreviewDto["replaces"];
    if (fields.replaces === null) replaces = null;
    else {
        const replaced = record(fields.replaces);
        if (replaced === undefined || !string(replaced.name, 256) || !string(replaced.source_path, 8_192)) return undefined;
        replaces = { name: replaced.name, source_path: replaced.source_path };
    }
    const mcp = record(fields.mcp);
    if (mcp === undefined || !strings(mcp.notes, 2_000, 8_192)
        || !Array.isArray(mcp.servers) || mcp.servers.length > 2_000
        || !Array.isArray(mcp.skipped) || mcp.skipped.length > 2_000) return undefined;
    const servers: { name: string; transport: "stdio" | "http" }[] = [];
    for (const item of mcp.servers) {
        const server = record(item);
        if (server === undefined || !string(server.name, 256) || (server.transport !== "stdio" && server.transport !== "http")) return undefined;
        servers.push({ name: server.name, transport: server.transport });
    }
    const skipped: { name: string; reason: string }[] = [];
    for (const item of mcp.skipped) {
        const entry = record(item);
        if (entry === undefined || !string(entry.name, 256) || !string(entry.reason, 8_192)) return undefined;
        skipped.push({ name: entry.name, reason: entry.reason });
    }
    return {
        name: fields.name,
        ...(fields.version === undefined ? {} : { version: fields.version }),
        ...(fields.description === undefined ? {} : { description: fields.description }),
        source_path: fields.source_path,
        replaces,
        skills: fields.skills,
        agents: fields.agents,
        mcp: { servers, skipped, notes: mcp.notes },
        mcp_enabled: fields.mcp_enabled,
        host_extension_id: fields.host_extension_id,
        desktop_extension_id: fields.desktop_extension_id,
        needs_host_restart: fields.needs_host_restart,
        needs_desktop_restart: fields.needs_desktop_restart,
        ignored: fields.ignored,
        warnings: fields.warnings,
    };
}

function parseResult(value: unknown): PluginInstallResultDto | undefined {
    const fields = record(value);
    const preview = fields === undefined ? undefined : parsePreview(fields.preview);
    return preview === undefined ? undefined : { preview };
}

export function parsePluginInstallTask(value: unknown): PluginInstallTask | undefined {
    const fields = record(value);
    if (fields === undefined || (fields.kind !== "preview" && fields.kind !== "install")) return undefined;
    if (typeof fields.source !== "string" || !isAbsolute(fields.source) || fields.source.length > 8_192) return undefined;
    return { kind: fields.kind, source: fields.source };
}

export function parsePluginInstallTaskReply(value: unknown): PluginInstallTaskReply | undefined {
    const fields = record(value);
    if (fields === undefined) return undefined;
    if (fields.ok === false) {
        return typeof fields.reason === "string" && fields.reason.length > 0 && fields.reason.length <= 8_192
            ? { ok: false, reason: fields.reason }
            : undefined;
    }
    if (fields.ok !== true) return undefined;
    const preview = parsePreview(fields.preview);
    if (preview === undefined) return undefined;
    const result = fields.result === undefined ? undefined : parseResult(fields.result);
    if (fields.result !== undefined && result === undefined) return undefined;
    return { ok: true, preview, ...(result === undefined ? {} : { result }) };
}

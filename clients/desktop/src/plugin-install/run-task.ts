import { installPlugin } from "../../../../src/plugins/manager.ts";
import { needsDesktopRestart, needsHostRestart, summarizePluginComponents } from "../../../../src/plugins/components.ts";
import type { PluginInstallPreviewDto, PluginInstallTask, PluginInstallTaskReply } from "./task-protocol.ts";

function previewDto(preview: ReturnType<typeof installPlugin>["preview"]): PluginInstallPreviewDto {
    const summary = summarizePluginComponents(preview.components);
    return {
        name: preview.name,
        ...(preview.version === undefined ? {} : { version: preview.version }),
        ...(preview.description === undefined ? {} : { description: preview.description }),
        source_path: preview.source_path,
        replaces: preview.replaces,
        skills: summary.skills,
        agents: summary.agents,
        mcp: {
            servers: preview.mcp.servers.map(({ name, transport }) => ({ name, transport })),
            skipped: preview.mcp.skipped.map(({ name, reason }) => ({ name, reason })),
            notes: preview.mcp.notes,
        },
        mcp_enabled: preview.mcp_enabled,
        host_extension_id: summary.host_extension,
        desktop_extension_id: summary.desktop_extension,
        needs_host_restart: needsHostRestart(summary),
        needs_desktop_restart: needsDesktopRestart(summary),
        ignored: preview.ignored,
        warnings: preview.warnings,
    };
}

export function runPluginInstallTask(task: PluginInstallTask): PluginInstallTaskReply {
    try {
        const result = task.kind === "preview"
            ? installPlugin(task.source, { dry_run: true })
            : installPlugin(task.source);
        const preview = previewDto(result.preview);
        return {
            ok: true,
            preview,
            ...(task.kind === "install" ? { result: { preview } } : {}),
        };
    } catch (error) {
        if (error instanceof Error) return { ok: false, reason: error.message };
        return { ok: false, reason: "Vera could not install that plugin." };
    }
}

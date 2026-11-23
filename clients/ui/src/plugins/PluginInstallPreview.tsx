import type { PluginInstallPreview as Preview } from "../protocol/plugin-install.ts";
import { OverlaySheet } from "../overlays/OverlaySheet.tsx";

interface PluginInstallPreviewProps {
    readonly preview: Preview;
    readonly busy: boolean;
    readonly onCancel: () => void;
    readonly onInstall: () => void;
}

export function pluginRestartNotes(preview: Preview): readonly string[] {
    const notes: string[] = [];
    if (preview.needs_host_restart) {
        notes.push("Restart the resident host to apply extension code and MCP servers.");
    }
    if (preview.needs_desktop_restart) {
        notes.push("Reload desktop extensions or restart the app to load its desktop extension.");
    }
    return notes;
}

function names(values: readonly string[]): string {
    return values.length === 0 ? "None" : values.join(", ");
}

export function PluginInstallRefusal({ reason, onClose }: { readonly reason: string; readonly onClose: () => void }) {
    return (
        <OverlaySheet
            name="plugin-install-refused"
            title="Install plugin"
            className="plugins-sheet"
            onClose={onClose}
            foot={<button className="ghost-btn" type="button" onClick={onClose}>Close</button>}
        >
            <p className="plugin-sheet-description" role="alert">{reason}</p>
        </OverlaySheet>
    );
}

export function PluginInstallPreview({ preview, busy, onCancel, onInstall }: PluginInstallPreviewProps) {
    const restartNotes = pluginRestartNotes(preview);
    return (
        <OverlaySheet
            name="plugin-install"
            title={`Install ${preview.name}`}
            className="plugins-sheet"
            onClose={busy ? () => undefined : onCancel}
            foot={<>
                <button className="ghost-btn" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
                <button className="plugin-try" type="button" disabled={busy} onClick={onInstall}>{busy ? "Installing..." : "Install"}</button>
            </>}
        >
            <p className="plugin-sheet-description">{preview.description ?? "Review this plugin before installing it."}</p>
            <div className="plugin-install-details">
                <dl className="plugin-facts">
                    <dt>Folder</dt><dd className="plugin-code">{preview.source_path}</dd>
                    <dt>Version</dt><dd>{preview.version ?? "-"}</dd>
                    <dt>Skills</dt><dd>{names(preview.skills)}</dd>
                    <dt>Agents</dt><dd>{names(preview.agents)}</dd>
                    <dt>MCP servers</dt><dd>{names(preview.mcp.servers.map((server) => `${server.name} (${server.transport})`))}</dd>
                    <dt>MCP status</dt><dd>{preview.mcp_enabled ? "Enabled" : "Disabled"}</dd>
                    <dt>Host extension</dt><dd>{preview.host_extension_id ?? "None"}</dd>
                    <dt>Desktop extension</dt><dd>{preview.desktop_extension_id ?? "None"}</dd>
                </dl>
                {preview.replaces === null ? null : (
                    <p className="plugin-note">Replaces {preview.replaces.name} from <code>{preview.replaces.source_path}</code>.</p>
                )}
                {preview.mcp.skipped.map((server) => (
                    <p className="plugin-note" key={server.name}>Skipped {server.name}: {server.reason}</p>
                ))}
                {preview.mcp.notes.map((note, index) => <p className="plugin-note" key={`mcp:${index}`}>{note}</p>)}
                {preview.ignored.map((note, index) => <p className="plugin-note" key={`ignored:${index}`}>{note}</p>)}
                {preview.warnings.map((warning, index) => <p className="plugin-note" key={`warning:${index}`}>Warning: {warning}</p>)}
                {restartNotes.map((note) => <p className="plugin-note" key={note}>{note}</p>)}
            </div>
        </OverlaySheet>
    );
}

import type { DesktopBridge } from "../protocol/bridge.ts";
import type { DesktopExtensionEntry, ExtensionPreview } from "../protocol/extensions.ts";
import { useDesktopExtensions, type DesktopExtensionsState } from "./useDesktopExtensions.ts";

const NOT_LOADED = "Some task, page, or menu contributions are not loaded by this version of Vera.";

function themeLine(themes: readonly string[]): string {
    return themes.length === 0 ? "No themes" : `Themes: ${themes.join(", ")}`;
}

function ExtensionRow({ entry, state }: { readonly entry: DesktopExtensionEntry; readonly state: DesktopExtensionsState }) {
    return (
        <li>
            <div className="customize-card" data-desktop-extension={entry.id} data-enabled={entry.enabled}>
                <span className="customize-card-body">
                    <span className="customize-card-name">{entry.id}</span>
                    <span className="customize-card-desc">{themeLine(entry.themes)}</span>
                    <span className="customize-card-meta">
                        <span>{entry.version}</span>
                        {entry.hasUnavailableContributions ? <span>{NOT_LOADED}</span> : null}
                    </span>
                </span>
                <span className="customize-card-actions">
                    <button
                        type="button"
                        role="switch"
                        className="appearance-switch"
                        aria-checked={entry.enabled}
                        aria-label={entry.id}
                        title={entry.enabled ? "Turn off" : "Turn on"}
                        disabled={state.busy}
                        data-desktop-extension-switch={entry.id}
                        onClick={() => state.toggle(entry.id, !entry.enabled)}
                    >
                        <span className="appearance-switch-knob" />
                    </button>
                    <button
                        type="button"
                        className="ghost-btn"
                        disabled={state.busy}
                        data-desktop-extension-remove={entry.id}
                        onClick={() => state.remove(entry.id)}
                    >
                        Remove
                    </button>
                </span>
            </div>
        </li>
    );
}

function PreviewPanel({ preview, state }: { readonly preview: ExtensionPreview; readonly state: DesktopExtensionsState }) {
    return (
        <div className="customize-card customize-preview" data-desktop-extension-preview={preview.id}>
            <span className="customize-card-body">
                <span className="customize-card-name">{preview.id}</span>
                <span className="customize-card-desc">{themeLine(preview.themes)}</span>
                <span className="customize-card-meta">
                    <span>{preview.version}</span>
                    {preview.replaces === undefined ? null : <span>Replaces version {preview.replaces}.</span>}
                    {preview.hasUnavailableContributions ? <span>{NOT_LOADED}</span> : null}
                </span>
            </span>
            <span className="customize-card-actions">
                <button type="button" className="solid-btn" disabled={state.busy} data-desktop-extension-confirm onClick={state.confirm}>
                    Install
                </button>
                <button type="button" className="ghost-btn" disabled={state.busy} data-desktop-extension-cancel onClick={state.cancel}>
                    Cancel
                </button>
            </span>
        </div>
    );
}

export function DesktopExtensionsView({ state }: { readonly state: DesktopExtensionsState }) {
    const { list, preview, report, busy } = state;
    // Extensions included with Vera are always on and have no switch, so they are not listed.
    const entries = list.phase === "ready" ? list.extensions.filter((entry) => !entry.included) : [];
    return (
        <section data-desktop-extensions>
            <h2 className="section-title">
                Desktop extensions {list.phase === "ready" ? <span className="section-count">{entries.length}</span> : null}
            </h2>
            <p className="customize-note">Desktop extensions add to this app, such as themes. They apply to every session.</p>
            <div className="toolbar">
                <button type="button" className="ghost-btn" disabled={busy || preview !== undefined} data-desktop-extension-install onClick={state.choose}>
                    Install from file
                </button>
            </div>
            {preview === undefined ? null : <PreviewPanel preview={preview} state={state} />}
            {report === undefined ? null : (
                <p className="customize-note" role="status" data-tone={report.ok ? undefined : "danger"} data-desktop-extension-report={report.ok}>
                    {report.message}
                </p>
            )}
            {list.phase === "failed" ? <p className="customize-note" data-tone="danger">{list.reason}</p> : null}
            {list.phase === "ready" && entries.length === 0 ? <p className="customize-note">No desktop extensions are installed.</p> : null}
            {entries.length === 0 ? null : (
                <ul className="customize-grid">
                    {entries.map((entry) => <ExtensionRow key={entry.id} entry={entry} state={state} />)}
                </ul>
            )}
        </section>
    );
}

// The web client has no desktop bridge, and so no desktop extensions to list.
export function DesktopExtensions({ bridge }: { readonly bridge: DesktopBridge | undefined }) {
    const state = useDesktopExtensions(bridge);
    return bridge === undefined ? null : <DesktopExtensionsView state={state} />;
}

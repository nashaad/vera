import { useEffect } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import type { CatalogPreview, CatalogTheme } from "../protocol/extension-catalog.ts";
import { useDiscoverThemes, type DiscoverThemesState } from "./useDiscoverThemes.ts";

function Swatches({ palette }: { readonly palette: readonly string[] }) {
    return (
        <span className="catalog-swatches" aria-hidden="true">
            {palette.map((color, index) => <span key={index} className="catalog-swatch" style={{ background: color }} />)}
        </span>
    );
}

function ThemeCard({ theme, state }: { readonly theme: CatalogTheme; readonly state: DiscoverThemesState }) {
    const fetching = state.fetching === theme.id;
    return (
        <li>
            <div className="customize-card" data-catalog-theme={theme.id} data-installed={theme.installed}>
                <span className="customize-card-body">
                    <span className="customize-card-name">{theme.name}</span>
                    <Swatches palette={theme.palette} />
                    <span className="customize-card-meta">
                        <span>{theme.version}</span>
                        {theme.installed ? <span className="customize-badge" data-catalog-installed>Installed</span> : null}
                    </span>
                </span>
                {theme.installed ? null : (
                    <span className="customize-card-actions">
                        <button
                            type="button"
                            className="ghost-btn"
                            disabled={state.fetching !== undefined || state.preview !== undefined}
                            data-catalog-install={theme.id}
                            onClick={() => state.start(theme.id)}
                        >
                            {fetching ? "Downloading…" : "Install"}
                        </button>
                    </span>
                )}
            </div>
        </li>
    );
}

// Escape cancels the preview unless Install is already writing it.
function PreviewBar({ preview, state }: { readonly preview: CatalogPreview; readonly state: DiscoverThemesState }) {
    const { keeping, cancel } = state;
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || keeping) return;
            event.preventDefault();
            cancel();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [keeping, cancel]);
    return (
        <div className="catalog-bar" role="region" aria-label="Theme preview" data-catalog-bar={preview.id}>
            <span className="catalog-bar-text">
                Previewing {preview.name} {preview.version}.{preview.replaces === undefined ? "" : ` Replaces version ${preview.replaces}.`}
            </span>
            <span className="customize-card-actions">
                <button type="button" className="solid-btn" disabled={keeping} data-catalog-keep onClick={state.keep}>
                    Install
                </button>
                <button type="button" className="ghost-btn" disabled={keeping} data-catalog-cancel onClick={state.cancel}>
                    Cancel
                </button>
            </span>
        </div>
    );
}

export function DiscoverThemesView({ state }: { readonly state: DiscoverThemesState }) {
    const { list, preview, failure } = state;
    if (list.phase === "loading") return <p className="customize-note" data-catalog-loading>Reading the catalog…</p>;
    if (list.phase === "unavailable") return <p className="customize-note" data-catalog-unavailable>The catalog is not available in this build.</p>;
    if (list.phase === "failed") {
        return (
            <>
                <p className="customize-note" data-tone="danger" data-catalog-failed>{list.reason}</p>
                <button type="button" className="ghost-btn" data-catalog-retry onClick={state.retry}>Retry</button>
            </>
        );
    }
    return (
        <section data-catalog>
            <h2 className="section-title">
                Themes <span className="section-count">{list.themes.length}</span>
            </h2>
            <p className="customize-note">Installing a theme shows it in this window first, and you can cancel before it is kept.</p>
            {failure === undefined ? null : <p className="customize-note" role="status" data-tone="danger" data-catalog-report>{failure}</p>}
            {list.themes.length === 0 ? <p className="customize-note">The catalog has no themes for this version of Vera.</p> : null}
            {list.themes.length === 0 ? null : (
                <ul className="customize-grid">
                    {list.themes.map((theme) => <ThemeCard key={theme.id} theme={theme} state={state} />)}
                </ul>
            )}
            {preview === undefined ? null : <PreviewBar preview={preview} state={state} />}
        </section>
    );
}

export function DiscoverThemes({ bridge }: { readonly bridge: DesktopBridge }) {
    return <DiscoverThemesView state={useDiscoverThemes(bridge)} />;
}

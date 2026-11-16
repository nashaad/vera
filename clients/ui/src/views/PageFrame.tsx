import { useState } from "react";

import { pageAt } from "../browser/address.ts";
import { ExternalIcon, RefreshIcon } from "../components/Icons.tsx";
import { usePageLinks } from "../pagepane/PageLinks.tsx";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { AnnexFrame } from "./AnnexFrame.tsx";

interface PageFrameProps {
    // The annex path of the page this frame is held to.
    readonly path: string;
    // What the frame shows: the page's path with any query. Defaults to the page bare.
    readonly shown?: string;
}

// One extension page in a frame with Reload and Open in your browser. The right pane and the main area both draw it.
export function PageFrame({ path, shown = path }: PageFrameProps) {
    const { annex } = usePageLinks();
    const [round, setRound] = useState(0);
    const page = annex === undefined ? undefined : pageAt(shown, annex.pages);
    return (
        <div className="browser">
            <div className="browser-bar">
                <button type="button" className="icon-button" aria-label="Reload" title="Reload" onClick={() => setRound((current) => current + 1)}>
                    <RefreshIcon />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Open in your browser"
                    title="Open in your browser"
                    onClick={() => void (window.veraDesktop as DesktopBridge | undefined)?.openAnnexPage(shown)}
                >
                    <ExternalIcon />
                </button>
            </div>
            {annex === undefined ? <p className="view-empty">Finding Vera's pages…</p> : null}
            {annex !== undefined && page?.path !== path ? (
                <div className="browser-missing">
                    <h3>Not found</h3>
                    <p>The annex serves nothing at {path}.</p>
                </div>
            ) : null}
            {annex !== undefined && page?.path === path ? <AnnexFrame annex={annex} entry={shown} title={page.label} round={round} /> : null}
        </div>
    );
}

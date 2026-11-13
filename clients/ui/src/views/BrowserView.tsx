import { useState, type KeyboardEvent } from "react";

import { annexHost, currentEntry, displayAddress, isAnnexPath, pageAt, resolveAddress } from "../browser/address.ts";
import { browserHistory, useBrowserHistory } from "../browser/store.ts";
import { useAnnexPages } from "../browser/useAnnexPages.ts";
import { ArrowLeftIcon, ArrowRightIcon, ExternalIcon, HomeIcon, RefreshIcon } from "../components/Icons.tsx";
import type { AnnexPage, AnnexPagesAnswer, DesktopBridge } from "../protocol/bridge.ts";
import { useViewEnvironment, type ViewProps } from "./env.tsx";

const PLACEHOLDER = "Search Vera's pages or enter an address";

// The pages the annex serves on this machine, in a frame under one tab row. The annex drops its
// own menu when framed, so this row is the only way between pages.
export function BrowserView({ visible }: ViewProps) {
    const { connection } = useViewEnvironment();
    const history = useBrowserHistory();
    const entry = currentEntry(history);
    const { result, reload } = useAnnexPages(visible, connection.ready?.pid);
    const annex = result?.ok === true ? result : undefined;
    const [typed, setTyped] = useState<string | undefined>(undefined);
    const [frameRound, setFrameRound] = useState(0);

    const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter" && typed !== undefined) {
            browserHistory.browse(resolveAddress(typed, annex?.url, annex?.pages ?? []));
            setTyped(undefined);
            event.currentTarget.blur();
        } else if (event.key === "Escape") {
            event.preventDefault();
            setTyped(undefined);
            event.currentTarget.blur();
        }
    };

    return (
        <div className="browser">
            <div className="browser-bar">
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Back"
                    title="Back"
                    disabled={history.at === 0}
                    onClick={() => browserHistory.step(-1)}
                >
                    <ArrowLeftIcon />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Forward"
                    title="Forward"
                    disabled={history.at >= history.entries.length - 1}
                    onClick={() => browserHistory.step(1)}
                >
                    <ArrowRightIcon />
                </button>
                <input
                    className="browser-address"
                    aria-label="Address"
                    value={typed ?? displayAddress(entry, annex?.url)}
                    placeholder={PLACEHOLDER}
                    spellCheck={false}
                    onChange={(event) => setTyped(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() => setTyped(undefined)}
                    onKeyDown={onKey}
                />
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Reload"
                    title="Reload"
                    onClick={() => {
                        reload();
                        setFrameRound((round) => round + 1);
                    }}
                >
                    <RefreshIcon />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Open in your browser"
                    title="Open in your browser"
                    disabled={annex === undefined || !isAnnexPath(entry)}
                    onClick={() => void (window.veraDesktop as DesktopBridge | undefined)?.openAnnexPage(entry)}
                >
                    <ExternalIcon />
                </button>
            </div>
            {result === undefined ? <p className="view-empty">Finding Vera's pages…</p> : null}
            {result !== undefined && !result.ok ? <p className="view-note" role="alert">{result.reason}</p> : null}
            {annex === undefined ? null : <BrowserBody annex={annex} entry={entry} frameRound={frameRound} />}
        </div>
    );
}

function BrowserBody({ annex, entry, frameRound }: { readonly annex: AnnexPagesAnswer; readonly entry: string; readonly frameRound: number }) {
    if (entry === "") return <StartPage annex={annex} />;
    if (!isAnnexPath(entry)) {
        return <p className="view-empty">Only the pages Vera serves on this machine open here, and “{entry}” is not one of them.</p>;
    }
    const page = pageAt(entry, annex.pages);
    return (
        <>
            <nav className="browser-tabs" aria-label="Vera's pages">
                <button
                    type="button"
                    className="browser-tab"
                    aria-label="All of Vera's pages"
                    title="All of Vera's pages"
                    onClick={() => browserHistory.browse("")}
                >
                    <HomeIcon />
                </button>
                {annex.pages.map((candidate) => (
                    <button
                        key={candidate.path}
                        type="button"
                        className="browser-tab"
                        aria-current={candidate === page ? "page" : undefined}
                        onClick={() => browserHistory.browse(candidate.path)}
                    >
                        {candidate.label}
                    </button>
                ))}
            </nav>
            {page === undefined ? (
                <div className="browser-missing">
                    <h3>Not found</h3>
                    <p>The annex serves nothing at {entry}. Pick a page above.</p>
                </div>
            ) : (
                <iframe
                    key={`${annex.url}${entry}:${frameRound}`}
                    className="browser-frame"
                    title={page.label}
                    src={`${annex.url}${entry.slice(1)}`}
                    sandbox="allow-scripts allow-same-origin allow-forms"
                />
            )}
        </>
    );
}

function StartPage({ annex }: { readonly annex: AnnexPagesAnswer }) {
    const own = annex.pages.filter((page) => page.extensionId === undefined);
    const added = annex.pages.filter((page) => page.extensionId !== undefined);
    return (
        <div className="browser-start">
            <h3>Vera</h3>
            {own.map((page) => <PageLink key={page.path} page={page} />)}
            <h3>From extensions</h3>
            {added.length === 0 ? <p className="browser-start-note">{annex.extensionsFailure ?? "No extension adds a page."}</p> : null}
            {added.map((page) => <PageLink key={page.path} page={page} />)}
            <p className="browser-start-note">Served on this machine at {annexHost(annex.url)} while the host runs.</p>
        </div>
    );
}

function PageLink({ page }: { readonly page: AnnexPage }) {
    return (
        <button type="button" className="browser-link" onClick={() => browserHistory.browse(page.path)}>
            <span className="browser-link-label">
                {page.label}
                {page.extensionId === undefined ? null : <span className="browser-link-from">{page.extensionId}</span>}
            </span>
            <span className="browser-link-path">{page.path}</span>
            {page.about === undefined ? null : <span className="browser-link-about">{page.about}</span>}
        </button>
    );
}

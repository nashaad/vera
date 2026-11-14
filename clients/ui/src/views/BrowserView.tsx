import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { annexHost, currentEntry, displayAddress, isAnnexPath, pageAt, resolveAddress } from "../browser/address.ts";
import { browserHistory, useBrowserHistory } from "../browser/store.ts";
import { useAnnexPages } from "../browser/useAnnexPages.ts";
import { useNativeBrowser } from "../browser/useNativeBrowser.ts";
import { BROWSER_TAB_LIMIT } from "../browser/native-types.ts";
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
    const native = useNativeBrowser(visible);
    const activeTab = native.state.tabs.find((tab) => tab.id === native.state.active);
    const previousEntry = useRef(entry);

    useEffect(() => {
        if (previousEntry.current !== entry) void native.command("select", null);
        previousEntry.current = entry;
    }, [entry, native.command]);

    const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter" && typed !== undefined) {
            const address = resolveAddress(typed, annex?.url, annex?.pages ?? []);
            if (address === "" || isAnnexPath(address)) {
                browserHistory.browse(address);
                void native.command("select", null);
            }
            else if (native.state.active === null) void native.command("open", typed);
            else void native.command("navigate", typed);
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
                    disabled={activeTab === undefined ? history.at === 0 : !activeTab.back}
                    onClick={() => activeTab === undefined ? browserHistory.step(-1) : void native.command("back")}
                >
                    <ArrowLeftIcon />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Forward"
                    title="Forward"
                    disabled={activeTab === undefined ? history.at >= history.entries.length - 1 : !activeTab.forward}
                    onClick={() => activeTab === undefined ? browserHistory.step(1) : void native.command("forward")}
                >
                    <ArrowRightIcon />
                </button>
                <input
                    className="browser-address"
                    aria-label="Address"
                    value={typed ?? (activeTab === undefined ? displayAddress(entry, annex?.url) : activeTab.url)}
                    placeholder={PLACEHOLDER}
                    disabled={native.clearing}
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
                        if (activeTab === undefined) {
                            reload();
                            setFrameRound((round) => round + 1);
                        } else void native.command("reload");
                    }}
                >
                    <RefreshIcon />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Open in your browser"
                    title="Open in your browser"
                    disabled={activeTab === undefined && (annex === undefined || !isAnnexPath(entry))}
                    onClick={() => activeTab === undefined ? void (window.veraDesktop as DesktopBridge | undefined)?.openAnnexPage(entry) : void native.command("external")}
                >
                    <ExternalIcon />
                </button>
            </div>
            <nav className="browser-tabs" aria-label="Browser tabs">
                <button type="button" className="browser-tab" aria-current={native.state.active === null ? "page" : undefined} onClick={() => void native.command("select", null)}>Vera</button>
                {native.state.tabs.map((tab) => <span key={tab.id}>
                    <button type="button" className="browser-tab" aria-current={native.state.active === tab.id ? "page" : undefined} onClick={() => void native.command("select", tab.id)}>{tab.title}</button>
                    <button type="button" className="browser-tab" aria-label={`Close ${tab.title}`} onClick={() => void native.command("close", tab.id)}>×</button>
                </span>)}
                <button type="button" className="browser-tab" aria-label="New tab" disabled={native.state.tabs.length >= BROWSER_TAB_LIMIT} onClick={() => void native.command("open")}>+</button>
            </nav>
            <div className="browser-controls">
                <label><input type="checkbox" role="switch" aria-label="Browser tools" checked={native.state.toolsEnabled} disabled={!native.state.toolsAvailable} onChange={(event) => void native.command("tools", event.target.checked)} /> Browser tools {native.state.toolsEnabled ? "on" : "off"}</label>
            </div>
            {activeTab === undefined && result === undefined ? <p className="view-empty">Finding Vera's pages…</p> : null}
            {activeTab === undefined && result !== undefined && !result.ok ? <p className="view-note" role="alert">{result.reason}</p> : null}
            {activeTab === undefined && annex !== undefined ? <BrowserBody annex={annex} entry={entry} frameRound={frameRound} /> : null}
            {activeTab === undefined ? null : <div className="browser-frame" ref={native.surface} />}
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

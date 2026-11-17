import { useEffect, useState, type KeyboardEvent } from "react";

import { annexHost, currentEntry, displayAddress, isAnnexPath, pageAt, resolveAddress } from "../browser/address.ts";
import { nativeCommand } from "../browser/native.ts";
import { openAddressIn, showAnnexIn } from "../browser/open.ts";
import { browserSlots, CONTAINER_SLOT, useSlot, useSlotStore } from "../browser/slots.ts";
import { useAnnexPages } from "../browser/useAnnexPages.ts";
import { useNativeSurface } from "../browser/useNativeSurface.ts";
import { ArrowLeftIcon, ArrowRightIcon, ExternalIcon, HomeIcon, RefreshIcon } from "../components/Icons.tsx";
import type { AnnexPage, AnnexPagesAnswer, DesktopBridge } from "../protocol/bridge.ts";
import { BrowserCommands } from "../extensions/BrowserCommands.tsx";
import { usePaneTab, usePublishTabTitle } from "../workbench/tab-context.tsx";
import { AnnexFrame } from "./AnnexFrame.tsx";
import { useViewEnvironment, type ViewProps } from "./env.tsx";

const PLACEHOLDER = "Search Vera's pages or enter an address";

// One page: one of the pages the annex serves on this machine, in a frame, or a web page the shell
// draws over the frame. In the right pane each Browser tab is one of these; elsewhere there is one.
export function BrowserView({ visible }: ViewProps) {
    const tab = usePaneTab();
    const key = tab ?? CONTAINER_SLOT;
    const { connection } = useViewEnvironment();
    const slot = useSlot(key);
    const { native } = useSlotStore();
    const page = slot.page === undefined ? undefined : native?.tabs.find((candidate) => candidate.id === slot.page);
    const entry = currentEntry(slot.history);
    const { result, reload } = useAnnexPages(visible, connection.ready?.pid);
    const annex = result?.ok === true ? result : undefined;
    const [typed, setTyped] = useState<string | undefined>(undefined);
    const [frameRound, setFrameRound] = useState(0);
    const [error, setError] = useState<string | undefined>(undefined);
    const surface = useNativeSurface(visible && page !== undefined);
    usePublishTabTitle(page?.title);

    // The shell draws one page at a time: the one this view shows, or none for one of Vera's pages.
    useEffect(() => {
        if (visible) void nativeCommand("select", slot.page ?? null);
    }, [visible, slot.page]);

    const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter" && typed !== undefined) {
            const address = resolveAddress(typed, annex?.url, annex?.pages ?? []);
            if (address === "" || isAnnexPath(address)) void showAnnexIn(key, address);
            else if (page === undefined) void openAddressIn(key, typed);
            else void nativeCommand("navigate", typed);
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
                    disabled={page === undefined ? slot.history.at === 0 : !page.back}
                    onClick={() => page === undefined ? browserSlots.step(key, -1) : void nativeCommand("back")}
                >
                    <ArrowLeftIcon />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Forward"
                    title="Forward"
                    disabled={page === undefined ? slot.history.at >= slot.history.entries.length - 1 : !page.forward}
                    onClick={() => page === undefined ? browserSlots.step(key, 1) : void nativeCommand("forward")}
                >
                    <ArrowRightIcon />
                </button>
                <input
                    className="browser-address"
                    aria-label="Address"
                    value={typed ?? (page === undefined ? displayAddress(entry, annex?.url) : page.url)}
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
                    data-page-reload={visible && (page !== undefined || (annex !== undefined && pageAt(entry, annex.pages) !== undefined)) ? "" : undefined}
                    data-page-native={page !== undefined ? "" : undefined}
                    onClick={() => {
                        if (page === undefined) {
                            reload();
                            setFrameRound((round) => round + 1);
                        } else void nativeCommand("reload");
                    }}
                >
                    <RefreshIcon />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Open in your browser"
                    title="Open in your browser"
                    disabled={page === undefined && (annex === undefined || !isAnnexPath(entry))}
                    onClick={() => page === undefined ? void (window.veraDesktop as DesktopBridge | undefined)?.openAnnexPage(entry) : void nativeCommand("external")}
                >
                    <ExternalIcon />
                </button>
                <BrowserCommands hasPage={visible && (page !== undefined || (annex !== undefined && pageAt(entry, annex.pages) !== undefined))} onError={setError} />
            </div>
            <div className="browser-controls">
                <label><input type="checkbox" role="switch" aria-label="Browser tools" checked={native?.toolsEnabled ?? false} disabled={!(native?.toolsAvailable ?? false)} onChange={(event) => void nativeCommand("tools", event.target.checked)} /> Browser tools {native?.toolsEnabled ? "on" : "off"}</label>
            </div>
            {error === undefined ? null : <p role="alert" className="view-note">{error}</p>}
            {page === undefined && result === undefined ? <p className="view-empty">Finding Vera's pages…</p> : null}
            {page === undefined && result !== undefined && !result.ok ? <p className="view-note" role="alert">{result.reason}</p> : null}
            {page === undefined && annex !== undefined ? <BrowserBody annex={annex} entry={entry} frameRound={frameRound} frameName={`browser-${key}`} browse={(next) => browserSlots.browse(key, next)} /> : null}
            {page === undefined ? null : <div className="browser-frame" ref={surface} />}
        </div>
    );
}

interface BrowserBodyProps {
    readonly annex: AnnexPagesAnswer;
    readonly entry: string;
    readonly frameRound: number;
    readonly frameName: string;
    readonly browse: (entry: string) => void;
}

function BrowserBody({ annex, entry, frameRound, frameName, browse }: BrowserBodyProps) {
    if (entry === "") return <StartPage annex={annex} browse={browse} />;
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
                    onClick={() => browse("")}
                >
                    <HomeIcon />
                </button>
                {annex.pages.map((candidate) => (
                    <button
                        key={candidate.path}
                        type="button"
                        className="browser-tab"
                        aria-current={candidate === page ? "page" : undefined}
                        onClick={() => browse(candidate.path)}
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
                <AnnexFrame annex={annex} entry={entry} title={page.label} round={frameRound} name={frameName} />
            )}
        </>
    );
}

function StartPage({ annex, browse }: { readonly annex: AnnexPagesAnswer; readonly browse: (entry: string) => void }) {
    const own = annex.pages.filter((page) => page.extensionId === undefined);
    const added = annex.pages.filter((page) => page.extensionId !== undefined);
    return (
        <div className="browser-start">
            <h3>Vera</h3>
            {own.map((page) => <PageLink key={page.path} page={page} browse={browse} />)}
            <h3>From extensions</h3>
            {added.length === 0 ? <p className="browser-start-note">{annex.extensionsFailure ?? "No extension adds a page."}</p> : null}
            {added.map((page) => <PageLink key={page.path} page={page} browse={browse} />)}
            <p className="browser-start-note">Served on this machine at {annexHost(annex.url)} while the host runs.</p>
        </div>
    );
}

function PageLink({ page, browse }: { readonly page: AnnexPage; readonly browse: (entry: string) => void }) {
    return (
        <button type="button" className="browser-link" onClick={() => browse(page.path)}>
            <span className="browser-link-label">
                {page.label}
                {page.extensionId === undefined ? null : <span className="browser-link-from">{page.extensionId}</span>}
            </span>
            <span className="browser-link-path">{page.path}</span>
            {page.about === undefined ? null : <span className="browser-link-about">{page.about}</span>}
        </button>
    );
}

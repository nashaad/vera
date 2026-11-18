import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import { openAnnexAddress } from "../browser/annex-address.ts";
import { addressRequestVersion, subscribeAddressRequest, takeAddressRequest } from "../browser/address-request.ts";
import { historyRequestVersion, subscribeHistoryRequest, takeHistoryRequest } from "../browser/history-request.ts";
import { nativeCommand } from "../browser/native.ts";
import { openAddressIn } from "../browser/open.ts";
import { CONTAINER_SLOT, useSlot, useSlotStore } from "../browser/slots.ts";
import { useNativeSurface } from "../browser/useNativeSurface.ts";
import { ArrowLeftIcon, ArrowRightIcon, ClockIcon, ExternalIcon, RefreshIcon } from "../components/Icons.tsx";
import { BrowserCommands } from "../extensions/BrowserCommands.tsx";
import { usePageLinks } from "../pagepane/PageLinks.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { usePaneTab, usePublishTabTitle } from "../workbench/tab-context.tsx";
import { BrowserHistory } from "./BrowserHistory.tsx";
import type { ViewProps } from "./env.tsx";

const PLACEHOLDER = "Enter a web address";

export function BrowserView({ visible }: ViewProps) {
    const tab = usePaneTab();
    const key = tab ?? CONTAINER_SLOT;
    const addressRef = useRef<HTMLInputElement>(null);
    const addressRequest = useSyncExternalStore(subscribeAddressRequest, addressRequestVersion, addressRequestVersion);
    const host = useWorkbench();
    const { annex } = usePageLinks();
    const slot = useSlot(key);
    const { native } = useSlotStore();
    const page = slot.page === undefined ? undefined : native?.tabs.find((candidate) => candidate.id === slot.page);
    const [typed, setTyped] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [focusClear, setFocusClear] = useState(0);
    const historyRequest = useSyncExternalStore(subscribeHistoryRequest, historyRequestVersion, historyRequestVersion);
    const surface = useNativeSurface(visible && !historyOpen && page !== undefined);
    usePublishTabTitle(page?.title);

    useEffect(() => {
        if (!visible || !takeAddressRequest(key)) return;
        addressRef.current?.focus();
        addressRef.current?.select();
    }, [visible, key, addressRequest]);

    useEffect(() => {
        if (!visible || !takeHistoryRequest()) return;
        setHistoryOpen(true);
        setFocusClear((value) => value + 1);
    }, [visible, historyRequest]);

    useEffect(() => {
        if (visible) void nativeCommand("select", slot.page ?? null);
    }, [visible, slot.page]);

    const open = (value: string): void => {
        if (value.trim() === "" || openAnnexAddress(host, annex, value)) return;
        if (page === undefined) void openAddressIn(key, value);
        else void nativeCommand("select", page.id).then((selected) => {
            if (selected?.active === page.id) void nativeCommand("navigate", value);
        });
    };

    const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") {
            setHistoryOpen(false);
            open(event.currentTarget.value);
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
                    disabled={page === undefined || !page.back}
                    onClick={() => {
                        setHistoryOpen(false);
                        void nativeCommand("back");
                    }}
                >
                    <ArrowLeftIcon />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Forward"
                    title="Forward"
                    disabled={page === undefined || !page.forward}
                    onClick={() => {
                        setHistoryOpen(false);
                        void nativeCommand("forward");
                    }}
                >
                    <ArrowRightIcon />
                </button>
                <input
                    ref={addressRef}
                    className="browser-address"
                    aria-label="Address"
                    value={typed ?? page?.url ?? ""}
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
                    disabled={page === undefined}
                    data-page-reload={visible && page !== undefined ? "" : undefined}
                    data-page-native={page !== undefined ? "" : undefined}
                    onClick={() => void nativeCommand("reload")}
                >
                    <RefreshIcon />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Open in your browser"
                    title="Open in your browser"
                    disabled={page === undefined}
                    onClick={() => void nativeCommand("external")}
                >
                    <ExternalIcon />
                </button>
                {window.veraDesktop === undefined ? null : (
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="History"
                        aria-pressed={historyOpen}
                        title="History"
                        onClick={() => {
                            setFocusClear(0);
                            setHistoryOpen((open) => !open);
                        }}
                    >
                        <ClockIcon />
                    </button>
                )}
                <BrowserCommands hasPage={visible && page !== undefined} onError={setError} />
                <label className="browser-tools-switch">
                    <button type="button" role="switch" className="appearance-switch" aria-label="Browser tools" aria-checked={native?.toolsEnabled ?? false} title={`Browser tools ${native?.toolsEnabled ? "on" : "off"}`} disabled={!(native?.toolsAvailable ?? false)} onClick={() => void nativeCommand("tools", !native?.toolsEnabled)}>
                        <span className="appearance-switch-knob" />
                    </button>
                    <span className="browser-tools-label">Browser tools {native?.toolsEnabled ? "on" : "off"}</span>
                </label>
            </div>
            {error === undefined ? null : <p role="alert" className="view-note">{error}</p>}
            {historyOpen ? (
                <BrowserHistory focusClear={focusClear} open={(url) => {
                    setHistoryOpen(false);
                    open(url);
                }} />
            ) : null}
            <div className="browser-page" hidden={historyOpen}>
                {page === undefined ? <p className="view-empty">Enter an address to open a website.</p> : <div className="browser-frame" ref={surface} />}
            </div>
        </div>
    );
}

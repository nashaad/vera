import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { ChevronDownIcon, XIcon } from "../components/Icons.tsx";
import { FIND_CLOSE_COMMAND, FIND_SHORTCUT } from "../commands/keys.ts";
import { closeFindOnSearchEntry } from "../commands/navigation-commands.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import { useRouter } from "../pages/router.tsx";
import { clearFindHighlights, scrollFindMatch, showFindHighlights } from "./highlights.ts";
import { findMatches, moveFindIndex, type FindMatches } from "./matches.ts";
import { observeFindTree, type FindObserver } from "./observer.ts";
import { captureFindSelection, preserveFindIndex, type FindSelection } from "./selection.ts";
import { findElement } from "./tree.ts";
import { isSearchResultFindReady, isSearchResultFindRequest, PendingSearchResultFind, selectSearchResultMatch, type SearchResultFindRequest } from "./search-result.ts";

interface FindCount {
    readonly current: number;
    readonly total: number;
    readonly capped: boolean;
}

type FindSurface = "main" | "browser";

const EMPTY_COUNT: FindCount = { current: 0, total: 0, capped: false };
const EMPTY_MATCHES: FindMatches = { ranges: [], capped: false };
const TYPING_DELAY_MS = 180;
const MUTATION_DELAY_MS = 500;

function currentSlot(): HTMLElement | null {
    return document.querySelector<HTMLElement>("[data-window-find-slot]");
}

function mayChangeSlot(record: MutationRecord): boolean {
    if (record.type === "attributes") return record.attributeName === "data-window-find-slot";
    if (record.type !== "childList") return false;
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof Element)) continue;
        if (node.matches(".window-find-slot") || node.querySelector(".window-find-slot") !== null) return true;
    }
    return false;
}

export function WindowFind({ commands }: { readonly commands: CommandRegistry }) {
    const route = useRouter().route;
    const routeKind = route.kind;
    const previousRouteKind = useRef(routeKind);
    const [opened, setOpened] = useState(false);
    const [query, setQuery] = useState("");
    const [count, setCount] = useState<FindCount>(EMPTY_COUNT);
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    const [focusRequest, setFocusRequest] = useState(0);
    const openedRef = useRef(false);
    const queryRef = useRef("");
    const surfaceRef = useRef<FindSurface>("main");
    const matchesRef = useRef<FindMatches>(EMPTY_MATCHES);
    const indexRef = useRef(-1);
    const selectionRef = useRef<FindSelection | undefined>(undefined);
    const previousRef = useRef<HTMLElement | null>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const slotRef = useRef<HTMLElement | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const observerRef = useRef<FindObserver | null>(null);
    const scrollRef = useRef(false);
    const focusPending = useRef(false);
    const pendingResult = useRef(new PendingSearchResultFind());
    const openCommand = useRef<(target: unknown) => void>(() => {});

    const cancelScan = (): void => {
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        timerRef.current = undefined;
        scrollRef.current = false;
    };

    const clearMatches = (): void => {
        clearFindHighlights();
        matchesRef.current = EMPTY_MATCHES;
        indexRef.current = -1;
        selectionRef.current = undefined;
        setCount(EMPTY_COUNT);
    };

    const scan = (scroll: boolean, result?: SearchResultFindRequest, preservePosition?: () => void): void => {
        if (!openedRef.current) return;
        const text = queryRef.current;
        if (surfaceRef.current === "browser") {
            window.veraDesktop?.searchBrowserFind(text);
            return;
        }
        if (text === "") {
            clearMatches();
            return;
        }
        const root = document.querySelector<HTMLElement>(".app");
        if (root === null) {
            clearMatches();
            return;
        }
        observerRef.current?.refresh();
        const found = findMatches(root, text, barRef.current ?? undefined);
        const selection = result === undefined ? undefined : selectSearchResultMatch(found.ranges, result);
        matchesRef.current = found;
        indexRef.current = selection?.index ?? preserveFindIndex(selectionRef.current, found.ranges);
        selectionRef.current = captureFindSelection(found.ranges[indexRef.current], indexRef.current);
        setCount({ current: indexRef.current + 1, total: found.ranges.length, capped: found.capped });
        showFindHighlights(found.ranges, indexRef.current);
        const selected = found.ranges[indexRef.current];
        if (scroll && selected !== undefined && (selection === undefined || selection.inSession)) {
            scrollFindMatch(selected);
            if (selection?.inSession === true) preservePosition?.();
        }
    };

    const scheduleScan = (scroll: boolean, restart: boolean): void => {
        scrollRef.current ||= scroll;
        if (restart && timerRef.current !== undefined) {
            clearTimeout(timerRef.current);
            timerRef.current = undefined;
        }
        if (timerRef.current !== undefined) return;
        timerRef.current = setTimeout(() => {
            timerRef.current = undefined;
            const shouldScroll = scrollRef.current;
            scrollRef.current = false;
            scan(shouldScroll);
        }, restart ? TYPING_DELAY_MS : MUTATION_DELAY_MS);
    };

    const updateSlot = (): void => {
        const next = currentSlot();
        if (slotRef.current === next) return;
        if (barRef.current?.contains(document.activeElement)) focusPending.current = true;
        slotRef.current = next;
        setSlot(next);
    };

    openCommand.current = (target: unknown): void => {
        if (isSearchResultFindRequest(target)) {
            pendingResult.current.set(target);
            return;
        }
        if (isSearchResultFindReady(target)) {
            const result = pendingResult.current.take(target.agentId);
            if (result === undefined || route.kind !== "session" || route.agentId !== result.agentId) return;
            openCommand.current("main");
            cancelScan();
            queryRef.current = result.query;
            setQuery(result.query);
            clearMatches();
            scan(true, result, target.preservePosition);
            return;
        }
        pendingResult.current.clear();
        const barFocused = barRef.current?.contains(document.activeElement) === true;
        const next: FindSurface = target === "browser" ? "browser" : barFocused ? surfaceRef.current : "main";
        const changed = !openedRef.current || next !== surfaceRef.current;
        if (changed && surfaceRef.current === "browser") window.veraDesktop?.closeBrowserFind(false);
        if (changed && next === "main" && !barFocused) {
            const active = document.activeElement;
            previousRef.current = active instanceof HTMLElement ? active : null;
        }
        openedRef.current = true;
        surfaceRef.current = next;
        if (changed) {
            cancelScan();
            clearMatches();
            if (next === "browser") window.veraDesktop?.searchBrowserFind(queryRef.current);
            else if (queryRef.current !== "") scheduleScan(true, true);
        } else if (next === "browser" && target === "browser") {
            window.veraDesktop?.searchBrowserFind(queryRef.current);
        }
        updateSlot();
        focusPending.current = true;
        setOpened(true);
        setFocusRequest((value) => value + 1);
    };

    useEffect(() => {
        if (window.veraDesktop === undefined) return;
        const unregisterOpen = commands.register({ id: FIND_SHORTCUT.command, title: FIND_SHORTCUT.label, run: (target) => openCommand.current(target) });
        const unregisterClose = commands.register({ id: FIND_CLOSE_COMMAND, title: "Close Find", paletteHidden: true, run: () => close(false) });
        return () => {
            unregisterClose();
            unregisterOpen();
        };
    }, [commands]);

    useLayoutEffect(() => {
        closeFindOnSearchEntry(commands, previousRouteKind.current, routeKind);
        previousRouteKind.current = routeKind;
        pendingResult.current.routeChanged(route);
    }, [commands, route, routeKind]);

    useLayoutEffect(() => {
        if (!opened || !focusPending.current || inputRef.current === null) return;
        focusPending.current = false;
        inputRef.current.focus();
        inputRef.current.select();
    }, [opened, focusRequest, slot]);

    useEffect(() => {
        if (!opened) return;
        const root = document.querySelector<HTMLElement>(".app");
        if (root === null) return;
        const observer = observeFindTree(root, (records) => {
            if (records.some(mayChangeSlot)) updateSlot();
            if (surfaceRef.current !== "main" || queryRef.current === "") return;
            const relevant = records.some((record) => {
                const element = findElement(record.target);
                if (element === null || barRef.current?.contains(element)) return false;
                return !element.classList.contains("window-find-slot");
            });
            if (relevant) scheduleScan(false, false);
        }, () => barRef.current);
        observerRef.current = observer;
        return () => {
            observer.disconnect();
            if (observerRef.current === observer) observerRef.current = null;
        };
    }, [opened]);

    useEffect(() => {
        if (!opened) return;
        return window.veraDesktop?.onEvent((event) => {
            if (event.type !== "browser_find_count" || surfaceRef.current !== "browser" || event.query !== queryRef.current) return;
            setCount({ current: event.current, total: event.total, capped: false });
        });
    }, [opened]);

    useEffect(() => () => {
        openedRef.current = false;
        observerRef.current?.disconnect();
        observerRef.current = null;
        cancelScan();
        clearFindHighlights();
        window.veraDesktop?.closeBrowserFind(false);
    }, []);

    const close = (restoreFocus = true): void => {
        pendingResult.current.clear();
        if (!openedRef.current) return;
        openedRef.current = false;
        observerRef.current?.disconnect();
        observerRef.current = null;
        cancelScan();
        clearMatches();
        if (surfaceRef.current === "browser") window.veraDesktop?.closeBrowserFind(restoreFocus);
        else if (restoreFocus && document.hasFocus() && previousRef.current?.isConnected) previousRef.current.focus({ preventScroll: true });
        previousRef.current = null;
        surfaceRef.current = "main";
        queryRef.current = "";
        setQuery("");
        setOpened(false);
    };

    const changeQuery = (next: string): void => {
        queryRef.current = next;
        setQuery(next);
        clearMatches();
        if (surfaceRef.current === "browser") window.veraDesktop?.searchBrowserFind("");
        if (next === "") cancelScan();
        else scheduleScan(true, true);
    };

    const move = (direction: 1 | -1): void => {
        if (timerRef.current !== undefined) {
            cancelScan();
            scan(true);
        }
        if (surfaceRef.current === "browser") {
            window.veraDesktop?.moveBrowserFind(direction === 1);
            return;
        }
        const found = matchesRef.current;
        const index = moveFindIndex(indexRef.current, found.ranges.length, direction);
        if (index < 0) return;
        indexRef.current = index;
        selectionRef.current = captureFindSelection(found.ranges[index], index);
        setCount({ current: index + 1, total: found.ranges.length, capped: found.capped });
        showFindHighlights(found.ranges, index);
        scrollFindMatch(found.ranges[index]!);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            move(event.key === "ArrowDown" || (event.key === "Enter" && !event.shiftKey) ? 1 : -1);
        }
    };

    if (!opened) return null;
    const bar = (
        <div ref={barRef} className="window-find" role="search" aria-label="Find in window" onKeyDown={onKeyDown}>
            <input ref={inputRef} type="text" aria-label="Find in window" autoComplete="off" spellCheck={false} value={query} onChange={(event) => changeQuery(event.currentTarget.value)} />
            <span className="window-find-count" role="status" aria-live="polite">{count.current}/{count.total}{count.capped ? "+" : ""}</span>
            <button type="button" aria-label="Previous match" title="Previous match" onClick={() => move(-1)}><ChevronDownIcon className="window-find-up" /></button>
            <button type="button" aria-label="Next match" title="Next match" onClick={() => move(1)}><ChevronDownIcon /></button>
            <button type="button" aria-label="Close find" title="Close" onClick={() => close()}><XIcon /></button>
        </div>
    );
    return slot === null ? bar : createPortal(bar, slot);
}

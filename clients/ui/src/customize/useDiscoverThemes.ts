import { useEffect, useRef, useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import type { CatalogPreview, CatalogTheme } from "../protocol/extension-catalog.ts";
import { switchTheme } from "../theme/activate.ts";
import { importedThemeId } from "../theme/tokens.ts";
import { installExtension } from "./desktop-extensions.ts";
import { previewCatalogTheme, readCatalog, restoreSnapshot, showPreview, snapshotTheme, type ThemeSnapshot } from "./discover-themes.ts";

export type CatalogList =
    | { readonly phase: "loading" }
    | { readonly phase: "unavailable" }
    | { readonly phase: "ready"; readonly themes: readonly CatalogTheme[] }
    | { readonly phase: "failed"; readonly reason: string };

export interface DiscoverThemesState {
    readonly list: CatalogList;
    // The theme being downloaded, until its preview is on screen.
    readonly fetching: string | undefined;
    readonly preview: CatalogPreview | undefined;
    // Install is writing the previewed package.
    readonly keeping: boolean;
    readonly failure: string | undefined;
    readonly start: (id: string) => void;
    readonly keep: () => void;
    readonly cancel: () => void;
    readonly retry: () => void;
}

interface Held {
    readonly preview: CatalogPreview;
    readonly before: ThemeSnapshot;
}

// The catalog is read when Discover opens and dropped when it closes. A preview is the theme applied to the window
// without storing it: Cancel, Escape or leaving Discover restores the previous theme and discards the package.
export function useDiscoverThemes(bridge: DesktopBridge): DiscoverThemesState {
    const [list, setList] = useState<CatalogList>({ phase: "loading" });
    const [fetching, setFetching] = useState<string | undefined>(undefined);
    const [preview, setPreview] = useState<CatalogPreview | undefined>(undefined);
    const [keeping, setKeeping] = useState(false);
    const [failure, setFailure] = useState<string | undefined>(undefined);
    const [attempt, setAttempt] = useState(0);
    const held = useRef<Held | undefined>(undefined);
    const live = useRef(true);

    useEffect(() => {
        let current = true;
        live.current = true;
        setList({ phase: "loading" });
        void readCatalog(bridge).then((result) => {
            if (!current) return;
            if (!result.ok) setList({ phase: "failed", reason: result.reason });
            else setList(result.available ? { phase: "ready", themes: result.themes } : { phase: "unavailable" });
        });
        return () => {
            current = false;
            live.current = false;
            const waiting = held.current;
            held.current = undefined;
            if (waiting !== undefined) {
                restoreSnapshot(waiting.before);
                bridge.cancelDesktopExtension(waiting.preview.token);
            }
            bridge.closeExtensionCatalog();
        };
    }, [bridge, attempt]);

    function drop(): void {
        const waiting = held.current;
        held.current = undefined;
        if (waiting !== undefined) {
            restoreSnapshot(waiting.before);
            bridge.cancelDesktopExtension(waiting.preview.token);
        }
        setPreview(undefined);
    }

    function start(id: string): void {
        if (held.current !== undefined || fetching !== undefined) return;
        setFailure(undefined);
        setFetching(id);
        void previewCatalogTheme(bridge, id).then((result) => {
            if (!live.current) {
                if (result.ok) bridge.cancelDesktopExtension(result.preview.token);
                return;
            }
            setFetching(undefined);
            if (!result.ok) return setFailure(result.reason);
            const theme = result.preview.themes[0];
            if (theme === undefined) {
                bridge.cancelDesktopExtension(result.preview.token);
                return;
            }
            const before = snapshotTheme();
            showPreview(theme, before);
            held.current = { preview: result.preview, before };
            setPreview(result.preview);
        });
    }

    function keep(): void {
        const waiting = held.current;
        if (waiting === undefined || keeping) return;
        setKeeping(true);
        void installExtension(bridge, waiting.preview.token).then((result) => {
            if (!live.current) return;
            setKeeping(false);
            held.current = undefined;
            setPreview(undefined);
            const theme = waiting.preview.themes[0];
            if (!result.ok || theme === undefined) {
                restoreSnapshot(waiting.before);
                if (!result.ok) setFailure(result.reason);
                return;
            }
            switchTheme(importedThemeId(theme.slug));
            setList((known) =>
                known.phase === "ready"
                    ? { phase: "ready", themes: known.themes.map((item) => (item.id === waiting.preview.id ? { ...item, installed: true } : item)) }
                    : known,
            );
        });
    }

    return { list, fetching, preview, keeping, failure, start, keep, cancel: drop, retry: () => setAttempt(attempt + 1) };
}

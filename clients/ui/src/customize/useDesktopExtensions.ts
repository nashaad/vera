import { useEffect, useRef, useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import type { DesktopExtensionEntry, ExtensionChangeResult, ExtensionPreview } from "../protocol/extensions.ts";
import { installExtension, previewExtension, readExtensions, removeExtension, toggleExtension } from "./desktop-extensions.ts";

export type ExtensionList =
    | { readonly phase: "loading" }
    | { readonly phase: "ready"; readonly extensions: readonly DesktopExtensionEntry[] }
    | { readonly phase: "failed"; readonly reason: string };

export interface ExtensionReport {
    readonly ok: boolean;
    readonly message: string;
}

export interface DesktopExtensionsState {
    readonly list: ExtensionList;
    readonly preview: ExtensionPreview | undefined;
    readonly report: ExtensionReport | undefined;
    readonly busy: boolean;
    readonly choose: () => void;
    readonly confirm: () => void;
    readonly cancel: () => void;
    readonly toggle: (id: string, enabled: boolean) => void;
    readonly remove: (id: string) => void;
}

function listOf(result: ExtensionChangeResult): ExtensionList {
    return result.ok ? { phase: "ready", extensions: result.extensions } : { phase: "failed", reason: result.reason };
}

export function useDesktopExtensions(bridge: DesktopBridge | undefined): DesktopExtensionsState {
    const [list, setList] = useState<ExtensionList>({ phase: "loading" });
    const [preview, setPreview] = useState<ExtensionPreview | undefined>(undefined);
    const [report, setReport] = useState<ExtensionReport | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    // The preview the main process is holding, which is dropped when this page goes away.
    const pending = useRef<ExtensionPreview | undefined>(undefined);
    const live = useRef(true);

    useEffect(() => {
        live.current = true;
        if (bridge === undefined) return undefined;
        void readExtensions(bridge).then((result) => {
            if (live.current) setList(listOf(result));
        });
        return () => {
            live.current = false;
            if (pending.current !== undefined) bridge.cancelDesktopExtension(pending.current.token);
            pending.current = undefined;
        };
    }, [bridge]);

    function drop(): void {
        if (pending.current !== undefined) bridge?.cancelDesktopExtension(pending.current.token);
        pending.current = undefined;
        setPreview(undefined);
    }

    async function change(request: () => Promise<ExtensionChangeResult>, success?: string): Promise<void> {
        setBusy(true);
        setReport(undefined);
        const result = await request();
        if (!live.current) return;
        setBusy(false);
        if (result.ok) {
            setList(listOf(result));
            if (success !== undefined) setReport({ ok: true, message: success });
        } else {
            setReport({ ok: false, message: result.reason });
        }
    }

    function choose(): void {
        if (bridge === undefined) return;
        drop();
        setBusy(true);
        setReport(undefined);
        void previewExtension(bridge).then((result) => {
            if (!live.current) {
                if (result.ok && result.preview !== undefined) bridge.cancelDesktopExtension(result.preview.token);
                return;
            }
            setBusy(false);
            if (!result.ok) setReport({ ok: false, message: result.reason });
            else if (result.preview !== undefined) {
                pending.current = result.preview;
                setPreview(result.preview);
            }
        });
    }

    function confirm(): void {
        const chosen = pending.current;
        if (bridge === undefined || chosen === undefined) return;
        pending.current = undefined;
        setPreview(undefined);
        void change(() => installExtension(bridge, chosen.token), `Installed "${chosen.id}".`);
    }

    function toggle(id: string, enabled: boolean): void {
        if (bridge !== undefined) void change(() => toggleExtension(bridge, id, enabled));
    }

    function remove(id: string): void {
        if (bridge !== undefined) void change(() => removeExtension(bridge, id), `Removed "${id}".`);
    }

    return { list, preview, report, busy, choose, confirm, cancel: drop, toggle, remove };
}

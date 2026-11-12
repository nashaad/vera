import { useEffect, useState } from "react";

import { BlocksIcon, ErrorIcon } from "../components/Icons.tsx";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { useRouter } from "../pages/router.tsx";
import { extensionOutcome, HOST_SILENT_REASON, NO_BRIDGE_REASON, type ExtensionOutcome } from "./doctor.ts";
import { OverlaySheet } from "./OverlaySheet.tsx";

export interface ExtensionsSheetProps {
    readonly onClose: () => void;
}

export function ExtensionsSheet({ onClose }: ExtensionsSheetProps) {
    const { navigate } = useRouter();
    const [outcome, setOutcome] = useState<ExtensionOutcome | undefined>(undefined);

    useEffect(() => {
        const bridge = window.veraDesktop as DesktopBridge | undefined;
        if (bridge === undefined) {
            setOutcome({ kind: "unreadable", reason: NO_BRIDGE_REASON });
            return undefined;
        }
        let live = true;
        bridge.readExtensionFailures().then(
            (result) => {
                if (live) setOutcome(extensionOutcome(result));
            },
            () => {
                if (live) setOutcome({ kind: "unreadable", reason: HOST_SILENT_REASON });
            },
        );
        return () => {
            live = false;
        };
    }, []);

    return (
        <OverlaySheet
            title="Extensions"
            Icon={BlocksIcon}
            onClose={onClose}
            name="extensions"
            foot={(
                <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => {
                        navigate({ kind: "customize" });
                        onClose();
                    }}
                >
                    Open Customize
                </button>
            )}
        >
            <p className="dialog-text">Turning extensions on or off and installing them is not available from this window yet.</p>
            {outcome === undefined ? <p className="dialog-text">Reading extensions…</p> : null}
            {outcome?.kind === "unreadable" ? <p className="dialog-note" data-tone="danger" role="alert">{outcome.reason}</p> : null}
            {outcome?.kind === "loaded" ? <p className="dialog-text">Every configured extension loaded.</p> : null}
            {outcome?.kind === "failed" ? (
                <>
                    <ul className="dialog-rows">
                        {outcome.shown.map((failure) => (
                            <li key={failure.extensionId} className="dialog-row" data-extension={failure.extensionId}>
                                <ErrorIcon className="dialog-row-icon" />
                                <span className="dialog-row-body">
                                    <span className="dialog-row-name">{failure.extensionId}</span>
                                    <span className="dialog-row-detail">{failure.message}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                    {outcome.total > outcome.shown.length ? (
                        <p className="dialog-text">Showing the first {outcome.shown.length} of {outcome.total}.</p>
                    ) : null}
                </>
            ) : null}
        </OverlaySheet>
    );
}

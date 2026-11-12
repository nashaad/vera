import { useEffect, useState } from "react";

import { CheckIcon, ErrorIcon, RefreshIcon, ShieldIcon, WarningIcon } from "../components/Icons.tsx";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { showToast } from "./toasts.ts";
import {
    doctorChecks,
    doctorSummary,
    extensionOutcome,
    HOST_SILENT_REASON,
    NO_BRIDGE_REASON,
    providerOutcome,
    type CheckState,
    type DoctorCheck,
    type ExtensionOutcome,
    type ProviderOutcome,
} from "./doctor.ts";
import { OverlaySheet } from "./OverlaySheet.tsx";

export interface DoctorSheetProps {
    readonly onClose: () => void;
}

const DOCTOR_COMMAND = "vera doctor";

export function DoctorSheet({ onClose }: DoctorSheetProps) {
    const { connection } = useViewEnvironment();
    const [run, setRun] = useState(0);
    const [extensions, setExtensions] = useState<ExtensionOutcome | undefined>(undefined);
    const [providers, setProviders] = useState<ProviderOutcome | undefined>(undefined);

    useEffect(() => {
        setExtensions(undefined);
        setProviders(undefined);
        const bridge = window.veraDesktop as DesktopBridge | undefined;
        if (bridge === undefined) {
            setExtensions({ kind: "unreadable", reason: NO_BRIDGE_REASON });
            setProviders({ kind: "unreadable", reason: NO_BRIDGE_REASON });
            return undefined;
        }
        let live = true;
        bridge.readExtensionFailures().then(
            (result) => {
                if (live) setExtensions(extensionOutcome(result));
            },
            () => {
                if (live) setExtensions({ kind: "unreadable", reason: HOST_SILENT_REASON });
            },
        );
        bridge.readModelSettings().then(
            (result) => {
                if (live) setProviders(providerOutcome(result));
            },
            () => {
                if (live) setProviders({ kind: "unreadable", reason: HOST_SILENT_REASON });
            },
        );
        return () => {
            live = false;
        };
    }, [run]);

    const checks = doctorChecks({ connection, extensions, providers });
    const checking = extensions === undefined || providers === undefined;

    const copyCommand = () => {
        navigator.clipboard.writeText(DOCTOR_COMMAND).then(
            () => showToast(`Copied ${DOCTOR_COMMAND}`, "success"),
            () => showToast("Could not copy the command", "danger"),
        );
    };

    return (
        <OverlaySheet
            title="Check Vera's Health"
            Icon={ShieldIcon}
            onClose={onClose}
            name="doctor"
            wide
            foot={(
                <>
                    <span className="dialog-foot-note">For a full check of the home, run vera doctor in a terminal.</span>
                    <button type="button" className="ghost-btn" disabled={checking} onClick={() => setRun((value) => value + 1)}>
                        <RefreshIcon />
                        Run again
                    </button>
                    <button type="button" className="ghost-btn" onClick={copyCommand}>Copy command</button>
                </>
            )}
        >
            <p className="dialog-text">{doctorSummary(checks)}</p>
            <ul className="dialog-checks">
                {checks.map((check) => (
                    <CheckRow key={check.id} check={check} />
                ))}
            </ul>
        </OverlaySheet>
    );
}

interface CheckRowProps {
    readonly check: DoctorCheck;
}

function CheckRow({ check }: CheckRowProps) {
    return (
        <li className="dialog-check" data-check={check.id} data-result={check.result}>
            <CheckMark result={check.result} />
            <span className="dialog-check-body">
                <span className="dialog-check-name">{check.label}</span>
                <span className="dialog-check-detail">{check.detail}</span>
            </span>
        </li>
    );
}

function CheckMark({ result }: { readonly result: CheckState }) {
    if (result === "ok") return <CheckIcon className="dialog-check-icon" />;
    if (result === "warn") return <WarningIcon className="dialog-check-icon" />;
    if (result === "fail") return <ErrorIcon className="dialog-check-icon" />;
    return <span className="dialog-check-icon" aria-hidden="true" />;
}

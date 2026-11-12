import { useState } from "react";

import { offerFullAccess, useFullAccessOffered } from "../../session/fullAccess.ts";
import { SettingRow } from "./SettingRow.tsx";

// Turning Full access on asks first; turning it off does not.
function FullAccessRow() {
    const offered = useFullAccessOffered();
    const [confirming, setConfirming] = useState(false);
    const confirm = (on: boolean): void => {
        if (on) offerFullAccess(true);
        setConfirming(false);
    };
    return (
        <>
            <SettingRow
                name="Offer Full access"
                description="Lists Full access in the approval menus and lets /permissions choose it. Kept in this window's storage."
            >
                <button
                    type="button"
                    role="switch"
                    aria-checked={offered}
                    aria-label="Offer Full access"
                    className="appearance-switch"
                    onClick={() => (offered ? offerFullAccess(false) : setConfirming(true))}
                >
                    <span className="appearance-switch-knob" />
                </button>
            </SettingRow>
            {confirming ? (
                <div
                    className="setting-confirm"
                    role="alertdialog"
                    aria-label="Offer Full access"
                    onKeyDown={(event) => {
                        if (event.key === "Escape") confirm(false);
                    }}
                >
                    <p className="setting-confirm-text">
                        A session in Full access runs any command your user account can and changes any file it can reach, without asking you first. Show Full access in the approval menus?
                    </p>
                    <div className="setting-confirm-actions">
                        <button type="button" className="button" autoFocus onClick={() => confirm(false)}>Cancel</button>
                        <button type="button" className="button request-danger" onClick={() => confirm(true)}>Offer Full access</button>
                    </div>
                </div>
            ) : null}
        </>
    );
}

// The host reads and writes the mode and permissions only through a running session, so those rows say where to change them.
export function ApprovalsSection() {
    return (
        <>
            <h1>Approvals</h1>
            <FullAccessRow />
            <SettingRow
                name="Default approval mode"
                description="The mode new sessions start in. Set it from a session: open the approval pill under the composer and choose Make this the default for new sessions."
            />
            <SettingRow
                name="Standing permissions"
                description="What Always has allowed in every session, and what Allow similar has allowed in one. Each session's approval pill lists them with a button to remove each."
            />
            <p className="settings-note">This window cannot read the default mode or standing permissions without a session.</p>
        </>
    );
}

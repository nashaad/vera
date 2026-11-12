import { SettingRow } from "./SettingRow.tsx";

// The host reads and writes these only through a running session, so the rows say where to change them.
export function ApprovalsSection() {
    return (
        <>
            <h1>Approvals</h1>
            <SettingRow
                name="Default approval mode"
                description="The mode new sessions start in. Set it from a session: open the approval pill under the composer and choose Make this the default for new sessions."
            />
            <SettingRow
                name="Standing permissions"
                description="What Always has allowed in every session, and what Allow similar has allowed in one. Each session's approval pill lists them with a button to remove each."
            />
            <p className="settings-note">This window cannot read these settings without a session yet.</p>
        </>
    );
}

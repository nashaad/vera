import { RefreshIcon } from "../../components/Icons.tsx";
import { UPDATE_MODE_CHOICES, type UpdateModeChoice, type UpdateState } from "../../protocol/updates.ts";
import { canCheckNow, updateStatusLine } from "../../updates/model.ts";
import { actOnUpdate, useUpdateState } from "../../updates/store.ts";
import { Segmented } from "./Segmented.tsx";
import { SettingRow } from "./SettingRow.tsx";

const MODE_LABELS: Readonly<Record<UpdateModeChoice, string>> = { ask: "Ask", automatic: "Automatic", off: "Off" };

export function UpdatesSection() {
    return <UpdatesPanel state={useUpdateState()} />;
}

export function UpdatesPanel({ state }: { readonly state: UpdateState }) {
    return (
        <>
            <h1>Updates</h1>
            <p className="settings-lede">Choose how Vera finds and installs new versions. One update moves the host and the desktop app together.</p>
            <SettingRow
                id="updates.new-versions"
                name="New versions"
                description="Ask shows a chip in the sidebar when a new version is ready. Automatic downloads it in the background; you still choose when to switch. Off never checks."
            >
                <Segmented
                    label="New versions"
                    options={UPDATE_MODE_CHOICES}
                    labels={MODE_LABELS}
                    value={state.mode}
                    onChange={(mode) => actOnUpdate({ kind: "mode", mode })}
                />
            </SettingRow>
            {state.modeProblem === undefined ? null : <p className="dialog-note" data-tone="danger">Could not save the setting: {state.modeProblem}</p>}
            <SettingRow id="updates.check-now" name="Check now" description={updateStatusLine(state)}>
                <button type="button" className="ghost-btn" data-action="check" disabled={!canCheckNow(state)} onClick={() => actOnUpdate({ kind: "check" })}>
                    <RefreshIcon />
                    Check now
                </button>
            </SettingRow>
        </>
    );
}

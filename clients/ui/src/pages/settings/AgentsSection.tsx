import { useState, type ReactNode } from "react";

import { folderChoices } from "../../customize/catalog.ts";
import { useFolderCustomizations } from "../../customize/useFolderCustomizations.ts";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import { folderName } from "../../protocol/sessionGroups.ts";
import { readNotesOffer, storeNotesOffer } from "../../state/notesOffer.ts";
import { useViewEnvironment } from "../../views/env.tsx";
import { agentMeta } from "./agents.ts";
import { SettingRow } from "./SettingRow.tsx";

export function AgentsSection() {
    const { connection } = useViewEnvironment();
    const [reload, setReload] = useState(0);
    const [notesOffer, setNotesOffer] = useState<boolean>(() => readNotesOffer());
    const rows = connection.sessionRows ?? [];
    // The folder of the most recently active session; with none, what a new chat loads.
    const folder = folderChoices(rows, 1)[0];
    const attached = connection.phase === "attached";
    const bridge: DesktopBridge | undefined = window.veraDesktop;
    const reading = useFolderCustomizations(bridge, folder, attached, reload);
    const again = (): void => setReload((count) => count + 1);
    const toggleNotesOffer = (): void => {
        storeNotesOffer(!notesOffer);
        setNotesOffer(!notesOffer);
    };

    let body: ReactNode;
    if (!attached) {
        body = <p className="settings-muted">Vera is not connected.</p>;
    } else if (reading.phase === "failed") {
        body = (
            <>
                <p className="settings-muted">{reading.reason}</p>
                <div className="toolbar">
                    <button type="button" className="ghost-btn" onClick={again}>Retry</button>
                </div>
            </>
        );
    } else if (reading.phase !== "ready") {
        body = <p className="settings-muted">Reading…</p>;
    } else {
        const agents = reading.reading.agents;
        body = (
            <>
                <div className="toolbar">
                    <button type="button" className="ghost-btn" onClick={again}>Reload</button>
                </div>
                {agents.length === 0 ? <p className="settings-muted">No agents found.</p> : null}
                {agents.map((agent) => (
                    <SettingRow key={`${agent.scope}-${agent.name}`} name={agent.name} description={agent.description ?? ""}>
                        <span className="settings-muted">{agentMeta(agent)}</span>
                    </SettingRow>
                ))}
                {reading.reading.warnings.map((warning, index) => (
                    <p key={index} className="settings-muted">{warning}</p>
                ))}
            </>
        );
    }

    return (
        <>
            <h1>Agents</h1>
            <SettingRow
                id="agents.notes-offer"
                name="Suggest keeping notes"
                description="New sessions offer once to keep notes when a conversation produces something worth keeping. Sessions already started are not changed."
            >
                <button
                    type="button"
                    role="switch"
                    aria-checked={notesOffer}
                    aria-label="Suggest keeping notes"
                    className="appearance-switch"
                    onClick={toggleNotesOffer}
                >
                    <span className="appearance-switch-knob" />
                </button>
            </SettingRow>
            {attached ? (
                <p className="settings-muted">
                    {folder === undefined ? "Showing the agents a new chat can run as." : `Showing the agents a session in ${folderName(folder)} can run as.`}
                </p>
            ) : null}
            {body}
            <p className="settings-note">
                Agents are Markdown files in the agents folder of a project or the Vera home. Choose the agent a session runs as from
                that session with Choose Agent in the command palette.
            </p>
        </>
    );
}

import { useState, type ReactNode } from "react";

import { probeTarget } from "../../customize/probe.ts";
import { useCatalogProbe } from "../../customize/useCatalogProbe.ts";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import { useViewEnvironment } from "../../views/env.tsx";
import { agentMeta } from "./agents.ts";
import { SettingRow } from "./SettingRow.tsx";

export function AgentsSection() {
    const { connection } = useViewEnvironment();
    const [reload, setReload] = useState(0);
    const rows = connection.sessionRows ?? [];
    const target = probeTarget(rows);
    const attached = connection.phase === "attached";
    const bridge: DesktopBridge | undefined = window.veraDesktop;
    const probe = useCatalogProbe(bridge, target?.id, attached, reload);
    const again = (): void => setReload((count) => count + 1);

    let body: ReactNode;
    if (!attached) {
        body = <p className="settings-muted">Vera is not connected.</p>;
    } else if (target === undefined) {
        body = <p className="settings-muted">Start a session to see the agents it can run as.</p>;
    } else if (probe.phase === "failed") {
        body = (
            <>
                <p className="settings-muted">{probe.error}</p>
                <div className="toolbar">
                    <button type="button" className="ghost-btn" onClick={again}>Retry</button>
                </div>
            </>
        );
    } else if (probe.phase !== "ready") {
        body = <p className="settings-muted">Reading…</p>;
    } else {
        const agents = probe.agents?.agents ?? [];
        body = (
            <>
                <div className="toolbar">
                    <button type="button" className="ghost-btn" onClick={again}>Reload</button>
                </div>
                {agents.length === 0 ? <p className="settings-muted">No agents found for this session.</p> : null}
                {agents.map((agent) => (
                    <SettingRow key={`${agent.scope}-${agent.name}`} name={agent.name} description={agent.description ?? ""}>
                        <span className="settings-muted">{agentMeta(agent)}</span>
                    </SettingRow>
                ))}
                {probe.warnings.map((warning, index) => (
                    <p key={index} className="settings-muted">{warning}</p>
                ))}
            </>
        );
    }

    return (
        <>
            <h1>Agents</h1>
            {target !== undefined && attached ? <p className="settings-muted">Read through the session {target.name}.</p> : null}
            {body}
            <p className="settings-note">
                Agents are Markdown files in the agents folder of a project or the Vera home. Choose the agent a session runs as from
                that session with Choose Agent in the command palette.
            </p>
        </>
    );
}

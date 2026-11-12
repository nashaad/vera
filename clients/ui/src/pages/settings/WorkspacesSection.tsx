import { useState } from "react";

import type { DesktopBridge } from "../../protocol/bridge.ts";
import { folderName } from "../../protocol/sessionGroups.ts";
import type { SessionRow } from "../../protocol/sessions.ts";
import { useViewEnvironment } from "../../views/env.tsx";
import { workspaceStats } from "../WorkspacePage.tsx";
import { useRouter } from "../router.tsx";
import { folderSummary, workspaceFolders } from "./workspaces.ts";

interface WorkspaceRowProps {
    readonly folder: string;
    readonly folderRows: readonly SessionRow[];
    readonly more: boolean;
    readonly revealLabel: string;
    readonly revealFailed: boolean;
    readonly bridge: DesktopBridge | undefined;
    readonly onReveal: (folder: string) => void;
}

function WorkspaceRow({ folder, folderRows, more, revealLabel, revealFailed, bridge, onReveal }: WorkspaceRowProps) {
    const { navigate } = useRouter();
    const summary = folderSummary(workspaceStats(folderRows, more, Date.now()));
    return (
        <li className="workspaces-row">
            <div className="workspaces-body">
                <div className="workspaces-name">{folderName(folder)}</div>
                <code className="workspaces-path">{folder}</code>
                <div className="workspaces-summary">{summary}</div>
                {revealFailed ? <div className="workspaces-note">The folder could not be opened.</div> : null}
            </div>
            <div className="workspaces-actions">
                <button type="button" className="ghost-btn" onClick={() => navigate({ kind: "workspace", folder })}>
                    Open
                </button>
                <button type="button" className="ghost-btn" onClick={() => navigate({ kind: "home", folder })}>
                    New chat here
                </button>
                <button type="button" className="ghost-btn" disabled={bridge === undefined} onClick={() => onReveal(folder)}>
                    {revealLabel}
                </button>
            </div>
        </li>
    );
}

export function WorkspacesSection() {
    const { connection } = useViewEnvironment();
    const bridge: DesktopBridge | undefined = window.veraDesktop;
    const [failedFolder, setFailedFolder] = useState<string | undefined>(undefined);
    const rows = connection.sessionRows ?? [];
    const folders = workspaceFolders(rows);
    const more = connection.sessions !== undefined && connection.sessions > rows.length;
    const revealLabel = bridge?.platform === "darwin" ? "Show in Finder" : "Open folder";

    async function reveal(folder: string): Promise<void> {
        if (bridge === undefined) return;
        const opened = await bridge.revealFolder(folder).catch(() => false);
        setFailedFolder(opened ? undefined : folder);
    }

    return (
        <>
            <h1>Workspaces</h1>
            {folders.length === 0 ? (
                <p className="settings-muted">No workspaces yet. Folders show here once a session runs in them.</p>
            ) : (
                <ul className="workspaces-list">
                    {folders.map((folder) => (
                        <WorkspaceRow
                            key={folder}
                            folder={folder}
                            folderRows={rows.filter((row) => row.workspace === folder)}
                            more={more}
                            revealLabel={revealLabel}
                            revealFailed={failedFolder === folder}
                            bridge={bridge}
                            onReveal={(target) => void reveal(target)}
                        />
                    ))}
                </ul>
            )}
            {more ? <p className="settings-note">Only folders from recent sessions show.</p> : null}
        </>
    );
}

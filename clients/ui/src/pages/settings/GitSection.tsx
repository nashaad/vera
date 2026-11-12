import { useBranchLookup } from "../../composer/useBranch.ts";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import { folderName } from "../../protocol/sessionGroups.ts";
import { useViewEnvironment } from "../../views/env.tsx";
import { workspaceFolders } from "./workspaces.ts";

function GitRow({ folder }: { readonly folder: string }) {
    const bridge: DesktopBridge | undefined = window.veraDesktop;
    const branch = useBranchLookup(bridge, folder);
    let label = "Reading…";
    if (branch.done) label = branch.name ?? "Not a git repository";
    return (
        <li className="workspaces-row">
            <div className="workspaces-body">
                <div className="workspaces-name">{folderName(folder)}</div>
                <code className="workspaces-path">{folder}</code>
            </div>
            <span className="badge">{label}</span>
        </li>
    );
}

export function GitSection() {
    const { connection } = useViewEnvironment();
    const folders = workspaceFolders(connection.sessionRows ?? []);
    return (
        <>
            <h1>Git &amp; PRs</h1>
            {folders.length === 0 ? (
                <p className="settings-muted">No workspaces yet. Folders show here once a session runs in them.</p>
            ) : (
                <ul className="workspaces-list">
                    {folders.map((folder) => (
                        <GitRow key={folder} folder={folder} />
                    ))}
                </ul>
            )}
            <p className="settings-note">
                Vera does not have git or pull request settings yet. Branch names are read from each folder.
            </p>
        </>
    );
}

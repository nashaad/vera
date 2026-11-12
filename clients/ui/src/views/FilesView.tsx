import { shortenPath } from "../components/homePath.ts";
import { CHAT_FOLDER_LABEL } from "../protocol/sessionGroups.ts";
import { useActiveSession } from "../session/activeSession.ts";
import type { ViewProps } from "./env.tsx";

export function FilesView(_props: ViewProps) {
    const session = useActiveSession();
    if (session === undefined) return <p className="view-empty">Open a session to see its files.</p>;
    const folder = session.folder;
    return (
        <div className="right-unavailable">
            <p className="view-empty">The host does not serve a file tree.</p>
            {session.chat ? (
                <p className="right-path">{CHAT_FOLDER_LABEL}</p>
            ) : folder === undefined || folder === "" ? null : (
                <p className="right-path" title={folder}>{shortenPath(folder)}</p>
            )}
        </div>
    );
}

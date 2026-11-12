import { shortenPath } from "../components/homePath.ts";
import { CHAT_FOLDER_LABEL } from "../protocol/sessionGroups.ts";
import { useActiveSession } from "../session/activeSession.ts";
import type { ViewProps } from "./env.tsx";
import { FileTree } from "./FileTree.tsx";

export function FilesView({ visible }: ViewProps) {
    const session = useActiveSession();
    if (session === undefined) return <p className="view-empty">Open a session to see its files.</p>;
    const folder = session.folder;
    if (folder === undefined || folder === "") return <p className="view-empty">This session has no folder.</p>;
    return (
        <div className="files-view">
            {session.chat ? (
                <p className="right-path">{CHAT_FOLDER_LABEL}</p>
            ) : (
                <p className="right-path" title={folder}>{shortenPath(folder)}</p>
            )}
            <FileTree key={folder} bridge={session.bridge} root={folder} visible={visible} running={session.watch.status !== "idle"} />
        </div>
    );
}

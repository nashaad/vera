import { shortenPath } from "../components/homePath.ts";
import { useActiveSession } from "../session/activeSession.ts";
import type { ViewProps } from "./env.tsx";

export function FilesView(_props: ViewProps) {
    const session = useActiveSession();
    if (session === undefined) return <p className="view-empty">Open a session to see its files.</p>;
    const folder = session.folder;
    return (
        <div className="right-unavailable">
            <p className="view-empty">The host does not serve a file tree yet.</p>
            {folder === undefined || folder === "" ? null : (
                <p className="right-path" title={folder}>{shortenPath(folder)}</p>
            )}
        </div>
    );
}

import { useState } from "react";

import { ArrowLeftIcon, ArrowRightIcon, SidebarRightIcon } from "../components/Icons.tsx";
import { shortenPath } from "../components/homePath.ts";
import { CHAT_FOLDER_LABEL } from "../protocol/sessionGroups.ts";
import { useActiveSession, type ActiveSession } from "../session/activeSession.ts";
import type { ViewProps } from "./env.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { EMPTY_FILE_HISTORY, openedFile, openInHistory, pathUnder, stepHistory, type FileHistory } from "./files.ts";
import { FileTree } from "./FileTree.tsx";

export function FilesView({ visible }: ViewProps) {
    const session = useActiveSession();
    if (session === undefined) return <p className="view-empty">Open a session to see its files.</p>;
    const folder = session.folder;
    if (folder === undefined || folder === "") return <p className="view-empty">This session has no folder.</p>;
    return <FolderFiles key={folder} session={session} folder={folder} visible={visible} />;
}

interface FolderFilesProps {
    readonly session: ActiveSession;
    readonly folder: string;
    readonly visible: boolean;
}

// The tree keeps its place in the element tree whether or not a file is open, so its open folders stay open.
function FolderFiles({ session, folder, visible }: FolderFilesProps) {
    const [history, setHistory] = useState<FileHistory>(EMPTY_FILE_HISTORY);
    const [treeShown, setTreeShown] = useState(true);
    const running = session.watch.status !== "idle";
    const opened = openedFile(history);
    const showTree = opened === undefined || treeShown;
    return (
        <div className="files-view" data-preview={opened !== undefined}>
            {opened === undefined ? null : (
                <div className="file-preview-bar">
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Previous file"
                        title="Previous file"
                        disabled={history.at <= 0}
                        onClick={() => setHistory((current) => stepHistory(current, -1))}
                    >
                        <ArrowLeftIcon />
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Next file"
                        title="Next file"
                        disabled={history.at >= history.paths.length - 1}
                        onClick={() => setHistory((current) => stepHistory(current, 1))}
                    >
                        <ArrowRightIcon />
                    </button>
                    <span className="file-preview-path" title={opened}>{pathUnder(folder, opened)}</span>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Browse files"
                        title="Browse files"
                        aria-pressed={treeShown}
                        onClick={() => setTreeShown(!treeShown)}
                    >
                        <SidebarRightIcon />
                    </button>
                </div>
            )}
            <div className="files-split">
                {opened === undefined ? null : (
                    <FilePreview bridge={session.bridge} path={opened} visible={visible} running={running} />
                )}
                <div className="files-tree" hidden={!showTree}>
                    {session.chat ? (
                        <p className="right-path">{CHAT_FOLDER_LABEL}</p>
                    ) : (
                        <p className="right-path" title={folder}>{shortenPath(folder)}</p>
                    )}
                    <FileTree
                        bridge={session.bridge}
                        root={folder}
                        visible={visible && showTree}
                        running={running}
                        selected={opened}
                        onOpenFile={(path) => setHistory((current) => openInHistory(current, path))}
                    />
                </div>
            </div>
        </div>
    );
}

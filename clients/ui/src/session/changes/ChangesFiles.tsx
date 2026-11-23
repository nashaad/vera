import { useEffect, useRef, useState } from "react";

import { MAX_PATCH_LINES, type GitChangedFile } from "../../../../shared/git-wire.ts";
import { ChatIcon, MoreIcon, OpenFileIcon } from "../../components/Icons.tsx";
import { FileTypeIcon } from "../../components/FileTypeIcon.tsx";
import { ContextMenu } from "../../workbench/ContextMenu.tsx";
import type { MenuEntry } from "../../commands/menus.ts";
import { copyText } from "../copyText.ts";
import { splitChangePath, type CachedPatch } from "../gitChanges.ts";
import { COPY_PATH, OPEN_DEFAULT, OPEN_FILES, TOGGLE_FILE } from "./commands.ts";

interface ChangesFileHeaderProps {
    readonly file: GitChangedFile;
    readonly patch: CachedPatch | undefined;
    readonly collapsed: boolean;
    readonly commentOpen: boolean;
    readonly onToggle: () => void;
    readonly onOpen: () => void;
    readonly onComment: () => void;
    readonly onOpenDefault: () => void;
    readonly onOpenFiles: () => void;
}

export function ChangesFileHeader({ file, patch, collapsed, commentOpen, onToggle, onOpen, onComment, onOpenDefault, onOpenFiles }: ChangesFileHeaderProps) {
    const { folder: parent, name } = splitChangePath(file.path);
    const previous = file.prevPath === undefined ? undefined : splitChangePath(file.prevPath);
    return <div className="changes-file-header">
        <button
            type="button"
            className="changes-file-toggle"
            aria-expanded={!collapsed}
            title={collapsed ? "Expand this file" : "Collapse this file"}
            onClick={onToggle}
        >
            <FileTypeIcon path={file.path} />
            <span className="changes-file-path" title={file.path}>
                {previous === undefined ? (
                    <>
                        {parent === "" ? null : <span className="changes-file-folder">{parent}</span>}
                        <span className="changes-file-name">{name}</span>
                    </>
                ) : (
                    <>
                        <span className="changes-file-folder">{previous.folder}</span>
                        <span className="changes-file-name">{previous.name}</span>
                        <span className="changes-file-arrow" aria-hidden="true">→</span>
                        <span className="changes-file-folder">{parent}</span>
                        <span className="changes-file-name">{name}</span>
                    </>
                )}
            </span>
            <span className="changes-file-counts">
                {file.added === null ? null : <span className="change-add">+{file.added}</span>}
                {file.removed === null ? null : <span className="change-del">−{file.removed}</span>}
            </span>
            {patch?.cut === true ? <span className="changes-file-note">First {MAX_PATCH_LINES} lines</span> : null}
            {file.binary ? <span className="changes-file-note">Binary file, not shown.</span> : null}
        </button>
        <div className="changes-file-actions">
            <button
                type="button"
                className="icon-button"
                aria-label={file.status === "deleted" ? `${file.path} is deleted` : "Open file"}
                title={file.status === "deleted" ? "Deleted file" : "Open file"}
                disabled={file.status === "deleted"}
                onClick={onOpen}
            ><OpenFileIcon /></button>
            <button
                type="button"
                className="icon-button"
                aria-label={`Comment on ${file.path}`}
                title="Comment on this file"
                aria-pressed={commentOpen}
                onClick={onComment}
            ><ChatIcon /></button>
            <FileMenu
                path={file.path}
                collapsed={collapsed}
                onOpenDefault={onOpenDefault}
                onOpenFiles={onOpenFiles}
                onToggle={onToggle}
            />
        </div>
    </div>;
}

export function ChangesFooter({ remaining, onVisible }: { readonly remaining: number; readonly onVisible: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const onVisibleRef = useRef(onVisible);
    onVisibleRef.current = onVisible;
    useEffect(() => {
        const element = ref.current;
        if (element === null || remaining <= 0) return undefined;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) onVisibleRef.current();
        }, { rootMargin: "0% 0% 100% 0%" });
        observer.observe(element);
        return () => observer.disconnect();
    }, [remaining]);
    if (remaining <= 0) return null;
    return <div className="changes-footer" ref={ref}><span className="changes-footer-note">Reading more files...</span></div>;
}

interface FileMenuProps {
    readonly path: string;
    readonly collapsed: boolean;
    readonly onOpenDefault: () => void;
    readonly onOpenFiles: () => void;
    readonly onToggle: () => void;
}

function FileMenu({ path, collapsed, onOpenDefault, onOpenFiles, onToggle }: FileMenuProps) {
    const [at, setAt] = useState<{ readonly x: number; readonly y: number }>();
    const entries: MenuEntry[] = [
        { kind: "item", label: "Copy path", command: COPY_PATH },
        { kind: "item", label: "Open in default app", command: OPEN_DEFAULT },
        { kind: "item", label: "Open in Files", command: OPEN_FILES },
        { kind: "separator" },
        { kind: "item", label: collapsed ? "Expand file" : "Collapse file", command: TOGGLE_FILE },
    ];
    const run = (command: string): void => {
        setAt(undefined);
        if (command === COPY_PATH) void copyText(path);
        else if (command === OPEN_DEFAULT) onOpenDefault();
        else if (command === OPEN_FILES) onOpenFiles();
        else if (command === TOGGLE_FILE) onToggle();
    };
    return (
        <div className="changes-file-menu">
            <button
                type="button"
                className="icon-button"
                aria-label={`More actions for ${path}`}
                title="More actions"
                aria-haspopup="menu"
                aria-expanded={at !== undefined}
                onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setAt({ x: box.left, y: box.bottom });
                }}
            ><MoreIcon /></button>
            {at === undefined ? null : (
                <ContextMenu entries={entries} x={at.x} y={at.y} onRun={run} onClose={() => setAt(undefined)} />
            )}
        </div>
    );
}

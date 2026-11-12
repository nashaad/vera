import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { ChevronRightIcon, FileIcon, FolderIcon } from "../components/Icons.tsx";
import { MAX_FOLDER_ENTRIES, type DesktopBridge, type FolderListing } from "../protocol/bridge.ts";

export interface FileTreeProps {
    readonly bridge: DesktopBridge;
    readonly root: string;
    readonly visible: boolean;
    readonly running: boolean;
}

type DepthStyle = CSSProperties & { readonly "--depth": number };

// Folders are read one level at a time when opened. Open folders are read again when a turn ends,
// since that is when Vera has changed files.
export function FileTree({ bridge, root, visible, running }: FileTreeProps) {
    const [listings, setListings] = useState<ReadonlyMap<string, FolderListing>>(new Map());
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const [turnsEnded, setTurnsEnded] = useState(0);
    const wasRunning = useRef(running);
    const openRef = useRef(open);
    openRef.current = open;

    useEffect(() => {
        if (wasRunning.current && !running) setTurnsEnded((count) => count + 1);
        wasRunning.current = running;
    }, [running]);

    const read = useCallback((path: string): void => {
        void bridge.listFolder(path).then((listing) => setListings((current) => new Map(current).set(path, listing)));
    }, [bridge]);

    useEffect(() => {
        if (!visible) return;
        read(root);
        for (const path of openRef.current) read(path);
    }, [visible, root, turnsEnded, read]);

    const toggle = (path: string): void => {
        const next = new Set(open);
        if (next.has(path)) {
            next.delete(path);
        } else {
            next.add(path);
            read(path);
        }
        setOpen(next);
    };

    return (
        <ul className="file-tree" role="tree" aria-label="Files">
            <FolderRows path={root} depth={0} listings={listings} open={open} toggle={toggle} />
        </ul>
    );
}

interface FolderRowsProps {
    readonly path: string;
    readonly depth: number;
    readonly listings: ReadonlyMap<string, FolderListing>;
    readonly open: ReadonlySet<string>;
    readonly toggle: (path: string) => void;
}

function FolderRows({ path, depth, listings, open, toggle }: FolderRowsProps) {
    const listing = listings.get(path);
    const indent: DepthStyle = { "--depth": depth };
    if (listing === undefined) return <li className="file-note" style={indent}>Reading…</li>;
    if (!listing.ok) return <li className="file-note" style={indent}>{listing.reason}</li>;
    if (listing.entries.length === 0) return <li className="file-note" style={indent}>Empty folder</li>;
    return (
        <>
            {listing.entries.map((entry) => {
                const child = childPath(path, entry.name);
                if (!entry.folder) {
                    return (
                        <li key={entry.name} className="file-row" role="treeitem" style={indent} title={child}>
                            <FileIcon className="file-icon" />
                            <span className="file-name">{entry.name}</span>
                        </li>
                    );
                }
                const expanded = open.has(child);
                return (
                    <li key={entry.name} role="treeitem" aria-expanded={expanded}>
                        <button type="button" className="file-row file-folder" style={indent} title={child} onClick={() => toggle(child)}>
                            <ChevronRightIcon className="file-chevron" />
                            <FolderIcon className="file-icon" />
                            <span className="file-name">{entry.name}</span>
                        </button>
                        {expanded ? (
                            <ul role="group">
                                <FolderRows path={child} depth={depth + 1} listings={listings} open={open} toggle={toggle} />
                            </ul>
                        ) : null}
                    </li>
                );
            })}
            {listing.cut ? <li className="file-note" style={indent}>Showing the first {MAX_FOLDER_ENTRIES} entries.</li> : null}
        </>
    );
}

function childPath(parent: string, name: string): string {
    const separator = parent.includes("/") || !parent.includes("\\") ? "/" : "\\";
    return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`;
}

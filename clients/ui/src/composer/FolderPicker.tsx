import { useEffect, useRef, useState } from "react";

import { ChevronDownIcon, FolderIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import type { FolderChoice } from "./rules.ts";

export interface FolderPickerActions {
    readonly choices: readonly FolderChoice[];
    readonly onPick: (folder: string) => void;
    readonly onOpen: () => void;
}

export interface FolderPickerProps extends FolderPickerActions {
    readonly label: string;
    // The full path, shown as a tooltip; absent while no folder is chosen.
    readonly folder: string | undefined;
}

// The folder chip in New Chat: a button that opens a menu of recent folders.
export function FolderPicker({ label, folder, choices, onPick, onOpen }: FolderPickerProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const placed = usePopoverPlacement(open, root);

    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event: MouseEvent): void => {
            if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointer);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onPointer);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <div className="folder-picker" ref={root}>
            <button
                type="button"
                className="chip chip-button"
                aria-haspopup="menu"
                aria-expanded={open}
                title={folder}
                onClick={() => setOpen(!open)}
            >
                <FolderIcon className="chip-icon" />
                <span className="chip-label">{label}</span>
                <ChevronDownIcon className="chip-chevron" />
            </button>
            {open ? (
                <div className="folder-menu" role="menu" data-popover="above-start" style={placed}>
                    {choices.map((choice) => (
                        <button
                            key={choice.folder}
                            type="button"
                            role="menuitem"
                            className="folder-item"
                            title={choice.folder}
                            onClick={() => {
                                setOpen(false);
                                onPick(choice.folder);
                            }}
                        >
                            <span className="folder-item-name">{choice.name}</span>
                            <span className="folder-item-path">{choice.folder}</span>
                        </button>
                    ))}
                    {choices.length > 0 ? <div className="folder-sep" /> : null}
                    <button
                        type="button"
                        role="menuitem"
                        className="folder-item"
                        onClick={() => {
                            setOpen(false);
                            onOpen();
                        }}
                    >
                        <span className="folder-item-name">Open folder…</span>
                    </button>
                </div>
            ) : null}
        </div>
    );
}

import { useCallback, useRef, useState } from "react";

import { ChevronDownIcon, FolderIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import { CHAT_FOLDER_LABEL } from "../protocol/sessionGroups.ts";
import { MOVE_TO_FOLDER_LABEL } from "./rules.ts";
import { useMenuDismiss } from "./useMenuDismiss.ts";

export interface ChatFolderChipProps {
    readonly onMove: () => void;
    // Set while a move is under way.
    readonly disabled: boolean;
}

// The folder chip of a chat: a button whose menu moves the chat into a folder.
export function ChatFolderChip({ onMove, disabled }: ChatFolderChipProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useMenuDismiss(open, root, close);
    const placed = usePopoverPlacement(open, root);

    return (
        <div className="folder-picker" ref={root}>
            <button
                type="button"
                className="chip chip-button"
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={disabled}
                onClick={() => setOpen(!open)}
            >
                <FolderIcon className="chip-icon" />
                <span className="chip-label">{CHAT_FOLDER_LABEL}</span>
                <ChevronDownIcon className="chip-chevron" />
            </button>
            {open ? (
                <div className="folder-menu folder-menu-narrow" role="menu" data-popover="above-start" style={placed}>
                    <button
                        type="button"
                        role="menuitem"
                        className="folder-item"
                        onClick={() => {
                            setOpen(false);
                            onMove();
                        }}
                    >
                        <span className="folder-item-name">{MOVE_TO_FOLDER_LABEL}</span>
                    </button>
                </div>
            ) : null}
        </div>
    );
}

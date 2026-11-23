import { useEffect, type ComponentType, type ReactNode } from "react";

import { XIcon } from "../components/Icons.tsx";

export interface OverlaySheetProps {
    readonly title: ReactNode;
    readonly Icon?: ComponentType<{ readonly className?: string }>;
    // Replaces the small head icon when a sheet needs a larger mark.
    readonly lead?: ReactNode;
    readonly onClose: () => void;
    readonly onEscape?: () => void;
    readonly children: ReactNode;
    readonly head?: ReactNode;
    // Buttons for the bottom row; omitted sheets have no foot.
    readonly foot?: ReactNode;
    readonly wide?: boolean;
    // Extra sheet class for size or layout overrides.
    readonly className?: string;
    // Names the sheet for tests and styles, such as "themes".
    readonly name: string;
}

// The frame every window-wide sheet shares: scrim, head with a close button, body and an optional foot.
export function OverlaySheet({ title, Icon, lead, onClose, onEscape, children, head, foot, wide = false, className, name }: OverlaySheetProps) {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") (onEscape ?? onClose)();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose, onEscape]);

    const titleId = `overlay-${name}-title`;
    return (
        <div
            className="sheet-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                className={`sheet session-sheet overlay-sheet${className === undefined ? "" : ` ${className}`}`}
                data-overlay={name}
                data-wide={wide}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
            >
                <div className="sheet-head">
                    {lead ?? (Icon === undefined ? null : <Icon className="session-sheet-icon" />)}
                    <span className="session-sheet-title" id={titleId}>{title}</span>
                    {head}
                    <button type="button" className="sheet-x" onClick={onClose} aria-label="Close">
                        <XIcon />
                    </button>
                </div>
                <div className="sheet-body session-sheet-body overlay-sheet-body">{children}</div>
                {foot === undefined ? null : <div className="session-sheet-foot">{foot}</div>}
            </div>
        </div>
    );
}

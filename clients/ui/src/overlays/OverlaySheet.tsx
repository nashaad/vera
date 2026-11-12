import { useEffect, type ComponentType, type ReactNode } from "react";

import { XIcon } from "../components/Icons.tsx";

export interface OverlaySheetProps {
    readonly title: string;
    readonly Icon: ComponentType<{ readonly className?: string }>;
    readonly onClose: () => void;
    readonly children: ReactNode;
    // Buttons for the bottom row; omitted sheets have no foot.
    readonly foot?: ReactNode;
    readonly wide?: boolean;
    // Names the sheet for tests and styles, such as "themes".
    readonly name: string;
}

// The frame every window-wide sheet shares: scrim, head with a close button, body and an optional foot.
export function OverlaySheet({ title, Icon, onClose, children, foot, wide = false, name }: OverlaySheetProps) {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const titleId = `overlay-${name}-title`;
    return (
        <div
            className="sheet-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                className="sheet session-sheet overlay-sheet"
                data-overlay={name}
                data-wide={wide}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
            >
                <div className="sheet-head">
                    <Icon className="session-sheet-icon" />
                    <span className="session-sheet-title" id={titleId}>{title}</span>
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

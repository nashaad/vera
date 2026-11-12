import { useEffect, useRef, useState } from "react";

import { XIcon } from "../components/Icons.tsx";
import { showToast } from "../overlays/toasts.ts";
import type { ActiveSession } from "./activeSession.ts";
import { renameSession } from "./rename.ts";

export interface RenameSheetProps {
    readonly session: ActiveSession;
    readonly onClose: () => void;
}

export function RenameSheet({ session, onClose }: RenameSheetProps) {
    const [name, setName] = useState(session.title);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [saving, setSaving] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        input.current?.select();
    }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const save = async (): Promise<void> => {
        const next = name.trim();
        if (next.length === 0 || saving) return;
        setSaving(true);
        setProblem(undefined);
        const result = await renameSession(session, next);
        if (!result.ok) {
            setSaving(false);
            setProblem(result.message);
            return;
        }
        showToast(`Renamed to ${result.name ?? next}`, "success");
        onClose();
    };

    return (
        <div
            className="sheet-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="sheet session-sheet" role="dialog" aria-modal="true" aria-labelledby="rename-sheet-title">
                <div className="sheet-head">
                    <span className="session-sheet-title" id="rename-sheet-title">Rename the session</span>
                    <button type="button" className="sheet-x" onClick={onClose} aria-label="Close">
                        <XIcon />
                    </button>
                </div>

                <div className="sheet-body session-sheet-body">
                    <input
                        ref={input}
                        className="request-input"
                        type="text"
                        aria-label="Session name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                            event.preventDefault();
                            void save();
                        }}
                    />
                    {problem === undefined ? null : (
                        <p className="session-notice session-notice-error" role="alert">{problem}</p>
                    )}
                </div>

                <div className="session-sheet-foot">
                    <button
                        type="button"
                        className="button-primary session-sheet-action"
                        disabled={saving || name.trim().length === 0}
                        onClick={() => void save()}
                    >
                        {saving ? "Saving…" : "Rename"}
                    </button>
                </div>
            </div>
        </div>
    );
}

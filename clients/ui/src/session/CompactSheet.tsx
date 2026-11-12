import { useEffect, useState } from "react";

import { LayersIcon, XIcon } from "../components/Icons.tsx";
import { freshRequestId } from "../composer/requests.ts";
import type { ActiveSession } from "./activeSession.ts";
import type { CompactionState } from "./model.ts";
import { compactionNotice, tokenCount } from "./notices.ts";
import { compactCommand } from "./wireTools.ts";

export interface CompactSheetProps {
    readonly session: ActiveSession;
    readonly onClose: () => void;
}

// The compaction state seen when the person sent the request; a different object later is the answer.
interface SentCompact {
    readonly baseline: CompactionState | undefined;
}

export function CompactSheet({ session, onClose }: CompactSheetProps) {
    const [sent, setSent] = useState<SentCompact | undefined>(undefined);
    const { context, compaction } = session.watch;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const finished = sent !== undefined && compaction !== undefined && compaction !== sent.baseline && compaction.phase === "finished"
        ? compaction
        : undefined;
    const running = finished === undefined && (sent !== undefined || compaction?.phase === "started");
    const notice = finished === undefined ? undefined : compactionNotice(finished);

    const primary = () => {
        if (finished !== undefined) {
            onClose();
            return;
        }
        setSent({ baseline: compaction });
        session.send(compactCommand(freshRequestId("compact")));
    };

    const label = finished !== undefined ? "Done" : running ? "Compacting…" : "Compact now";

    return (
        <div
            className="sheet-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="sheet session-sheet" role="dialog" aria-modal="true" aria-labelledby="compact-sheet-title">
                <div className="sheet-head">
                    <LayersIcon className="session-sheet-icon" />
                    <span className="session-sheet-title" id="compact-sheet-title">Compact the conversation</span>
                    <button type="button" className="sheet-x" onClick={onClose} aria-label="Close">
                        <XIcon />
                    </button>
                </div>

                <div className="sheet-body session-sheet-body">
                    <p className="session-sheet-text">
                        Vera summarizes older messages so the conversation fits the model's window. Recent messages stay as they are.
                    </p>
                    <p className="session-sheet-text session-sheet-usage">
                        {context === undefined ? "No measurement yet." : usageText(context.tokens, context.capacity)}
                    </p>
                    {notice === undefined ? null : (
                        <p className={`session-notice session-notice-${notice.tone}`} role="status">
                            {notice.text}
                        </p>
                    )}
                </div>

                <div className="session-sheet-foot">
                    <button
                        type="button"
                        className="button-primary session-sheet-action"
                        disabled={running}
                        onClick={primary}
                    >
                        {label}
                    </button>
                </div>
            </div>
        </div>
    );
}

function usageText(tokens: number, capacity: number | undefined): string {
    if (capacity === undefined) return `The conversation uses about ${tokenCount(tokens)} tokens.`;
    const percent = capacity > 0 ? Math.round((tokens / capacity) * 100) : 0;
    return `The conversation uses ${percent}% of the window, ${tokenCount(tokens)} of ${tokenCount(capacity)} tokens.`;
}

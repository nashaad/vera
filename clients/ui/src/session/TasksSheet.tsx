import { useEffect, useState } from "react";

import { ClockIcon, XIcon } from "../components/Icons.tsx";
import { relativeTime, type SessionRow } from "../protocol/sessions.ts";
import { openCompanion } from "./paneLayout.ts";
import { useRouter } from "../pages/router.tsx";
import { useViewEnvironment } from "../views/env.tsx";
import type { ActiveSession } from "./activeSession.ts";
import { childRows, isRunningRow, unlistedChildTitles } from "./subagents.ts";

export interface SheetProps {
    readonly session: ActiveSession;
    readonly onClose: () => void;
}

// Escape closes the sheet. The sheet is a dialog over the page, so the page never sees the key.
export function useEscapeClose(onClose: () => void): void {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
}

export function TasksSheet({ session, onClose }: SheetProps) {
    useEscapeClose(onClose);
    return (
        <div
            className="sheet-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="sheet tasks-sheet" role="dialog" aria-modal="true" aria-label="Background tasks">
                <div className="sheet-head">
                    <ClockIcon className="tasks-head-icon" />
                    <span className="sheet-title">Background tasks</span>
                    <button type="button" className="sheet-x" onClick={onClose} aria-label="Close">
                        <XIcon />
                    </button>
                </div>
                <div className="sheet-body tasks-body">
                    <section className="tasks-section" aria-labelledby="tasks-subagents-heading">
                        <h3 id="tasks-subagents-heading" className="tasks-heading">Subagents</h3>
                        <SubagentList session={session} onClose={onClose} />
                    </section>
                    <section className="tasks-section" aria-labelledby="tasks-shell-heading">
                        <h3 id="tasks-shell-heading" className="tasks-heading">Shell processes</h3>
                        <p className="view-empty">The host does not list background shell processes.</p>
                    </section>
                </div>
            </div>
        </div>
    );
}

// Shared by the tasks sheet and the subagents sheet.
export function SubagentList({ session, onClose }: SheetProps) {
    const { connection } = useViewEnvironment();
    const { navigate } = useRouter();
    const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
    const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
    const rows = connection.sessionRows ?? [];
    const children = childRows(rows, session.agentId);
    const unlisted = unlistedChildTitles(session.watch.background, rows);
    const now = Date.now();

    const stop = async (row: SessionRow): Promise<void> => {
        setStopping((current) => new Set(current).add(row.id));
        setFailures((current) => {
            const next = { ...current };
            delete next[row.id];
            return next;
        });
        const result = await session.bridge.closeSession(row.id);
        setStopping((current) => {
            const next = new Set(current);
            next.delete(row.id);
            return next;
        });
        if (!result.ok) setFailures((current) => ({ ...current, [row.id]: result.reason }));
    };

    if (children.length === 0 && unlisted.length === 0) {
        return <p className="view-empty">No subagents in this session.</p>;
    }
    return (
        <ul className="subagent-list">
            {children.map((row) => {
                const running = isRunningRow(row);
                const failure = failures[row.id];
                return (
                    <li key={row.id} className="subagent" data-status={row.status} data-running={running}>
                        <div className="subagent-line">
                            <span className="session-dot" data-running={running} aria-hidden="true" />
                            <span className="subagent-name" title={row.name}>{row.name}</span>
                            <span className="session-time">{relativeTime(row.updatedAt, now)}</span>
                        </div>
                        <div className="subagent-actions">
                            <button
                                type="button"
                                className="subagent-action"
                                onClick={() => {
                                    openCompanion(session.agentId, row.id);
                                    onClose();
                                }}
                            >
                                Open
                            </button>
                            <button
                                type="button"
                                className="subagent-action"
                                onClick={() => {
                                    navigate({ kind: "session", agentId: row.id, title: row.name, workspace: row.workspace });
                                    onClose();
                                }}
                            >
                                Go to
                            </button>
                            {running ? (
                                <button
                                    type="button"
                                    className="subagent-action"
                                    disabled={stopping.has(row.id)}
                                    onClick={() => void stop(row)}
                                >
                                    Stop
                                </button>
                            ) : null}
                        </div>
                        {failure === undefined ? null : <p className="subagent-error" role="alert">{failure}</p>}
                    </li>
                );
            })}
            {unlisted.map((title) => (
                <li key={`untracked-${title}`} className="subagent" data-listed="false" data-running="true">
                    <div className="subagent-line">
                        <span className="session-dot" data-running="true" aria-hidden="true" />
                        <span className="subagent-name" title={title}>{title}</span>
                        <span className="session-time">Running</span>
                    </div>
                </li>
            ))}
        </ul>
    );
}

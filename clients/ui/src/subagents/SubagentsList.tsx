import { AgentIcon } from "../components/Icons.tsx";
import { relativeTime, type SessionRow } from "../protocol/sessions.ts";
import type { ActiveSession } from "../session/activeSession.ts";
import { splitChildren, statusWord, unlistedChildTitles } from "../session/subagents.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { subagentsTab } from "./store.ts";

// Running children first, then the ones that have ended. A child the session reports by title before the host
// lists it is shown without a way in.
export function SubagentsList({ session }: { readonly session: ActiveSession }) {
    const { connection } = useViewEnvironment();
    const rows = connection.sessionRows ?? [];
    const { active, done } = splitChildren(rows, session.agentId);
    const unlisted = unlistedChildTitles(session.watch.background, rows);
    if (active.length + done.length + unlisted.length === 0) {
        return <p className="view-empty">No subagents in this session.</p>;
    }
    const now = Date.now();
    return (
        <div className="subagents">
            <section className="tasks-section" aria-label="Active subagents">
                <h3 className="tasks-heading">Active · {active.length + unlisted.length}</h3>
                {active.length + unlisted.length === 0 ? (
                    <p className="tasks-intro">No active subagents</p>
                ) : (
                    <ul className="subagent-list">
                        {active.map((row) => <ChildRow key={row.id} row={row} parentId={session.agentId} now={now} />)}
                        {unlisted.map((title) => (
                            <li key={`untracked-${title}`}>
                                <div className="subagents-row" data-open="false">
                                    <AgentIcon className="subagent-list-icon" />
                                    <span className="subagent-name" title={title}>{title}</span>
                                    <span className="subagents-status">{statusWord("working")}</span>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            {done.length === 0 ? null : (
                <section className="tasks-section" aria-label="Finished subagents">
                    <h3 className="tasks-heading">Done · {done.length}</h3>
                    <ul className="subagent-list">
                        {done.map((row) => <ChildRow key={row.id} row={row} parentId={session.agentId} now={now} />)}
                    </ul>
                </section>
            )}
        </div>
    );
}

function ChildRow({ row, parentId, now }: { readonly row: SessionRow; readonly parentId: string; readonly now: number }) {
    return (
        <li>
            <button type="button" className="subagents-row" data-open="true" data-status={row.status} onClick={() => subagentsTab.show(parentId, row.id)}>
                <AgentIcon className="subagent-list-icon" />
                <span className="subagent-name" title={row.name}>{row.name}</span>
                <span className="subagents-status">{statusWord(row.status)}</span>
                <span className="session-time">{relativeTime(row.updatedAt, now)}</span>
            </button>
        </li>
    );
}

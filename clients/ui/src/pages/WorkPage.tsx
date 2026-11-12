import { useEffect, useState } from "react";

import { BellIcon, ChevronRightIcon } from "../components/Icons.tsx";
import { folderName } from "../protocol/sessionGroups.ts";
import { relativeTime, type SessionRow, type SessionStatus } from "../protocol/sessions.ts";
import { type FinishedEntry, useFinished } from "../state/finished.ts";
import { NOW_TICK_MS } from "../state/frameBudget.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { EmptyState, Page } from "./Page.tsx";
import { useRouter } from "./router.tsx";

export interface WorkRowView {
    readonly id: string;
    readonly name: string;
    readonly workspace: string;
    readonly status: SessionStatus;
    readonly detail: string;
}

export interface WorkBucket {
    readonly id: string;
    readonly title: string;
    readonly note: string;
    readonly warn: boolean;
    readonly rows: readonly WorkRowView[];
}

export function runningDetail(updatedAt: number | undefined, now: number): string {
    const age = relativeTime(updatedAt, now);
    if (age === "") return "Running";
    return age === "now" ? "Running · active now" : `Running · active ${age} ago`;
}

export function finishedDetail(finishedAt: number, now: number): string {
    const age = relativeTime(finishedAt, now);
    return age === "now" ? "Finished just now" : `Finished ${age} ago`;
}

function rowOf(row: SessionRow, detail: string): WorkRowView {
    return { id: row.id, name: row.name, workspace: row.workspace, status: row.status, detail };
}

// A session that is waiting or running now is listed there only, even if it finished earlier.
export function workBuckets(
    rows: readonly SessionRow[],
    finished: readonly FinishedEntry[],
    now: number,
): readonly WorkBucket[] {
    const waiting = rows.filter((row) => row.status === "waiting").map((row) => rowOf(row, "Waiting on you"));
    const working = rows
        .filter((row) => row.status === "working")
        .map((row) => rowOf(row, runningDetail(row.updatedAt, now)));
    const claimed = new Set([...waiting, ...working].map((row) => row.id));
    const settled = finished
        .filter((entry) => !claimed.has(entry.agentId))
        .map((entry): WorkRowView => ({
            id: entry.agentId,
            name: entry.name,
            workspace: entry.workspace,
            status: entry.status,
            detail: finishedDetail(entry.finishedAt, now),
        }));
    const buckets: WorkBucket[] = [
        {
            id: "needs-you",
            title: "Needs you",
            note: "Stopped at an approval or a question.",
            warn: true,
            rows: waiting,
        },
        {
            id: "running",
            title: "Running",
            note: "Working now. Nothing to do but let them finish.",
            warn: false,
            rows: working,
        },
        {
            id: "finished",
            title: "Finished since you last looked",
            note: "Settled in the last hour while this window was open, and not opened since.",
            warn: false,
            rows: settled,
        },
    ];
    return buckets.filter((bucket) => bucket.rows.length > 0);
}

function useNow(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
        return () => window.clearInterval(timer);
    }, []);
    return now;
}

function WorkRow({ row }: { readonly row: WorkRowView }) {
    const { navigate } = useRouter();
    const running = row.status === "working" || row.status === "waiting";
    return (
        <li>
            <button
                type="button"
                className="list-row"
                data-session={row.id}
                data-status={row.status}
                onClick={() => navigate({ kind: "session", agentId: row.id, title: row.name })}
            >
                <span className="session-dot" data-running={running} aria-hidden="true" />
                <span className="list-row-body">
                    <span className="list-row-name">
                        <span className="list-row-title">{row.name}</span>
                        <span className="badge" title={row.workspace}>{folderName(row.workspace)}</span>
                    </span>
                    <span className="list-row-detail">{row.detail}</span>
                </span>
                <ChevronRightIcon className="list-row-go" />
            </button>
        </li>
    );
}

export function WorkPage() {
    const { connection } = useViewEnvironment();
    const { navigate } = useRouter();
    const now = useNow();
    const finished = useFinished(now);
    const buckets = workBuckets(connection.sessionRows ?? [], finished, now);
    return (
        <Page title="Work" lede="Every session that needs you, is running, or just finished." Icon={BellIcon}>
            {buckets.length === 0 ? (
                <>
                    <EmptyState title="Nothing is waiting on you">
                        A session shows here while it works, when it stops for you, and for an hour after it finishes.
                    </EmptyState>
                    <div className="work-empty-actions">
                        <button type="button" className="solid-btn" onClick={() => navigate({ kind: "home" })}>
                            New chat
                        </button>
                    </div>
                </>
            ) : buckets.map((bucket) => (
                <section key={bucket.id} data-bucket={bucket.id}>
                    <h2 className="section-title" data-tone={bucket.warn ? "warn" : undefined}>
                        {bucket.title} <span className="section-count">{bucket.rows.length}</span>
                    </h2>
                    <p className="section-note">{bucket.note}</p>
                    <ul className="list">
                        {bucket.rows.map((row) => <WorkRow key={row.id} row={row} />)}
                    </ul>
                </section>
            ))}
        </Page>
    );
}

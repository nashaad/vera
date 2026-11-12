import { BellIcon } from "../components/Icons.tsx";
import { folderName } from "../protocol/sessionGroups.ts";
import { relativeTime, type SessionRow, type SessionStatus } from "../protocol/sessions.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { EmptyState, Page } from "./Page.tsx";
import { useRouter } from "./router.tsx";

interface Bucket {
    readonly id: string;
    readonly title: string;
    readonly note: string;
    readonly status: SessionStatus;
}

const BUCKETS: readonly Bucket[] = [
    { id: "needs-you", title: "Needs you", note: "Stopped at an approval or a question.", status: "waiting" },
    { id: "running", title: "Running", note: "Working now.", status: "working" },
];

function detail(row: SessionRow, now: number): string {
    const lead = row.status === "waiting" ? "Waiting on you" : "Working";
    const age = relativeTime(row.updatedAt, now);
    if (age === "") return lead;
    return age === "now" ? `${lead}, active now` : `${lead}, last active ${age} ago`;
}

function WorkRow({ row, now }: { readonly row: SessionRow; readonly now: number }) {
    const { navigate } = useRouter();
    return (
        <li>
            <button
                type="button"
                className="work-row"
                data-session={row.id}
                data-status={row.status}
                onClick={() => navigate({ kind: "session", agentId: row.id, title: row.name })}
            >
                <span className="session-dot" data-running="true" aria-hidden="true" />
                <span className="work-row-body">
                    <span className="work-row-name">
                        <span className="work-row-title">{row.name}</span>
                        <span className="work-row-folder" title={row.workspace}>{folderName(row.workspace)}</span>
                    </span>
                    <span className="work-row-detail">{detail(row, now)}</span>
                </span>
            </button>
        </li>
    );
}

export function WorkPage() {
    const { connection } = useViewEnvironment();
    const rows = connection.sessionRows ?? [];
    const now = Date.now();
    const buckets = BUCKETS
        .map((bucket) => ({ bucket, rows: rows.filter((row) => row.status === bucket.status) }))
        .filter((entry) => entry.rows.length > 0);
    return (
        <Page title="Work" lede="Every session that needs you or is running." Icon={BellIcon}>
            {buckets.length === 0 ? (
                <EmptyState title="Nothing is waiting on you">
                    No session is stopped at an approval or running. A session shows here while it works.
                </EmptyState>
            ) : buckets.map(({ bucket, rows: members }) => (
                <section key={bucket.id} className="work-bucket" data-bucket={bucket.id}>
                    <h2 className="section-title" data-tone={bucket.id === "needs-you" ? "warn" : undefined}>
                        {bucket.title} <span className="section-count">{members.length}</span>
                    </h2>
                    <p className="section-note">{bucket.note}</p>
                    <ul className="work-list">
                        {members.map((row) => <WorkRow key={row.id} row={row} now={now} />)}
                    </ul>
                </section>
            ))}
        </Page>
    );
}

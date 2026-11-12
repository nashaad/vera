import { useState } from "react";

import { ChevronRightIcon, PlusIcon } from "../components/Icons.tsx";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { folderName, groupSessions } from "../protocol/sessionGroups.ts";
import { relativeTime, type SessionRow, type SessionStatus } from "../protocol/sessions.ts";
import { useBranch } from "../composer/useBranch.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { deviceLabel } from "./devices.ts";
import { EmptyState, Page } from "./Page.tsx";
import { useRouter } from "./router.tsx";
import type { WorkspaceRoute } from "./routes.ts";

export interface WorkspaceStats {
    readonly sessions: string;
    readonly running: string;
    readonly needsYou: string;
    readonly lastActive: string;
}

export function statusPhrase(status: SessionStatus): string {
    if (status === "waiting") return "Waiting on you";
    if (status === "working") return "Running";
    return "Idle";
}

// `more` is true when the host has sessions beyond the loaded page, which may sit in this folder too.
export function workspaceStats(folderRows: readonly SessionRow[], more: boolean, now: number): WorkspaceStats {
    let newest: number | undefined;
    for (const row of folderRows) {
        if (row.updatedAt !== undefined && (newest === undefined || row.updatedAt > newest)) newest = row.updatedAt;
    }
    const age = relativeTime(newest, now);
    let lastActive = "Never";
    if (age === "now") lastActive = "Now";
    else if (age !== "") lastActive = `${age} ago`;
    return {
        sessions: `${folderRows.length}${more ? "+" : ""}`,
        running: String(folderRows.filter((row) => row.status === "working").length),
        needsYou: String(folderRows.filter((row) => row.status === "waiting").length),
        lastActive,
    };
}

function desktopBridge(): DesktopBridge | undefined {
    return typeof window === "undefined" ? undefined : window.veraDesktop;
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
    return (
        <div className="stat">
            <div className="stat-key">{label}</div>
            <div className="stat-value">{value}</div>
        </div>
    );
}

function WorkspaceRow({ row, nested, now }: { readonly row: SessionRow; readonly nested: boolean; readonly now: number }) {
    const { navigate } = useRouter();
    const running = row.status === "working" || row.status === "waiting";
    return (
        <li>
            <button
                type="button"
                className="list-row"
                data-session={row.id}
                data-status={row.status}
                data-nested={nested}
                onClick={() => navigate({ kind: "session", agentId: row.id, title: row.name })}
            >
                <span className="session-dot" data-running={running} aria-hidden="true" />
                <span className="list-row-body">
                    <span className="list-row-name">
                        <span className="list-row-title">{row.name}</span>
                    </span>
                    <span className="list-row-detail">{statusPhrase(row.status)}</span>
                </span>
                <span className="list-row-age">{relativeTime(row.updatedAt, now)}</span>
                <ChevronRightIcon className="list-row-go" />
            </button>
        </li>
    );
}

export function WorkspacePage({ route }: { readonly route: WorkspaceRoute }) {
    const { connection } = useViewEnvironment();
    const { navigate } = useRouter();
    const bridge = desktopBridge();
    const [revealFailed, setRevealFailed] = useState(false);
    const branch = useBranch(bridge, route.folder);

    const rows = connection.sessionRows ?? [];
    const folderRows = rows.filter((row) => row.workspace === route.folder);
    const more = connection.sessions !== undefined && connection.sessions > rows.length;
    const now = Date.now();
    const stats = workspaceStats(folderRows, more, now);
    const entries = groupSessions(folderRows).flatMap((group) => group.entries);
    const lede = [route.folder, branch, deviceLabel(bridge?.platform ?? "")].filter((part) => part !== undefined && part !== "").join(" · ");
    const revealLabel = bridge?.platform === "darwin" ? "Show in Finder" : "Open folder";

    async function reveal(): Promise<void> {
        if (bridge === undefined) return;
        const opened = await bridge.revealFolder(route.folder).catch(() => false);
        setRevealFailed(!opened);
    }

    return (
        <Page title={folderName(route.folder)} lede={lede}>
            <div className="toolbar">
                <button
                    type="button"
                    className="solid-btn"
                    onClick={() => navigate({ kind: "home", folder: route.folder })}
                >
                    <PlusIcon />
                    New chat here
                </button>
                <button type="button" className="ghost-btn" disabled={bridge === undefined} onClick={() => void reveal()}>
                    {revealLabel}
                </button>
            </div>
            {revealFailed ? <p className="workspace-note">The folder could not be opened.</p> : null}
            <div className="stat-grid">
                <Stat label="Sessions" value={stats.sessions} />
                <Stat label="Running" value={stats.running} />
                <Stat label="Needs you" value={stats.needsYou} />
                <Stat label="Last active" value={stats.lastActive} />
            </div>
            <h2 className="section-title">
                Sessions <span className="section-count">{stats.sessions}</span>
            </h2>
            {entries.length === 0 ? (
                <EmptyState title="No sessions here">Sessions started in this folder show here.</EmptyState>
            ) : (
                <ul className="list">
                    {entries.map(({ row, nested }) => (
                        <WorkspaceRow key={row.id} row={row} nested={nested} now={now} />
                    ))}
                </ul>
            )}
        </Page>
    );
}

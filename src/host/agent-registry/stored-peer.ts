import { storedPeerFacts } from "../../store/session-peer-metadata.ts";
import { workspaceKey } from "../../workspace-key.ts";
import type { PeerRosterEntry } from "./peer-services.ts";
import { gitRosterFacts, type RegisteredAgentSummary } from "./support.ts";

export const STORED_PEER_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
const STORED_PEER_LIMIT = 20;

export function isRecentPeerActivity(updated: number): boolean {
    return Number.isFinite(updated) && Date.now() - updated <= STORED_PEER_WINDOW_MS;
}

export function isRecentStoredPeerCandidate(summary: RegisteredAgentSummary, workspace: string): boolean {
    const updated = Date.parse(summary.updated_at ?? "");
    return summary.kind === "interactive"
        && summary.parent_id === undefined
        && !summary.live
        && summary.status !== "failed"
        && workspaceKey(summary.workspace) === workspaceKey(workspace)
        && isRecentPeerActivity(updated);
}

export function isRecentStoredPeer(summary: RegisteredAgentSummary, workspace: string): boolean {
    return isRecentStoredPeerCandidate(summary, workspace) && storedPeerFacts(summary)?.failed === false;
}

export function storedPeerRoster(
    summaries: Iterable<RegisteredAgentSummary>,
    callerId: string,
    workspace: string,
    details: boolean,
    excluded: ReadonlySet<string> = new Set(),
    gitFacts: (workspace: string) => ReturnType<typeof gitRosterFacts> = gitRosterFacts,
): PeerRosterEntry[] {
    const recent: RegisteredAgentSummary[] = [];
    const compare = (left: RegisteredAgentSummary, right: RegisteredAgentSummary): number =>
        Date.parse(right.updated_at ?? "") - Date.parse(left.updated_at ?? "") || left.id.localeCompare(right.id);
    for (const summary of summaries) {
        if (summary.id === callerId || excluded.has(summary.id) || !isRecentStoredPeer(summary, workspace)) continue;
        const duplicate = recent.findIndex((entry) => entry.id === summary.id);
        if (duplicate !== -1) {
            if (compare(recent[duplicate]!, summary) <= 0) continue;
            recent.splice(duplicate, 1);
        }
        const before = recent.findIndex((entry) => compare(summary, entry) < 0);
        if (before === -1) {
            if (recent.length < STORED_PEER_LIMIT) recent.push(summary);
        } else {
            recent.splice(before, 0, summary);
            if (recent.length > STORED_PEER_LIMIT) recent.pop();
        }
    }
    return recent.map((summary) => {
        const name = storedPeerFacts(summary)?.name;
        return {
            participant_id: summary.id,
            ...(name === undefined ? {} : { name }),
            ...(summary.title === undefined ? {} : { title: summary.title }),
            status: "parked",
            live: false,
            ...(details ? {
                session_path: summary.session_path,
                workspace: summary.workspace,
                workspace_key: workspaceKey(summary.workspace),
                kind: summary.kind,
                last_activity: summary.updated_at,
                notice: "none",
                ...gitFacts(summary.workspace),
            } : {}),
        };
    });
}


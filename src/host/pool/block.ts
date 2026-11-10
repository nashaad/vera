import type { BlockSessionRequest, UnblockSessionRequest } from "../protocol.ts";
import type { BlockSessionOutcome, UnblockSessionOutcome } from "../server.ts";
import { startedTreeOf } from "../session-block.ts";
import type { SessionOwner, WorkerOwner } from "./roster.ts";
import type { OwnedSession, SessionEndpoint } from "./session-endpoint.ts";

export async function blockAcrossOwners(
    endpoints: ReadonlyMap<SessionOwner, SessionEndpoint>, primary: WorkerOwner,
    sessions: readonly OwnedSession[], request: BlockSessionRequest,
    residents: () => Promise<readonly OwnedSession[]>, waitForStarts: (ids: readonly string[]) => Promise<void>,
): Promise<BlockSessionOutcome> {
    const host = endpoints.get("host")!;
    const worker = endpoints.get(primary)!;
    const root = sessions.find((entry) => entry.session.id === request.target_agent_id);
    const writer = endpoints.get(root?.owner ?? primary)!;
    if (!await writer.blockHasSession(request.target_agent_id)) return { status: "rejected", reason: "not_found" };
    const fenced = new Set<string>();
    const ids: string[] = [];
    let current = sessions;
    while (true) {
        const hostPaths = current.filter((entry) => entry.owner === "host").map((entry) => entry.session.sessionPath);
        const [hostRows, workerRows] = await Promise.all([
            host.blockTreeShard(hostPaths), worker.blockTreeShard(undefined, hostPaths),
        ]);
        const parents = new Map<string, string>();
        for (const row of [...hostRows, ...workerRows].sort((left, right) => left.order - right.order)) {
            if (row.parent !== undefined) parents.set(row.id, row.parent);
        }
        for (const entry of current) {
            if (entry.session.parentId !== undefined) parents.set(entry.session.id, entry.session.parentId);
        }
        const found = [...new Set([...startedTreeOf(request.target_agent_id, parents), ...request.session_ids])];
        const added = found.filter((id) => !fenced.has(id));
        if (added.length === 0) return { status: "blocked", sessionIds: ids };
        ids.push(...added);
        const abort = async (): Promise<void> => {
            await Promise.all([...endpoints.values()].map((endpoint) => endpoint.blockAbort(ids)));
        };
        await abort();
        if (!await writer.blockWrite(request, added)) {
            await abort();
            return { status: "rejected", reason: "failed" };
        }
        for (const id of added) fenced.add(id);
        await Promise.all([...endpoints.values()].map((endpoint) => endpoint.blockConfirm(ids)));
        await abort();
        await waitForStarts(ids);
        current = await residents();
    }
}

export async function unblockAcrossOwners(
    endpoints: ReadonlyMap<SessionOwner, SessionEndpoint>, primary: WorkerOwner, request: UnblockSessionRequest,
): Promise<UnblockSessionOutcome> {
    const worker = endpoints.get(primary)!;
    const blocked = await worker.blockedIds(request.session_ids);
    if (blocked.length === 0) return { status: "rejected", reason: "not_found" };
    await Promise.all([...endpoints.values()].map((endpoint) => endpoint.blockConfirm(blocked)));
    const removed = await worker.blockRemove(blocked);
    const unconfirmed = (await Promise.all([...endpoints.values()].map((endpoint) => endpoint.blockRelease(removed)))).flat();
    return removed.length === 0
        ? { status: "rejected", reason: "not_found" }
        : { status: "unblocked", sessionIds: removed, unconfirmedSessionIds: unconfirmed };
}

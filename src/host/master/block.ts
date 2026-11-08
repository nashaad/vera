import type { BlockSessionRequest, UnblockSessionRequest } from "../protocol.ts";
import type { BlockSessionOutcome, UnblockSessionOutcome } from "../server.ts";
import { startedTreeOf } from "../session-block.ts";
import type { SessionOwner } from "./roster.ts";
import type { OwnedSession, SessionEndpoint } from "./session-endpoint.ts";

export async function blockAcrossOwners(
    master: SessionEndpoint, worker: SessionEndpoint, sessions: readonly OwnedSession[], request: BlockSessionRequest,
    residents: () => Promise<readonly OwnedSession[]>, waitForStarts: (ids: readonly string[]) => Promise<void>,
): Promise<BlockSessionOutcome> {
    const endpoint = (owner: SessionOwner) => owner === "host" ? master : worker;
    const byId = new Map(sessions.map((entry) => [entry.session.id, entry]));
    const root = byId.get(request.target_agent_id);
    const writer = endpoint(root?.owner ?? "w0");
    if (!await writer.blockHasSession(request.target_agent_id)) return { status: "rejected", reason: "not_found" };
    const fenced = new Set<string>();
    const ids: string[] = [];
    let current = sessions;
    while (true) {
        const masterPaths = current.filter((entry) => entry.owner === "host").map((entry) => entry.session.sessionPath);
        const [masterRows, workerRows] = await Promise.all([
            master.blockTreeShard(masterPaths), worker.blockTreeShard(undefined, masterPaths),
        ]);
        const parents = new Map<string, string>();
        for (const row of [...masterRows, ...workerRows].sort((left, right) => left.order - right.order)) {
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
            await Promise.all([master.blockAbort(ids), worker.blockAbort(ids)]);
        };
        await abort();
        if (!await writer.blockWrite(request, added)) {
            await abort();
            return { status: "rejected", reason: "failed" };
        }
        for (const id of added) fenced.add(id);
        await Promise.all([master.blockConfirm(ids), worker.blockConfirm(ids)]);
        await abort();
        await waitForStarts(ids);
        current = await residents();
    }
}

export async function unblockAcrossOwners(
    master: SessionEndpoint, worker: SessionEndpoint, _sessions: readonly OwnedSession[], request: UnblockSessionRequest,
): Promise<UnblockSessionOutcome> {
    const blocked = await worker.blockedIds(request.session_ids);
    if (blocked.length === 0) return { status: "rejected", reason: "not_found" };
    await Promise.all([master.blockConfirm(blocked), worker.blockConfirm(blocked)]);
    const removed = await worker.blockRemove(blocked);
    const unconfirmed = (await Promise.all([
        master.blockRelease(removed), worker.blockRelease(removed),
    ])).flat();
    return removed.length === 0
        ? { status: "rejected", reason: "not_found" }
        : { status: "unblocked", sessionIds: removed, unconfirmedSessionIds: unconfirmed };
}

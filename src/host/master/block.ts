import type { BlockSessionRequest, UnblockSessionRequest } from "../protocol.ts";
import type { BlockSessionOutcome, UnblockSessionOutcome } from "../server.ts";
import { startedTreeOf } from "../session-block.ts";
import type { SessionOwner } from "./roster.ts";
import type { OwnedSession, SessionEndpoint } from "./session-endpoint.ts";

export async function blockAcrossOwners(
    master: SessionEndpoint, worker: SessionEndpoint, sessions: readonly OwnedSession[], request: BlockSessionRequest,
): Promise<BlockSessionOutcome> {
    const endpoint = (owner: SessionOwner) => owner === "host" ? master : worker;
    const byId = new Map(sessions.map((entry) => [entry.session.id, entry]));
    const root = byId.get(request.target_agent_id);
    const writer = endpoint(root?.owner ?? "w0");
    if (!await writer.blockHasSession(request.target_agent_id)) return { status: "rejected", reason: "not_found" };
    const masterPaths = sessions.filter((entry) => entry.owner === "host").map((entry) => entry.session.sessionPath);
    const [masterRows, workerRows] = await Promise.all([
        master.blockTreeShard(masterPaths), worker.blockTreeShard(undefined, masterPaths),
    ]);
    const parents = new Map<string, string>();
    for (const row of [...masterRows, ...workerRows].sort((left, right) => left.order - right.order)) {
        if (row.parent !== undefined) parents.set(row.id, row.parent);
    }
    for (const entry of sessions) {
        if (entry.session.parentId !== undefined) parents.set(entry.session.id, entry.session.parentId);
    }
    const ids = [...new Set([...startedTreeOf(request.target_agent_id, parents), ...request.session_ids])];
    const abort = async (): Promise<void> => {
        for (const id of ids) {
            const owner = byId.get(id)?.owner;
            if (owner !== undefined) await endpoint(owner).blockAbort([id]);
        }
    };
    await abort();
    if (!await writer.blockWrite(request, ids)) {
        await abort();
        return { status: "rejected", reason: "failed" };
    }
    await Promise.all([master.blockConfirm(ids), worker.blockConfirm(ids)]);
    await abort();
    return { status: "blocked", sessionIds: ids };
}

export async function unblockAcrossOwners(
    master: SessionEndpoint, worker: SessionEndpoint, sessions: readonly OwnedSession[], request: UnblockSessionRequest,
): Promise<UnblockSessionOutcome> {
    const blocked = await worker.blockedIds(request.session_ids);
    if (blocked.length === 0) return { status: "rejected", reason: "not_found" };
    await Promise.all([master.blockConfirm(blocked), worker.blockConfirm(blocked)]);
    const removed = await worker.blockRemove(blocked);
    const owners = new Map(sessions.map((entry) => [entry.session.id, entry.owner]));
    const unconfirmed: string[] = [];
    for (const id of removed) {
        const owner = owners.get(id);
        if (owner !== undefined) unconfirmed.push(...await (owner === "host" ? master : worker).blockRelease([id]));
    }
    return removed.length === 0
        ? { status: "rejected", reason: "not_found" }
        : { status: "unblocked", sessionIds: removed, unconfirmedSessionIds: unconfirmed };
}

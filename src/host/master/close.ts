import type { ClosedMember } from "../agent-registry/support.ts";
import type { CloseAgentOutcome } from "../server.ts";
import type { SessionEndReason } from "../../sdk/hooks.ts";
import type { SessionOwner } from "./roster.ts";
import type { CloseTicket, OwnedSession, SessionEndpoint } from "./session-endpoint.ts";

export async function closeAcrossOwners(
    master: SessionEndpoint,
    worker: SessionEndpoint,
    root: OwnedSession,
    members: OwnedSession[],
    reason: SessionEndReason,
    expand: () => Promise<readonly OwnedSession[]>,
): Promise<CloseAgentOutcome> {
    const endpoint = (owner: SessionOwner) => owner === "host" ? master : worker;
    const tickets = new Map<SessionOwner, CloseTicket[]>([["host", []], ["w0", []]]);
    const closed = new Map<SessionOwner, ClosedMember[]>([["host", []], ["w0", []]]);
    try {
        let pending = [...members];
        while (pending.length > 0) {
            const hostIds = pending.filter((member) => member.owner === "host").map((member) => member.session.id);
            const workerIds = pending.filter((member) => member.owner === "w0").map((member) => member.session.id);
            const results = await Promise.allSettled([master.quiesceClose(hostIds), worker.quiesceClose(workerIds)]);
            const [host, child] = results;
            if (host.status === "fulfilled") tickets.get("host")!.push(...host.value);
            if (child.status === "fulfilled") tickets.get("w0")!.push(...child.value);
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
            await Promise.all([
                master.waitClose(host.status === "fulfilled" ? host.value : []),
                worker.waitClose(child.status === "fulfilled" ? child.value : []),
            ]);
            pending = [...await expand()];
            members.push(...pending);
        }
        for (const member of members) {
            const ticket = tickets.get(member.owner)!.find((item) => item.id === member.session.id);
            if (ticket === undefined) continue;
            const result = await endpoint(member.owner).finishCloseMember(ticket, reason);
            if (result !== undefined) closed.get(member.owner)!.push(result);
        }
        await Promise.all([
            ...(tickets.get("host")!.length === 0 ? [] : [master.recordClosedMembers(closed.get("host")!)]),
            ...(tickets.get("w0")!.length === 0 ? [] : [worker.recordClosedMembers(closed.get("w0")!)]),
        ]);
        return { status: "closed", sessionRetained: root.session.ephemeral !== true };
    } finally {
        await Promise.allSettled([master.forgetClose(tickets.get("host")!), worker.forgetClose(tickets.get("w0")!)]);
    }
}

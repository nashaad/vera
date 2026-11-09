import type { ClosedMember } from "../agent-registry/support.ts";
import type { CloseAgentOutcome } from "../server.ts";
import type { SessionEndReason } from "../../sdk/hooks.ts";
import type { SessionOwner } from "./roster.ts";
import type { CloseTicket, OwnedSession, SessionEndpoint } from "./session-endpoint.ts";

export async function closeAcrossOwners(
    endpoints: ReadonlyMap<SessionOwner, SessionEndpoint>,
    root: OwnedSession,
    members: OwnedSession[],
    reason: SessionEndReason,
    expand: () => Promise<readonly OwnedSession[]>,
): Promise<CloseAgentOutcome> {
    const tickets = new Map<SessionOwner, CloseTicket[]>([...endpoints.keys()].map((owner) => [owner, []]));
    const closed = new Map<SessionOwner, ClosedMember[]>([...endpoints.keys()].map((owner) => [owner, []]));
    try {
        let pending = [...members];
        while (pending.length > 0) {
            const owners = [...endpoints.entries()];
            const results = await Promise.allSettled(owners.map(async ([owner, endpoint]) => {
                const ids = pending.filter((member) => member.owner === owner).map((member) => member.session.id);
                return await endpoint.quiesceClose(ids);
            }));
            for (let index = 0; index < results.length; index += 1) {
                const result = results[index]!;
                if (result.status === "fulfilled") tickets.get(owners[index]![0])!.push(...result.value);
            }
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
            await Promise.all(owners.map(async ([owner, endpoint], index) => {
                const result = results[index]!;
                await endpoint.waitClose(result.status === "fulfilled" ? result.value : []);
            }));
            pending = [...await expand()];
            members.push(...pending);
        }
        for (const member of members) {
            const ticket = tickets.get(member.owner)!.find((item) => item.id === member.session.id);
            if (ticket === undefined) continue;
            const result = await endpoints.get(member.owner)!.finishCloseMember(ticket, reason);
            if (result !== undefined) closed.get(member.owner)!.push(result);
        }
        await Promise.all([...endpoints.entries()].flatMap(([owner, endpoint]) =>
            tickets.get(owner)!.length === 0 ? [] : [endpoint.recordClosedMembers(closed.get(owner)!)]
        ));
        return { status: "closed", sessionRetained: root.session.ephemeral !== true };
    } finally {
        await Promise.allSettled([...endpoints.entries()].map(([owner, endpoint]) => endpoint.forgetClose(tickets.get(owner)!)));
    }
}

import type { ClosedMember } from "../agent-registry/support.ts";
import type { TrashRestartPlan } from "../agent-registry/trash.ts";
import type { SessionOwner } from "./roster.ts";
import type { CloseTicket, OwnedSession, SessionEndpoint } from "./session-endpoint.ts";

export interface PreparedTrash {
    readonly root: OwnedSession;
    readonly members: OwnedSession[];
    readonly residents: readonly OwnedSession[];
    readonly plans: readonly TrashRestartPlan[];
}

export async function trashAcrossOwners(
    endpoints: ReadonlyMap<SessionOwner, SessionEndpoint>,
    prepared: PreparedTrash,
    parentClosing: (id: string) => boolean,
    expand: () => Promise<readonly OwnedSession[]>,
): Promise<"trashed" | "failed"> {
    const tickets = new Map<SessionOwner, CloseTicket[]>([...endpoints.keys()].map((owner) => [owner, []]));
    const closed = new Map<SessionOwner, ClosedMember[]>([...endpoints.keys()].map((owner) => [owner, []]));
    const finished = new Set<string>();
    let trashed = false;
    try {
        const quiesce = async (first: readonly OwnedSession[]): Promise<void> => {
            let pending = [...first];
            while (pending.length > 0) {
                const owners = [...endpoints.entries()];
                const results = await Promise.allSettled(owners.map(([owner, endpoint]) =>
                    endpoint.quiesceClose(pending.filter((member) => member.owner === owner).map((member) => member.session.id))
                ));
                for (let index = 0; index < results.length; index += 1) {
                    const result = results[index]!;
                    if (result.status === "fulfilled") tickets.get(owners[index]![0])!.push(...result.value);
                }
                const failure = results.find((result) => result.status === "rejected");
                if (failure?.status === "rejected") throw failure.reason;
                await Promise.all(owners.map(async ([, endpoint], index) => {
                    const result = results[index]!;
                    await endpoint.waitClose(result.status === "fulfilled" ? result.value : []);
                }));
                pending = [...await expand()];
                prepared.members.push(...pending);
            }
        };
        const finish = async (): Promise<void> => {
            for (const member of prepared.members) {
                const ticket = tickets.get(member.owner)!.find((item) => item.id === member.session.id && !finished.has(item.token));
                if (ticket === undefined) continue;
                finished.add(ticket.token);
                const result = await endpoints.get(member.owner)!.finishCloseMember(ticket, "deleted");
                if (result !== undefined) closed.get(member.owner)!.push(result);
            }
        };
        await quiesce(prepared.members);
        await finish();
        const rootPlan = prepared.plans.find((plan) => plan.id === prepared.root.session.id)!;
        trashed = await endpoints.get(prepared.root.owner)!.moveTrashArtifact(rootPlan);
        if (trashed) {
            const late = [...await expand()];
            prepared.members.push(...late);
            await quiesce(late);
            await finish();
        } else {
            const plans = new Map(prepared.plans.map((plan) => [plan.id, plan]));
            const restarted = new Set<string>();
            const ordered = [prepared.root, ...prepared.members.slice(1).toReversed()];
            const accepts = async (plan: TrashRestartPlan): Promise<boolean> => {
                if (plan.parentId === undefined) return true;
                const parent = prepared.residents.find((member) => member.session.id === plan.parentId);
                if (plans.has(plan.parentId)) {
                    if (!restarted.has(plan.parentId)) return false;
                } else if (parentClosing(plan.parentId)) return false;
                if (parent === undefined) return !plan.parentRegistered;
                const current = await endpoints.get(parent.owner)!.resident(plan.parentId);
                return current !== undefined && current.closed !== true && current.failed !== true;
            };
            for (const member of ordered) {
                const plan = plans.get(member.session.id);
                if (plan === undefined || !(await accepts(plan))) continue;
                const endpoint = endpoints.get(member.owner)!;
                if (!(await endpoint.restartTrashMember(plan))) continue;
                if (!(await accepts(plan))) {
                    await endpoint.abandonTrashRestart(plan.id);
                    continue;
                }
                restarted.add(plan.id);
            }
        }
        await Promise.all([...endpoints.entries()].map(([owner, endpoint]) =>
            endpoint.recordTrashOutcome(prepared.root.session.id, closed.get(owner)!, trashed)
        ));
        return trashed ? "trashed" : "failed";
    } catch (error) {
        await Promise.allSettled([...endpoints.entries()].map(([owner, endpoint]) => endpoint.waitClose(tickets.get(owner)!)));
        for (const member of prepared.members) {
            const ticket = tickets.get(member.owner)!.find((item) => item.id === member.session.id && !finished.has(item.token));
            if (ticket === undefined) continue;
            finished.add(ticket.token);
            try {
                const result = await endpoints.get(member.owner)!.finishCloseMember(ticket, "deleted");
                if (result !== undefined) closed.get(member.owner)!.push(result);
            } catch {}
        }
        await Promise.allSettled([...endpoints.entries()].map(([owner, endpoint]) =>
            endpoint.recordTrashOutcome(prepared.root.session.id, closed.get(owner)!, trashed)
        ));
        throw error;
    } finally {
        await Promise.allSettled([...endpoints.entries()].map(([owner, endpoint]) => endpoint.forgetClose(tickets.get(owner)!)));
    }
}

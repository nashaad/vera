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
    master: SessionEndpoint,
    worker: SessionEndpoint,
    prepared: PreparedTrash,
    parentClosing: (id: string) => boolean,
    expand: () => Promise<readonly OwnedSession[]>,
): Promise<"trashed" | "failed"> {
    const endpoint = (owner: SessionOwner) => owner === "host" ? master : worker;
    const tickets = new Map<SessionOwner, CloseTicket[]>([["host", []], ["w0", []]]);
    const closed = new Map<SessionOwner, ClosedMember[]>([["host", []], ["w0", []]]);
    const finished = new Set<string>();
    let trashed = false;
    try {
        const quiesce = async (first: readonly OwnedSession[]): Promise<void> => {
            let pending = [...first];
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
                prepared.members.push(...pending);
            }
        };
        const finish = async (): Promise<void> => {
            for (const member of prepared.members) {
                const ticket = tickets.get(member.owner)!.find((item) => item.id === member.session.id && !finished.has(item.token));
                if (ticket === undefined) continue;
                finished.add(ticket.token);
                const result = await endpoint(member.owner).finishCloseMember(ticket, "deleted");
                if (result !== undefined) closed.get(member.owner)!.push(result);
            }
        };
        await quiesce(prepared.members);
        await finish();
        const rootPlan = prepared.plans.find((plan) => plan.id === prepared.root.session.id)!;
        trashed = await endpoint(prepared.root.owner).moveTrashArtifact(rootPlan);
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
                const current = await endpoint(parent.owner).resident(plan.parentId);
                return current !== undefined && current.closed !== true && current.failed !== true;
            };
            for (const member of ordered) {
                const plan = plans.get(member.session.id);
                if (plan === undefined || !(await accepts(plan))) continue;
                if (!(await endpoint(member.owner).restartTrashMember(plan))) continue;
                if (!(await accepts(plan))) {
                    await endpoint(member.owner).abandonTrashRestart(plan.id);
                    continue;
                }
                restarted.add(plan.id);
            }
        }
        await Promise.all([
            master.recordTrashOutcome(prepared.root.session.id, closed.get("host")!, trashed),
            worker.recordTrashOutcome(prepared.root.session.id, closed.get("w0")!, trashed),
        ]);
        return trashed ? "trashed" : "failed";
    } catch (error) {
        await Promise.allSettled([
            master.waitClose(tickets.get("host")!), worker.waitClose(tickets.get("w0")!),
        ]);
        for (const member of prepared.members) {
            const ticket = tickets.get(member.owner)!.find((item) => item.id === member.session.id && !finished.has(item.token));
            if (ticket === undefined) continue;
            finished.add(ticket.token);
            try {
                const result = await endpoint(member.owner).finishCloseMember(ticket, "deleted");
                if (result !== undefined) closed.get(member.owner)!.push(result);
            } catch {}
        }
        await Promise.allSettled([
            master.recordTrashOutcome(prepared.root.session.id, closed.get("host")!, trashed),
            worker.recordTrashOutcome(prepared.root.session.id, closed.get("w0")!, trashed),
        ]);
        throw error;
    } finally {
        await Promise.allSettled([master.forgetClose(tickets.get("host")!), worker.forgetClose(tickets.get("w0")!)]);
    }
}

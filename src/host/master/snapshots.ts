import type { RegisteredAgentSummary } from "../agent-registry.ts";
import { buildWorkIndex, EMPTY_WORK_INDEX, type WorkIndexSnapshot } from "../work-index.ts";
import { mergeRosters, type SessionOwner } from "./roster.ts";
import type { RouterWorker } from "./router.ts";
import type { SessionEndpoint, SessionSnapshot } from "./session-endpoint.ts";

export class RoutedSnapshots {
    private readonly listeners = new Set<() => void>();
    private pending: Promise<void> = Promise.resolve();
    private summaries: readonly RegisteredAgentSummary[] = [];
    private index: WorkIndexSnapshot = EMPTY_WORK_INDEX;

    constructor(
        private readonly master: SessionEndpoint,
        private readonly workers: readonly RouterWorker[],
        private readonly observe: (owner: SessionOwner, snapshot: SessionSnapshot) => void,
    ) {}

    refresh(): void {
        const owners: Array<[SessionOwner, SessionEndpoint]> = [
            ["host", this.master], ...this.workers.filter((worker) => worker.ready()).map((worker): [SessionOwner, SessionEndpoint] => [worker.id, worker.endpoint]),
        ];
        const snapshots = Promise.all(owners.map(([, endpoint]) => endpoint.snapshot())).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
        this.pending = this.pending.then(async () => {
            const result = await snapshots;
            if ("error" in result) throw result.error;
            const current = owners.flatMap(([owner], index) =>
                owner === "host" || this.workers.some((worker) => worker.id === owner && worker.ready())
                    ? [{ owner, snapshot: result.value[index]! }] : []
            );
            const residentOwners = new Map<string, SessionOwner>();
            const unread = new Set<string>();
            const agents = current.flatMap(({ owner, snapshot }) => {
                for (const session of snapshot.residents) residentOwners.set(session.id, owner);
                for (const id of snapshot.unreadSources) unread.add(id);
                this.observe(owner, snapshot);
                return snapshot.work;
            }).map((fact) => unread.has(fact.id) ? { ...fact, unread_result: true } : fact);
            const schedules = await this.master.workSchedules(agents);
            this.summaries = mergeRosters(current.map(({ owner, snapshot }) => [owner, snapshot.summaries] as const),
                (id) => residentOwners.get(id));
            this.index = buildWorkIndex(agents, schedules);
            for (const listener of [...this.listeners]) {
                try { listener(); } catch {}
            }
        }).catch(() => {});
    }

    wait(): Promise<void> { return this.pending; }
    list(): readonly RegisteredAgentSummary[] { return this.summaries; }
    workIndex(): WorkIndexSnapshot { return this.index; }

    onChanged(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
}

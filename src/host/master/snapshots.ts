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
    private readonly lastWorkers = new Map<SessionOwner, SessionSnapshot>();

    constructor(
        private readonly master: SessionEndpoint,
        private readonly workers: readonly RouterWorker[],
        private readonly revision: () => number,
        private readonly observe: (owner: SessionOwner, snapshot: SessionSnapshot, revision: number) => void,
    ) {}

    refresh(): void {
        const revision = this.revision();
        const owners: Array<[SessionOwner, SessionEndpoint]> = [
            ["host", this.master], ...this.workers.filter((worker) => worker.ready()).map((worker): [SessionOwner, SessionEndpoint] => [worker.id, worker.endpoint]),
        ];
        const generations = new Map(this.workers.map((worker) => [worker.id, worker.generation()]));
        const snapshots = Promise.all(owners.map(([, endpoint]) => endpoint.snapshot())).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
        this.pending = this.pending.then(async () => {
            const result = await snapshots;
            if ("error" in result) throw result.error;
            const current: Array<{ owner: SessionOwner; snapshot: SessionSnapshot; cached?: true }> = owners.flatMap(([owner], index) =>
                owner === "host" || this.workers.some((worker) => worker.id === owner && worker.ready()
                    && worker.generation() === generations.get(worker.id))
                    ? [{ owner, snapshot: result.value[index]! }] : []
            );
            for (const entry of current) {
                if (entry.owner === "host") continue;
                const pid = this.workers.find((worker) => worker.id === entry.owner)?.pid?.();
                if (pid !== undefined) {
                    entry.snapshot = {
                        ...entry.snapshot,
                        summaries: entry.snapshot.summaries.map((summary) => ({
                            ...summary,
                            worker_pid: pid,
                        })),
                    };
                }
                this.lastWorkers.set(entry.owner, entry.snapshot);
            }
            for (const worker of this.workers) {
                if (worker.ready()) continue;
                const snapshot = this.lastWorkers.get(worker.id);
                if (snapshot !== undefined) current.push({ owner: worker.id, snapshot, cached: true });
            }
            const residentOwners = new Map<string, SessionOwner>();
            const unread = new Set<string>();
            const agents = current.flatMap(({ owner, snapshot, cached }) => {
                for (const session of snapshot.residents) residentOwners.set(session.id, owner);
                for (const id of snapshot.unreadSources) unread.add(id);
                if (!cached) this.observe(owner, snapshot, revision);
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

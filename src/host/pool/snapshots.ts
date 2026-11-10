import type { RegisteredAgentSummary } from "../agent-registry.ts";
import { buildWorkIndex, EMPTY_WORK_INDEX, type WorkIndexSnapshot } from "../work-index.ts";
import { mergeRosters, type SessionOwner } from "./roster.ts";
import type { RouterWorker } from "./router.ts";
import type { SessionEndpoint, SessionSnapshot } from "./session-endpoint.ts";

interface SnapshotWaiter {
    readonly target: number;
    readonly resolve: () => void;
}

export class RoutedSnapshots {
    private readonly listeners = new Set<() => void>();
    private readonly waiters: SnapshotWaiter[] = [];
    private requested = 0;
    private completed = 0;
    private running = false;
    private summaries: readonly RegisteredAgentSummary[] = [];
    private index: WorkIndexSnapshot = EMPTY_WORK_INDEX;
    private readonly lastWorkers = new Map<SessionOwner, SessionSnapshot>();

    constructor(
        private readonly host: SessionEndpoint,
        private readonly workers: readonly RouterWorker[],
        private readonly revision: () => number,
        private readonly observe: (owner: SessionOwner, snapshot: SessionSnapshot, revision: number) => void,
    ) {}

    refresh(): void {
        this.requested += 1;
        if (this.running) return;
        this.running = true;
        void this.refreshLoop();
    }

    private async refreshLoop(): Promise<void> {
        while (this.completed < this.requested) {
            const target = this.requested;
            try { await this.refreshOnce(); } catch {}
            this.completed = target;
            for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
                const waiter = this.waiters[index]!;
                if (waiter.target > target) continue;
                this.waiters.splice(index, 1);
                waiter.resolve();
            }
        }
        this.running = false;
    }

    private async refreshOnce(): Promise<void> {
        const revision = this.revision();
        const owners: Array<[SessionOwner, SessionEndpoint]> = [
            ["host", this.host], ...this.workers.filter((worker) => worker.ready()).map((worker): [SessionOwner, SessionEndpoint] => [worker.id, worker.endpoint]),
        ];
        const generations = new Map(this.workers.map((worker) => [worker.id, worker.generation()]));
        const snapshots = await Promise.all(owners.map(([, endpoint]) => endpoint.snapshot()));
        const current: Array<{ owner: SessionOwner; snapshot: SessionSnapshot; cached?: true }> = owners.flatMap(([owner], index) =>
            owner === "host" || this.workers.some((worker) => worker.id === owner && worker.ready()
                && worker.generation() === generations.get(worker.id))
                ? [{ owner, snapshot: snapshots[index]! }] : []
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
        const schedules = await this.host.workSchedules(agents);
        this.summaries = mergeRosters(current.map(({ owner, snapshot }) => [owner, snapshot.summaries] as const),
            (id) => residentOwners.get(id));
        this.index = buildWorkIndex(agents, schedules);
        for (const listener of [...this.listeners]) {
            try { listener(); } catch {}
        }
    }

    wait(): Promise<void> {
        const target = this.requested;
        if (target <= this.completed) return Promise.resolve();
        return new Promise<void>((resolve) => this.waiters.push({ target, resolve }));
    }
    list(): readonly RegisteredAgentSummary[] { return this.summaries; }
    workIndex(): WorkIndexSnapshot { return this.index; }

    onChanged(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
}

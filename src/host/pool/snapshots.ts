import type { RegisteredAgentSummary } from "../agent-registry.ts";
import { buildWorkIndex, EMPTY_WORK_INDEX, type WorkIndexSnapshot } from "../work-index.ts";
import { mergeRosters, type SessionOwner } from "./roster.ts";
import { ROSTER_ENDPOINT_DEADLINE_MS, type RouterWorker, type RoutedAgentList } from "./router.ts";
import type { SessionEndpoint, SessionSnapshot } from "./session-endpoint.ts";

interface SnapshotWaiter {
    readonly target: number;
    readonly resolve: (result: RoutedAgentList) => void;
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
    private completedResult: RoutedAgentList = { agents: [], unavailableWorkers: [] };

    constructor(
        private readonly host: SessionEndpoint,
        private readonly workers: readonly RouterWorker[],
        private readonly revision: () => number,
        private readonly observe: (owner: SessionOwner, snapshot: SessionSnapshot, revision: number) => void,
    ) {}

    refresh(): number {
        this.requested += 1;
        if (!this.running) {
            this.running = true;
            void this.refreshLoop();
        }
        return this.requested;
    }

    private async refreshLoop(): Promise<void> {
        while (this.completed < this.requested) {
            const target = this.requested;
            let result: RoutedAgentList = { agents: [...this.summaries], unavailableWorkers: [] };
            try { result = await this.refreshOnce(); } catch {}
            this.completedResult = result;
            this.completed = target;
            for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
                const waiter = this.waiters[index]!;
                if (waiter.target > target) continue;
                this.waiters.splice(index, 1);
                waiter.resolve(result);
            }
        }
        this.running = false;
    }

    private async refreshOnce(): Promise<RoutedAgentList> {
        const revision = this.revision();
        const owners: Array<[SessionOwner, SessionEndpoint]> = [
            ["host", this.host], ...this.workers.filter((worker) => worker.ready()).map((worker): [SessionOwner, SessionEndpoint] => [worker.id, worker.endpoint]),
        ];
        const generations = new Map(this.workers.map((worker) => [worker.id, worker.generation()]));
        const results = await Promise.all(owners.map(async ([owner, endpoint]) => {
            if (owner === "host") return { owner, snapshot: await endpoint.snapshot() };
            const worker = this.workers.find((entry) => entry.id === owner)!;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const result = await Promise.race([
                    endpoint.snapshot().then(
                        (snapshot) => ({ snapshot }),
                        () => ({ timedOut: true as const }),
                    ),
                    new Promise<{ timedOut: true }>((resolve) => {
                        timer = setTimeout(() => resolve({ timedOut: true }), ROSTER_ENDPOINT_DEADLINE_MS);
                    }),
                ]);
                if ("timedOut" in result || !worker.ready() || worker.generation() !== generations.get(owner)) {
                    return { owner, timedOut: true as const };
                }
                return { owner, snapshot: result.snapshot };
            } finally {
                if (timer !== undefined) clearTimeout(timer);
            }
        }));
        const timedOut = new Set<SessionOwner>([
            ...results.flatMap((result) => "timedOut" in result ? [result.owner] : []),
            ...this.workers.filter((worker) => !worker.ready()).map((worker) => worker.id),
        ]);
        const current: Array<{ owner: SessionOwner; snapshot: SessionSnapshot; cached?: true }> = results.flatMap((result) =>
            "snapshot" in result && result.snapshot !== undefined
                ? [{ owner: result.owner, snapshot: result.snapshot }]
                : []
        );
        for (const entry of current) {
            if (entry.owner === "host") continue;
            const pid = this.workers.find((worker) => worker.id === entry.owner)?.pid?.();
            const residents = new Set(entry.snapshot.residents.filter((session) => !session.closed).map((session) => session.id));
            entry.snapshot = {
                ...entry.snapshot,
                summaries: entry.snapshot.summaries.map((summary) => {
                    if (residents.has(summary.id)) return pid === undefined ? summary : { ...summary, worker_pid: pid };
                    if (summary.worker_pid === undefined) return summary;
                    const { worker_pid: _workerPid, ...stored } = summary;
                    return stored;
                }),
            };
            this.lastWorkers.set(entry.owner, entry.snapshot);
        }
        for (const worker of this.workers) {
            if (worker.ready() && !timedOut.has(worker.id)) continue;
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
        return { agents: [...this.summaries], unavailableWorkers: [...timedOut] };
    }

    private waitFor(target: number): Promise<RoutedAgentList> {
        if (target <= this.completed) return Promise.resolve(this.completedResult);
        return new Promise<RoutedAgentList>((resolve) => this.waiters.push({ target, resolve }));
    }

    wait(): Promise<void> {
        return this.waitFor(this.requested).then(() => undefined);
    }

    async refreshAndList(): Promise<readonly RegisteredAgentSummary[]> {
        const target = this.refresh();
        const result = await this.waitFor(target);
        return result.agents;
    }

    async refreshAndListWithAvailability(): Promise<RoutedAgentList> {
        const target = this.refresh();
        return this.waitFor(target);
    }

    list(): readonly RegisteredAgentSummary[] { return this.summaries; }
    workIndex(): WorkIndexSnapshot { return this.index; }

    onChanged(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
}

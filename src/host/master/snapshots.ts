import type { RegisteredAgentSummary } from "../agent-registry.ts";
import { buildWorkIndex, EMPTY_WORK_INDEX, type WorkIndexSnapshot } from "../work-index.ts";
import { mergeRoster } from "./roster.ts";
import type { SessionEndpoint, SessionSnapshot } from "./router.ts";

export class RoutedSnapshots {
    private readonly listeners = new Set<() => void>();
    private pending: Promise<void> = Promise.resolve();
    private summaries: readonly RegisteredAgentSummary[] = [];
    private index: WorkIndexSnapshot = EMPTY_WORK_INDEX;

    constructor(
        private readonly master: SessionEndpoint,
        private readonly worker: SessionEndpoint,
        private readonly observe: (master: SessionSnapshot, worker: SessionSnapshot) => void,
    ) {}

    refresh(): void {
        const snapshots = Promise.all([this.master.snapshot(), this.worker.snapshot()]).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
        this.pending = this.pending.then(async () => {
            const result = await snapshots;
            if ("error" in result) throw result.error;
            const [master, worker] = result.value;
            const masterIds = new Set(master.residents.map((session) => session.id));
            const workerIds = new Set(worker.residents.map((session) => session.id));
            const unread = new Set([...master.unreadSources, ...worker.unreadSources]);
            const agents = [...master.work, ...worker.work].map((fact) => unread.has(fact.id)
                ? { ...fact, unread_result: true }
                : fact);
            const schedules = await this.master.workSchedules(agents);
            this.summaries = mergeRoster(master.summaries, worker.summaries, (id) => workerIds.has(id)
                ? "w0" : masterIds.has(id) ? "host" : undefined);
            this.index = buildWorkIndex(agents, schedules);
            this.observe(master, worker);
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

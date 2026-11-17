import { backgroundCommandCount, type ListAgents } from "../protocol/backgroundCommands.ts";

export interface QuitWarning {
    readonly count: number;
    readonly agentIds: readonly string[];
}

export interface QuitWarningDependencies {
    readonly watchedSessions: () => readonly string[];
    readonly listAgents: ListAgents;
    readonly closeSession: (agentId: string) => Promise<unknown>;
    readonly showWarning: (warning: QuitWarning | undefined) => void;
    readonly closeWindow: () => void;
    readonly stopDeadlineMs?: number;
}

export const QUIT_STOP_DEADLINE_MS = 3_000;

type QuitPhase = "idle" | "checking" | "warning" | "stopping" | "allowed";

export class QuitWarningController {
    private phase: QuitPhase = "idle";
    private warning: QuitWarning | undefined;

    constructor(private readonly deps: QuitWarningDependencies) {}

    beforeUnload(event: BeforeUnloadEvent, closing: boolean): void {
        if (!closing || this.phase === "allowed") return;
        const agentIds = [...new Set(this.deps.watchedSessions())];
        if (this.phase === "idle" && agentIds.length === 0) return;
        event.preventDefault();
        event.returnValue = "";
        if (this.phase !== "idle") return;
        this.phase = "checking";
        void this.check(agentIds);
    }

    cancel(): void {
        if (this.phase !== "warning") return;
        this.phase = "idle";
        this.warning = undefined;
        this.deps.showWarning(undefined);
    }

    keepRunning(): void {
        if (this.phase !== "warning") return;
        this.finish();
    }

    async stopAndQuit(): Promise<void> {
        if (this.phase !== "warning" || this.warning === undefined) return;
        this.phase = "stopping";
        const requests = this.warning.agentIds.map((agentId) => Promise.resolve().then(() => {
            if (!this.deps.watchedSessions().includes(agentId)) return;
            return this.deps.closeSession(agentId);
        }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            Promise.allSettled(requests),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, this.deps.stopDeadlineMs ?? QUIT_STOP_DEADLINE_MS); }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        this.finish();
    }

    private async check(agentIds: readonly string[]): Promise<void> {
        const results = await Promise.all(agentIds.map(async (agentId) => ({
            agentId,
            result: await backgroundCommandCount(this.deps.listAgents, agentId),
        })));
        const openAgentIds = [...new Set(this.deps.watchedSessions())];
        if (agentIds.length !== openAgentIds.length || agentIds.some((agentId) => !openAgentIds.includes(agentId))) {
            if (openAgentIds.length === 0) {
                this.finish();
            } else {
                void this.check(openAgentIds);
            }
            return;
        }
        const counted = results.filter(({ result }) => result.ok && result.count > 0);
        const count = counted.reduce((total, { result }) => total + (result.ok ? result.count : 0), 0);
        if (count === 0) {
            this.finish();
            return;
        }
        this.warning = { count, agentIds: counted.map(({ agentId }) => agentId) };
        this.phase = "warning";
        this.deps.showWarning(this.warning);
    }

    private finish(): void {
        this.phase = "allowed";
        this.warning = undefined;
        this.deps.showWarning(undefined);
        this.deps.closeWindow();
    }
}

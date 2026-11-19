import type { UpdateProgress } from "../../shared/updates.ts";
import {
    INITIAL_UPDATE_STATE,
    type UpdateModeChoice,
    type UpdateRunView,
    type UpdateState,
} from "../../ui/src/protocol/updates.ts";
import type { TaskListeners } from "./tasks/runner.ts";
import { parseUpdateProgress, type UpdateRunAnswer, type UpdateTask, type UpdateTaskReply } from "./update/task-protocol.ts";

// A check can take as long as the command's own 90 second limit; an update waits for running work and then switches.
export const UPDATE_CHECK_TASK_TIMEOUT_MS = 120_000;
export const UPDATE_RUN_TASK_TIMEOUT_MS = 45 * 60_000;

// Progress lines arrive faster than the window needs them.
const PROGRESS_EMIT_MS = 250;

export const HELD_WITHOUT_REASON = "This update is held. Nothing was changed.";
export const CHECK_WITHOUT_REASON = "The update check did not finish.";

export interface UpdateTaskPort {
    run(task: UpdateTask, listeners?: TaskListeners): Promise<UpdateTaskReply>;
}

export interface UpdateTimers {
    set(callback: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

export interface UpdateServiceParts {
    readonly home: string;
    // The command that runs `vera update`; undefined when this window has none.
    readonly command: () => string | undefined;
    readonly checks: UpdateTaskPort;
    readonly modes: UpdateTaskPort;
    readonly runs: UpdateTaskPort;
    readonly emit: (state: UpdateState) => void;
    // Starts the window's boot again, which finds the new build and relaunches into it.
    readonly relaunch: () => void;
    readonly now?: () => number;
    readonly timers?: UpdateTimers;
}

const REAL_TIMERS: UpdateTimers = {
    set: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        handle.unref();
        return handle;
    },
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function viewOf(progress: UpdateProgress): UpdateRunView {
    switch (progress.phase) {
        case "checking":
            return { kind: "checking" };
        case "switching":
            return { kind: "switching" };
        case "downloading":
            return { kind: "downloading", bytes: progress.bytes, ...(progress.total === undefined ? {} : { total: progress.total }) };
        case "waiting":
            return { kind: "waiting", sessions: progress.sessions, waitedMs: progress.waitedMs, limitMs: progress.limitMs };
    }
}

// Finds updates on a schedule, downloads them in automatic mode, and runs the one the person chose. Every command runs in a task process.
export class UpdateService {
    private state: UpdateState;
    private started = false;
    private stopped = false;
    private lastCheckedAt: number | undefined;
    private timer: unknown;
    private runAbort: AbortController | undefined;
    private backgroundAbort: AbortController | undefined;
    // Changes when the mode does, so a check that began under the old mode is dropped.
    private generation = 0;
    private lastEmitAt = 0;
    private trailing: unknown;
    private readonly now: () => number;
    private readonly timers: UpdateTimers;

    constructor(private readonly parts: UpdateServiceParts) {
        this.now = parts.now ?? Date.now;
        this.timers = parts.timers ?? REAL_TIMERS;
        this.state = { ...INITIAL_UPDATE_STATE, capable: parts.command() !== undefined };
    }

    current(): UpdateState {
        return this.state;
    }

    // Checks once, then on the task's schedule. Called when the page starts, which can happen again on a reload.
    start(): void {
        if (this.started || this.stopped) return;
        this.started = true;
        void this.check(true);
    }

    stop(): void {
        this.stopped = true;
        this.clearTimer();
        this.clearTrailing();
        this.runAbort?.abort();
        this.backgroundAbort?.abort();
    }

    async check(force: boolean): Promise<void> {
        if (this.stopped || this.busy()) return;
        const command = this.parts.command();
        const generation = this.generation;
        const at = this.now();
        this.patch({ checking: true, capable: command !== undefined });
        let reply: UpdateTaskReply | undefined;
        let failure: string | undefined;
        try {
            reply = await this.parts.checks.run({
                kind: "check",
                home: this.parts.home,
                now: at,
                force,
                ...(command === undefined ? {} : { command }),
                ...(this.lastCheckedAt === undefined ? {} : { lastCheckedAt: this.lastCheckedAt }),
            });
        } catch (error) {
            failure = messageOf(error);
        }
        if (this.stopped) return;
        if (generation !== this.generation) {
            this.patch({ checking: false });
            void this.check(true);
            return;
        }
        if (reply === undefined || reply.kind !== "check") {
            this.patch({ checking: false, problem: failure ?? CHECK_WITHOUT_REASON });
            this.schedule(undefined);
            return;
        }
        const { check } = reply;
        if (reply.mode === "off") {
            this.clearTimer();
            this.patch({ checking: false, mode: "off", offer: undefined, held: undefined, problem: undefined });
            return;
        }
        if (check === undefined) {
            this.patch({ checking: false, mode: reply.mode });
            this.schedule(reply.intervalMs);
            this.downloadIfAutomatic();
            return;
        }
        this.lastCheckedAt = at;
        const currentVersion = check.currentVersion.length > 0 ? check.currentVersion : this.state.currentVersion;
        const known = { checking: false, mode: reply.mode, ...(currentVersion === undefined ? {} : { currentVersion }) };
        switch (check.status) {
            case "up_to_date":
                this.patch({ ...known, offer: undefined, held: undefined, problem: undefined });
                break;
            case "available":
            case "downloaded":
                this.patch({
                    ...known,
                    offer: { status: check.status, ...(check.latestVersion === undefined ? {} : { latestVersion: check.latestVersion }) },
                    held: undefined,
                    problem: undefined,
                });
                break;
            case "held":
                this.patch({ ...known, offer: undefined, held: check.message ?? HELD_WITHOUT_REASON, problem: undefined });
                break;
            case "unavailable":
                this.patch({ ...known, problem: check.message ?? CHECK_WITHOUT_REASON });
                break;
        }
        this.schedule(reply.intervalMs);
        this.downloadIfAutomatic();
    }

    async setMode(mode: UpdateModeChoice): Promise<void> {
        if (this.stopped) return;
        let reply: UpdateTaskReply | undefined;
        let failure: string | undefined;
        try {
            reply = await this.parts.modes.run({ kind: "mode", home: this.parts.home, mode });
        } catch (error) {
            failure = messageOf(error);
        }
        if (this.stopped) return;
        if (reply === undefined || reply.kind !== "mode") {
            this.patch({ modeProblem: failure ?? "The setting was not saved." });
            return;
        }
        if (reply.problem !== undefined) {
            this.patch({ mode: reply.mode, modeProblem: reply.problem });
            return;
        }
        const previous = this.state.mode;
        this.generation += 1;
        this.patch({ mode: reply.mode, modeProblem: undefined });
        if (reply.mode === "off") {
            this.clearTimer();
            this.backgroundAbort?.abort();
            this.patch({ offer: undefined, held: undefined, problem: undefined });
        } else if (previous === "off") {
            await this.check(true);
        } else {
            this.downloadIfAutomatic();
        }
    }

    // The update the person chose: waits for running work, then switches. A finished switch is followed by the window's relaunch.
    async update(): Promise<void> {
        const command = this.parts.command();
        if (this.stopped || command === undefined || this.state.mode === "off" || this.running()) return;
        const abort = new AbortController();
        this.runAbort = abort;
        let switching = false;
        this.patch({ run: { kind: "checking" } });
        let answer: UpdateRunAnswer | undefined;
        let failure: string | undefined;
        try {
            const reply = await this.parts.runs.run(
                { kind: "run", command, downloadOnly: false },
                {
                    signal: abort.signal,
                    onProgress: ({ message }) => {
                        const progress = parseUpdateProgress(message);
                        if (progress === undefined) return;
                        if (progress.phase === "switching") switching = true;
                        this.patch({ run: viewOf(progress) }, progress.phase === "downloading");
                    },
                },
            );
            if (reply.kind === "run") answer = reply.answer;
        } catch (error) {
            failure = messageOf(error);
        }
        this.runAbort = undefined;
        if (this.stopped) return;
        if (answer === undefined) {
            // The task died after the switch began, so the build on disk decides what happens next.
            if (switching) this.parts.relaunch();
            this.patch({ run: { kind: "ended", result: "failed", message: failure ?? "The task stopped without answering." } });
            return;
        }
        this.finish(answer);
    }

    // Stops the run while it can still be stopped; once switching it runs to the end.
    cancel(): void {
        const { kind } = this.state.run;
        if (kind === "checking" || kind === "downloading" || kind === "waiting") this.runAbort?.abort();
    }

    // Clears the outcome the sheet showed.
    dismiss(): void {
        if (this.state.run.kind === "ended") this.patch({ run: { kind: "idle" } });
    }

    private finish(answer: UpdateRunAnswer): void {
        if (answer.changed || answer.result === "done") {
            this.patch({
                offer: undefined,
                run: { kind: "ended", result: "done", ...(answer.version === undefined ? {} : { version: answer.version }), ...(answer.message === undefined ? {} : { message: answer.message }) },
            });
            this.parts.relaunch();
            return;
        }
        const message = answer.message === undefined ? {} : { message: answer.message };
        switch (answer.result) {
            case "up_to_date":
                this.patch({ offer: undefined, held: undefined, run: { kind: "ended", result: "up_to_date", ...message } });
                break;
            case "held": {
                const reason = answer.message ?? HELD_WITHOUT_REASON;
                this.patch({ offer: undefined, held: reason, run: { kind: "ended", result: "held", message: reason } });
                break;
            }
            case "downloaded":
                this.patch({ offer: { status: "downloaded", ...(this.state.offer?.latestVersion === undefined ? {} : { latestVersion: this.state.offer.latestVersion }) }, run: { kind: "idle" } });
                break;
            case "cancelled":
                this.patch({ run: { kind: "ended", result: "cancelled", ...message } });
                break;
            default:
                this.patch({ run: { kind: "ended", result: "failed", ...message } });
        }
    }

    // Automatic mode fetches what the check found, so the chip's Update now only has to switch.
    private downloadIfAutomatic(): void {
        const command = this.parts.command();
        if (this.state.mode !== "automatic" || this.state.offer?.status !== "available" || command === undefined || this.busy()) return;
        void this.download(command);
    }

    private async download(command: string): Promise<void> {
        const abort = new AbortController();
        this.backgroundAbort = abort;
        this.patch({ background: true });
        let answer: UpdateRunAnswer | undefined;
        try {
            const reply = await this.parts.runs.run({ kind: "run", command, downloadOnly: true }, { signal: abort.signal });
            if (reply.kind === "run") answer = reply.answer;
        } catch {
            answer = undefined;
        }
        this.backgroundAbort = undefined;
        if (this.stopped) return;
        this.patch({ background: false });
        if (answer?.result === "downloaded" && this.state.offer !== undefined && this.state.mode !== "off") {
            this.patch({ offer: { ...this.state.offer, status: "downloaded" } });
        } else if (answer?.result === "up_to_date") {
            this.patch({ offer: undefined });
        } else if (answer?.result === "held") {
            this.patch({ offer: undefined, held: answer.message ?? HELD_WITHOUT_REASON });
        }
    }

    // A download or an update is under way; a check alone does not stop the person from starting an update.
    private running(): boolean {
        const { kind } = this.state.run;
        return this.state.background || (kind !== "idle" && kind !== "ended");
    }

    private busy(): boolean {
        return this.state.checking || this.running();
    }

    private schedule(intervalMs: number | undefined): void {
        this.clearTimer();
        if (this.stopped || intervalMs === undefined || intervalMs <= 0) return;
        this.timer = this.timers.set(() => {
            this.timer = undefined;
            void this.check(false);
        }, intervalMs);
    }

    private clearTimer(): void {
        if (this.timer === undefined) return;
        this.timers.clear(this.timer);
        this.timer = undefined;
    }

    private clearTrailing(): void {
        if (this.trailing === undefined) return;
        this.timers.clear(this.trailing);
        this.trailing = undefined;
    }

    // `quiet` keeps the state current but sends it only when the last send was long enough ago; the newest state still goes out when that time is up.
    private patch(change: Partial<UpdateState>, quiet = false): void {
        this.state = { ...this.state, ...change };
        if (this.stopped) return;
        const at = this.now();
        if (quiet && at - this.lastEmitAt < PROGRESS_EMIT_MS) {
            this.trailing ??= this.timers.set(() => {
                this.trailing = undefined;
                this.send();
            }, PROGRESS_EMIT_MS - (at - this.lastEmitAt));
            return;
        }
        this.clearTrailing();
        this.send();
    }

    private send(): void {
        if (this.stopped) return;
        this.lastEmitAt = this.now();
        this.parts.emit(this.state);
    }
}

import {
    checkForUpdate,
    readUpdateMode,
    runUpdate,
    shouldCheckNow,
    UPDATE_CHECK_INTERVAL_MS,
    writeUpdateMode,
    type UpdateCheck,
    type UpdateCommandOptions,
    type UpdateMode,
    type UpdateOutcome,
    type UpdateProgress,
    type UpdateRun,
    type UpdateRunOptions,
} from "../../../shared/updates.ts";
import type { TaskReport } from "../tasks/serve.ts";
import { encodeUpdateProgress, type UpdateTask, type UpdateTaskReply } from "./task-protocol.ts";

// The shared update module, as one object so a test can stand in for it.
export interface UpdateApi {
    readMode(home: string): UpdateMode;
    writeMode(home: string, mode: UpdateMode): void;
    check(options: UpdateCommandOptions): Promise<UpdateCheck>;
    run(options: UpdateRunOptions, onProgress: (progress: UpdateProgress) => void): UpdateRun;
    due(lastCheckedAt: number | undefined, now: number): boolean;
}

const SHARED: UpdateApi = {
    readMode: readUpdateMode,
    writeMode: writeUpdateMode,
    check: checkForUpdate,
    run: runUpdate,
    due: shouldCheckNow,
};

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function runUpdateTask(task: UpdateTask, report: TaskReport, api: UpdateApi = SHARED): Promise<UpdateTaskReply> {
    switch (task.kind) {
        case "check": {
            const mode = api.readMode(task.home);
            const reply = { kind: "check", mode, intervalMs: UPDATE_CHECK_INTERVAL_MS } as const;
            if (mode === "off" || task.command === undefined) return reply;
            if (!task.force && !api.due(task.lastCheckedAt, task.now)) return reply;
            const found = await api.check({ veraCommand: task.command });
            return {
                ...reply,
                check: {
                    status: found.status,
                    currentVersion: found.currentVersion,
                    ...(found.latestVersion === undefined ? {} : { latestVersion: found.latestVersion }),
                    ...(found.message === undefined ? {} : { message: found.message }),
                },
            };
        }
        case "mode": {
            if (task.mode === undefined) return { kind: "mode", mode: api.readMode(task.home) };
            try {
                api.writeMode(task.home, task.mode);
            } catch (error) {
                return { kind: "mode", mode: api.readMode(task.home), problem: messageOf(error) };
            }
            return { kind: "mode", mode: api.readMode(task.home) };
        }
        case "run": {
            const run = api.run(
                { veraCommand: task.command, downloadOnly: task.downloadOnly },
                (progress) => report.progress(encodeUpdateProgress(progress)),
            );
            report.onCancel(() => {
                run.cancel();
            });
            const outcome: UpdateOutcome = await run.done;
            return {
                kind: "run",
                answer: {
                    result: outcome.result,
                    changed: outcome.changed,
                    ...(outcome.version === undefined ? {} : { version: outcome.version }),
                    ...(outcome.message === undefined ? {} : { message: outcome.message }),
                },
            };
        }
    }
}

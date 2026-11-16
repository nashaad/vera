import { processIdentityState, readProcessGroupSnapshot, signalVerifiedProcessGroup } from "../process-group.ts";
import type { ProcessObservation } from "../store/process-observations.ts";

/** Preserve live and unverified workers: losing a host connection is not executor loss. */
export function observationExecutorAlive(executorId: string, localExecutorId: string): boolean {
    if (executorId === localExecutorId || executorId.startsWith(`${localExecutorId}:`)) return true;
    if (executorId.startsWith("local:")) return false;
    const match = /^worker:w\d+:(\d+):(.+)$/.exec(executorId);
    if (match === null) return true; // Unknown ownership must never authorize cleanup.
    const state = processIdentityState({ pid: Number(match[1]), started_at: match[2]! });
    return state !== "gone" && state !== "replaced";
}

/** Stop only a group whose still-present leader matches this observation's recorded identity. */
export async function cleanupObservedProcess(observation: ProcessObservation): Promise<void> {
    const identity = { pid: observation.pid, started_at: observation.startedAt };
    try { process.kill(-identity.pid, 0); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
    }
    const snapshot = readProcessGroupSnapshot();
    if (snapshot === undefined) throw new Error(`Cannot verify process group for ${observation.processId}`);
    const live = snapshot.filter((entry) => entry.group === identity.pid && !/^[ZX]/.test(entry.state));
    if (live.length === 0) return;
    // A missing leader cannot prove these are still the original descendants: the group ID
    // may have been reused. Leave the observation retryable rather than signal by PID alone.
    if (!live.some((entry) => entry.pid === identity.pid)) {
        throw new Error(`Cannot verify process group leader for ${observation.processId}`);
    }
    const result = signalVerifiedProcessGroup(identity, "SIGKILL", { reads: { readProcessGroupSnapshot: () => snapshot } });
    if (result !== "sent" && result !== "gone") {
        throw new Error(`Cannot stop process group for ${observation.processId}: ${result}`);
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        const current = readProcessGroupSnapshot();
        if (current === undefined) throw new Error(`Cannot verify process group cleanup for ${observation.processId}`);
        if (!current.some((entry) => entry.group === identity.pid && !/^[ZX]/.test(entry.state))) return;
        await Bun.sleep(25);
    }
    throw new Error(`Process group cleanup timed out for ${observation.processId}`);
}

import { appendRestartRecordAsync, defaultRestartRecordPath } from "../../store/restart-records.ts";
import type { SessionStore } from "../../store/session-store.ts";

export async function repairHostLostSession(store: SessionStore, home: string): Promise<void> {
    await store.exclusively(async () => {});
    await store.repairCrashedTurn({
        workerExited: true,
        stopCause: "host_stopped_unexpectedly",
    });
    await appendRestartRecordAsync({
        session_id: store.header.id,
        cause: "crash",
        at: new Date().toISOString(),
    }, defaultRestartRecordPath(home));
}

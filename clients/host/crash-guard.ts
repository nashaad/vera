import { createHostLogger, type HostLog } from "../../src/host/host-log.ts";
import type { HostIdentity } from "../../src/host/protocol.ts";

const FAULT_LIMIT = 50;

export function installHostCrashGuard(
    log: HostLog = createHostLogger(),
    exit: (code: number) => void = (code) => process.exit(code),
    identity?: Pick<HostIdentity, "pid" | "started_at" | "build_id">,
): () => void {
    let faults = 0;
    const entryFor = (kind: string, cause: unknown): Parameters<HostLog>[0] => ({
        type: kind,
        error: cause instanceof Error ? cause.message : String(cause),
        ...(cause instanceof Error && cause.stack !== undefined
            ? { stack: cause.stack }
            : {}),
    });
    const absorb = (kind: string, cause: unknown): void => {
        faults += 1;
        log({ ...entryFor(kind, cause), fault_count: faults });
        if (faults >= FAULT_LIMIT) {
            log({
                type: "host_fault_limit_reached",
                error: `Absorbed ${faults} faults; exiting instead of`
                    + " continuing in an unknown state.",
            });
            log({
                type: "host_stopping",
                ...(identity === undefined ? { pid: process.pid } : { role: "host", ...identity }),
                reason: "fault_limit",
                fault_type: kind,
                error: cause instanceof Error ? cause.message : String(cause),
            });
            exit(1);
        }
    };
    const onUncaught = (error: Error): void => {
        absorb("host_uncaught_exception", error);
    };
    const onUnhandled = (reason: unknown): void => {
        absorb("host_unhandled_rejection", reason);
    };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);
    return () => {
        process.off("uncaughtException", onUncaught);
        process.off("unhandledRejection", onUnhandled);
    };
}

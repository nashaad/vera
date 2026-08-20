import { createHostLogger, type HostLog } from "../../src/host/host-log.ts";

/**
 * Keeps one bad code path from taking down every resident session. Installed
 * only after startup completes: a host that cannot even boot must still exit
 * loudly, or a broken build would sit half-alive holding the lockfile.
 *
 * Each session's run loop already contains its own failures; what lands here
 * is a throw from host bookkeeping outside any session's promise chain, which
 * previously killed the whole process. The entry carries the stack so the
 * culprit is attributable from the host log alone.
 */
/**
 * How many faults the guard absorbs before it stops pretending the host is
 * healthy. A host throwing this often is not surviving one bad path, it is
 * failing continuously, and staying up hides that behind a growing log.
 */
const FAULT_LIMIT = 50;

export function installHostCrashGuard(
    log: HostLog = createHostLogger(),
    exit: (code: number) => void = (code) => process.exit(code),
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

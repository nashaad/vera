import { MAX_LIVE_PROCESSES_PER_OWNER } from "../../tools/process-limits.ts";
import type {
    ManagedProcessObservationHandlers,
    ManagedProcessObservationStart,
} from "../../tools/process-runtime.ts";
import { validateObservationStart } from "../../store/process-observations.ts";

interface Entry {
    readonly start: ManagedProcessObservationStart;
    registration: Promise<void>;
    settlement?: Promise<void>;
    interruption?: Promise<void>;
}

export interface ChildObservationTracker {
    readonly hasUnsettledObservations: boolean;
    readonly handlers: ManagedProcessObservationHandlers;
    finish(): Promise<number>;
}

/** Own only this child's bounded, authenticated observations until settlement or cleanup. */
export function createChildObservationTracker(
    ownerId: string,
    handlers: Required<ManagedProcessObservationHandlers>,
): ChildObservationTracker {
    const entries = new Map<string, Entry>();
    let closing = false;
    const validate = (start: ManagedProcessObservationStart): void => {
        validateObservationStart("child", start);
        if (start.ownerId !== ownerId) throw new Error("Invalid child process observation owner");
    };
    const matches = (left: ManagedProcessObservationStart, right: ManagedProcessObservationStart): boolean =>
        left.ownerId === right.ownerId && left.processId === right.processId
        && left.extensionId === right.extensionId && left.description === right.description
        && left.pid === right.pid && left.startedAt === right.startedAt;
    const existing = (start: ManagedProcessObservationStart): Entry | undefined => {
        validate(start);
        const entry = entries.get(start.processId);
        if (entry !== undefined && !matches(entry.start, start)) {
            throw new Error("Conflicting child process observation");
        }
        return entry;
    };
    const interrupt = (entry: Entry): Promise<void> => {
        if (entry.interruption !== undefined) return entry.interruption;
        entry.interruption = (async () => {
            await entry.registration.catch(() => {});
            if (entries.get(entry.start.processId) !== entry) return;
            await handlers.onObservationInterrupted(entry.start);
            entries.delete(entry.start.processId);
        })();
        void entry.interruption.catch(() => { entry.interruption = undefined; });
        return entry.interruption;
    };
    return {
        get hasUnsettledObservations() { return entries.size > 0; },
        handlers: {
            onObservationStarted(start) {
                if (closing) throw new Error("Child process observation tracker is closed");
                const previous = existing(start);
                if (previous !== undefined) return previous.registration;
                if (entries.size >= MAX_LIVE_PROCESSES_PER_OWNER) {
                    throw new Error("Child process observation limit reached");
                }
                const entry: Entry = { start, registration: Promise.resolve() };
                entries.set(start.processId, entry);
                entry.registration = (async () => {
                    try {
                        await handlers.onObservationStarted(start);
                    } catch (error) {
                        // A rejected acknowledgement may still have persisted the start.
                        try {
                            await handlers.onObservationInterrupted(start);
                            entries.delete(start.processId);
                        } catch (cleanup) {
                            throw new Error(`Child observation registration and cleanup failed: ${String(error)}; ${String(cleanup)}`);
                        }
                        throw error;
                    }
                })();
                return entry.registration;
            },
            onObservationSettled(settlement) {
                const entry = existing(settlement);
                if (entry === undefined) throw new Error("Unknown child process observation");
                if (entry.settlement !== undefined) throw new Error("Child process observation settlement is already in progress");
                entry.settlement = (async () => {
                    await entry.registration;
                    await handlers.onObservationSettled(settlement);
                    entries.delete(settlement.processId);
                })();
                void entry.settlement.catch(() => { entry.settlement = undefined; });
                return entry.settlement;
            },
            onObservationInterrupted(start) {
                const entry = existing(start);
                return entry === undefined ? Promise.resolve() : interrupt(entry);
            },
        },
        async finish() {
            closing = true;
            await Promise.allSettled([...entries.values()].flatMap((entry) =>
                [entry.registration, entry.settlement, entry.interruption].filter((item): item is Promise<void> => item !== undefined)
            ));
            const results = await Promise.allSettled([...entries.values()].map(interrupt));
            return results.filter((result) => result.status === "rejected").length;
        },
    };
}

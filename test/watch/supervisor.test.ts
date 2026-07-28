import { describe, expect, test } from "bun:test";

import type { OwnedWatchContribution } from "../../src/extensions/contribution-set.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { WatchAdmission } from "../../src/watch/admission.ts";
import {
    FAILURES_BEFORE_QUARANTINE,
    SupervisedWatch,
} from "../../src/watch/supervisor.ts";
import {
    WatchFatalError,
    type WatchConnector,
    type WatchRuntimeContext,
} from "../../src/watch/source.ts";

function ownedWatch(id = "vera.arc/main"): OwnedWatchContribution {
    return {
        id,
        localId: "main",
        extensionId: "vera.arc",
        definition: {
            id: "main",
            source_family: "arc",
            config: { server: "https://arc.local" },
            flood: "shed",
        },
    };
}

function harness(connector: WatchConnector) {
    const inbox = Inbox.open(":memory:");
    const delays: number[] = [];
    const task = new SupervisedWatch({
        watch: ownedWatch(),
        connector,
        admission: new WatchAdmission({
            inbox,
            watchId: "vera.arc/main",
            address: null,
            flood: "shed",
        }),
        random: () => 1,
        sleep: async (ms: number): Promise<void> => {
            delays.push(ms);
            await Bun.sleep(0);
        },
    });
    return { inbox, task, delays };
}

describe("watch supervision", () => {
    test("a failing connector backs off and retries, then quarantines", async () => {
        let runs = 0;
        const { inbox, task, delays } = harness({
            sourceFamily: "arc",
            run: async (): Promise<void> => {
                runs += 1;
                throw new Error("upstream unavailable");
            },
        });

        task.start();
        await Bun.sleep(5);
        await task.stop();

        expect(runs).toBeGreaterThanOrEqual(FAILURES_BEFORE_QUARANTINE);
        expect(delays.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
        inbox.close();
    });

    test("a fatal failure quarantines without a retry", async () => {
        let runs = 0;
        const { inbox, task, delays } = harness({
            sourceFamily: "arc",
            run: async (): Promise<void> => {
                runs += 1;
                throw new WatchFatalError("bad_config", "no server");
            },
        });

        task.start();
        await Bun.sleep(5);

        expect(runs).toBe(1);
        expect(delays).toEqual([]);
        expect(task.status().state).toBe("quarantined");
        expect(task.status().lastError).toBe("no server");
        await task.stop();
        inbox.close();
    });

    test("a connector marked healthy resets the backoff ladder", async () => {
        let runs = 0;
        const { inbox, task, delays } = harness({
            sourceFamily: "arc",
            run: async (context: WatchRuntimeContext): Promise<void> => {
                runs += 1;
                context.healthy();
                if (runs > FAILURES_BEFORE_QUARANTINE + 2) {
                    await new Promise<void>((resolve) => {
                        context.signal.addEventListener("abort", () => resolve(), {
                            once: true,
                        });
                    });
                    return;
                }
                throw new Error("dropped");
            },
        });

        task.start();
        await Bun.sleep(30);
        await task.stop();

        expect(runs).toBeGreaterThan(FAILURES_BEFORE_QUARANTINE);
        expect(new Set(delays)).toEqual(new Set([1_000]));
        inbox.close();
    });

    test("stopping aborts the connector and leaves the watch stopped", async () => {
        let aborted = false;
        const { inbox, task } = harness({
            sourceFamily: "arc",
            run: (context: WatchRuntimeContext): Promise<void> =>
                new Promise((resolve) => {
                    context.signal.addEventListener("abort", () => {
                        aborted = true;
                        resolve();
                    }, { once: true });
                }),
        });

        task.start();
        await Bun.sleep(1);
        await task.stop();

        expect(aborted).toBe(true);
        expect(task.status().state).toBe("stopped");
        inbox.close();
    });

    test("the connector reads the persisted cursor, never the definition", async () => {
        const inbox = Inbox.open(":memory:");
        inbox.setWatchCursor("vera.arc/main", "v1:42");
        let seen: string | null = "unset";
        const task = new SupervisedWatch({
            watch: ownedWatch(),
            connector: {
                sourceFamily: "arc",
                run: async (context: WatchRuntimeContext): Promise<void> => {
                    seen = context.cursor();
                    await new Promise<void>((resolve) => {
                        context.signal.addEventListener("abort", () => resolve(), {
                            once: true,
                        });
                    });
                },
            },
            admission: new WatchAdmission({
                inbox,
                watchId: "vera.arc/main",
                address: null,
                flood: "shed",
            }),
        });

        task.start();
        await Bun.sleep(1);
        await task.stop();

        expect(seen).toBe("v1:42");
        expect(ownedWatch().definition).not.toHaveProperty("cursor");
        inbox.close();
    });
});

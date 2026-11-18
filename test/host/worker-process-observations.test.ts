import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { ProcessObservationCoordinator } from "../../src/host/process-observations.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { createChildObservationTracker } from "../../src/host/worker/process-observations.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { MAX_LIVE_PROCESSES_PER_OWNER } from "../../src/tools/process-limits.ts";
import { ManagedProcessRegistry, type ManagedProcessObservationStart } from "../../src/tools/process-runtime.ts";

function start(index: number): ManagedProcessObservationStart {
    return {
        ownerId: "crow-owner", processId: `p-crow-${index}`, extensionId: "vera.monitor",
        description: "Crow checks the hold", pid: 2000 + index, startedAt: "2026-11-16T12:00:00.000Z",
    };
}

test("@core child observation tracking bounds, validates and cleans rejected registrations", async () => {
    let cleanupFails = false;
    let failedStarts = true;
    let cleanups = 0;
    const tracker = createChildObservationTracker("crow-owner", {
        async onObservationStarted() { if (failedStarts) throw new Error("start refused"); },
        async onObservationSettled() {},
        async onObservationInterrupted() {
            cleanups += 1;
            if (cleanupFails) throw new Error("cleanup refused");
        },
    });
    for (let index = 0; index < 3 * MAX_LIVE_PROCESSES_PER_OWNER; index += 1) {
        await expect(tracker.handlers.onObservationStarted!(start(index))).rejects.toThrow("start refused");
    }
    expect(cleanups).toBe(3 * MAX_LIVE_PROCESSES_PER_OWNER);
    failedStarts = false;
    for (let index = 0; index < MAX_LIVE_PROCESSES_PER_OWNER; index += 1) {
        await tracker.handlers.onObservationStarted!(start(index));
    }
    expect(() => tracker.handlers.onObservationStarted!(start(100))).toThrow("limit reached");
    expect(() => tracker.handlers.onObservationStarted!({ ...start(0), pid: 9999 })).toThrow("Conflicting");
    expect(() => tracker.handlers.onObservationStarted!({ ...start(0), ownerId: "crow-other" })).toThrow("owner");
    await tracker.handlers.onObservationInterrupted!(start(0));
    await tracker.handlers.onObservationStarted!(start(100));
    cleanupFails = true;
    expect(await tracker.finish()).toBe(MAX_LIVE_PROCESSES_PER_OWNER);
    cleanupFails = false;
    expect(await tracker.finish()).toBe(0);
});

for (const fault of ["rejected", "late"] as const) {
    test(`@core a ${fault} child start acknowledgement reconciles a persisted observation while its executor lives`, async () => {
        const root = join(tmpdir(), "vera-dev");
        mkdirSync(root, { recursive: true });
        const home = mkdtempSync(join(root, "crow-late-ack-"));
        const inbox = Inbox.open(join(home, "inbox.db"));
        const delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"));
        const coordinator = new ProcessObservationCoordinator(inbox, delivery, {
            async formatProcessOutcome(_extension, outcome) { return `Crow command ${outcome.outcome}`; },
        });
        const executor = `local:live-${process.pid}`;
        const registered = Promise.withResolvers<void>();
        const tracker = createChildObservationTracker("crow-owner", {
            async onObservationStarted(observation) {
                coordinator.start(executor, observation);
                registered.resolve();
                if (fault === "rejected") throw new Error("ack lost");
                await Bun.sleep(100);
            },
            async onObservationSettled(settlement) { await coordinator.settle(executor, settlement); },
            async onObservationInterrupted(observation) { await coordinator.interruptObservation(executor, observation); },
        });
        const toHost = new PassThrough();
        const toChild = new PassThrough();
        const host = createJsonPipe({ input: toHost, output: toChild }, {
            async onRequest(body) {
                const request = body as { method: string; observation: ManagedProcessObservationStart };
                if (request.method === "start") return await tracker.handlers.onObservationStarted!(request.observation);
                if (request.method === "interrupt") return await tracker.handlers.onObservationInterrupted!(request.observation);
                throw new Error("unexpected request");
            },
        });
        const child = createJsonPipe({ input: toChild, output: toHost });
        const registry = new ManagedProcessRegistry({
            onObservationStarted: async (observation) => { await child.request({ method: "start", observation }, AbortSignal.timeout(30)); },
            onObservationSettled: async () => { throw new Error("unexpected settlement"); },
            onObservationInterrupted: async (observation) => { await child.request({ method: "interrupt", observation }, AbortSignal.timeout(2_000)); },
        });
        try {
            const scope = registry.scope("crow-owner");
            const run = scope.run({
                command: "exec sleep 30", cwd: home, env: { ...process.env, VERA_HOME: home }, interactive: false,
                observation: { extensionId: "vera.monitor", description: "Crow checks the hold" },
            });
            await registered.promise;
            const result = await run;
            expect(result.kind).toBe("rejected");
            if (result.kind !== "rejected") throw new Error("The uncertain start was accepted");
            expect(result.reason).toContain("Could not register process observation");
            expect(result.reason).not.toContain("cleanup failed");
            expect(inbox.tail()).toBe(1);
            const notice = inbox.readAfter(0, { limit: 10 })[0]!;
            expect(notice.kind).toBe("process.interrupted");
            expect(JSON.parse(notice.payload).text).toBe("Crow command interrupted");
            expect(inbox.processObservations.allRunning("", 10)).toEqual([]);
            expect(registry.hasUnsettledObservedProcess("crow-owner")).toBe(false);
            const next = await scope.run({ command: "printf 'crow ready'", cwd: home, env: { ...process.env, VERA_HOME: home }, interactive: false });
            expect(next.kind).toBe("exited");
            if (next.kind === "exited") expect(next.snapshot.output).toContain("crow ready");
            expect(await tracker.finish()).toBe(0);
            expect(inbox.tail()).toBe(1);
        } finally {
            await registry.close();
            child.close();
            host.close();
            toHost.destroy();
            toChild.destroy();
            delivery.close();
            inbox.close();
            rmSync(home, { recursive: true, force: true });
        }
    }, 10_000);
}

import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { signalVerifiedProcessGroup } from "../../src/process-group.ts";
import { processStartedAt } from "../../src/host/process-identity.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORE_EXTENSIONS_DIRECTORY } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { ProcessObservationCoordinator } from "../../src/host/process-observations.ts";
import { Inbox } from "../../src/store/inbox.ts";
import type { ManagedProcessObservationSettlement, ManagedProcessObservationStart } from "../../src/tools/process-runtime.ts";

function start(index: number): ManagedProcessObservationStart {
    return {
        ownerId: "crow-owner", processId: `p-crow-${index}`, extensionId: "vera.monitor",
        description: "Crow checks the hold", pid: 400 + index, startedAt: "2026-11-16T12:00:00.000Z",
    };
}

function settlement(index: number): ManagedProcessObservationSettlement {
    return { ...start(index), elapsedMs: 120, exitCode: 7, outputTail: "crow found the map\n", outputTruncated: false };
}

test("@core pending observations are bounded and delivered rows retain only authenticated inbox proofs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-crow-replay-"));
    const path = join(directory, "inbox.db");
    let inbox = Inbox.open(path);
    let delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"));
    let enabled = false;
    const extensions = {
        async formatProcessOutcome() { return enabled ? "Crow found the map" : undefined; },
    };
    let observations = new ProcessObservationCoordinator(inbox, delivery, extensions);
    try {
        for (let index = 0; index < 8; index += 1) {
            observations.start("crow-executor", start(index));
            await observations.settle("crow-executor", settlement(index));
        }
        expect(inbox.processObservations.pending("", 20)).toHaveLength(8);
        expect(() => observations.start("crow-executor", start(8))).toThrow("limit reached");
        expect(inbox.tail()).toBe(0);
        enabled = true;
        expect(await observations.replayPending()).toEqual({ delivered: 8, deferred: 0, failed: 0 });
        expect(inbox.tail()).toBe(8);
        expect(inbox.processObservations.pending("", 20)).toEqual([]);
        expect(inbox.processObservations.get(start(0).processId)).toBeUndefined();
        delivery.close();
        inbox.close();

        inbox = Inbox.open(path);
        delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"));
        observations = new ProcessObservationCoordinator(inbox, delivery, extensions);
        observations.start("crow-executor", start(0));
        await observations.settle("crow-executor", settlement(0));
        expect(() => observations.start("wrong-executor", start(0))).toThrow("identity");
        expect(() => observations.start("crow-executor", { ...start(0), ownerId: "crow-other" })).toThrow("identity");
        expect(() => observations.start("crow-executor", { ...start(0), extensionId: "vera.raven" })).toThrow("identity");
        await expect(observations.settle("crow-executor", { ...settlement(0), exitCode: 0 })).rejects.toThrow("recorded outcome");
        await expect(observations.settle("crow-executor", { ...settlement(0), ownerId: "crow-other" })).rejects.toThrow("recorded outcome");
        expect(inbox.tail()).toBe(8);
        observations.start("crow-executor", start(8));
        await observations.settle("crow-executor", settlement(8));
        expect(inbox.tail()).toBe(9);
    } finally {
        delivery.close();
        inbox.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("@core failed admission preserves the outcome for replay and a later command", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-crow-failure-"));
    const path = join(directory, "inbox.db");
    const inbox = Inbox.open(path);
    const delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"));
    const raw = new Database(path);
    const observations = new ProcessObservationCoordinator(inbox, delivery, {
        async formatProcessOutcome() { return "Crow found the map"; },
    });
    try {
        raw.exec("CREATE TRIGGER refuse_process_admission BEFORE INSERT ON admitted_entries BEGIN SELECT RAISE(ABORT, 'admission refused'); END");
        observations.start("crow-executor", start(0));
        await expect(observations.settle("crow-executor", settlement(0))).rejects.toThrow("admission refused");
        expect(inbox.tail()).toBe(0);
        expect(inbox.processObservations.pending("", 10)).toMatchObject([{ processId: "p-crow-0", exitCode: 7 }]);
        raw.exec("DROP TRIGGER refuse_process_admission");
        expect(await observations.replayPending()).toEqual({ delivered: 1, deferred: 0, failed: 0 });
        expect(inbox.processObservations.pending("", 10)).toEqual([]);
        expect(inbox.tail()).toBe(1);
        observations.start("crow-executor", start(1));
        await observations.settle("crow-executor", settlement(1));
        expect(inbox.tail()).toBe(2);
    } finally {
        raw.close();
        delivery.close();
        inbox.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("@core startup recovers more than one page while preserving live and unknown executors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-crow-startup-"));
    const inbox = Inbox.open(join(directory, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"));
    const observations = new ProcessObservationCoordinator(inbox, delivery, {
        async formatProcessOutcome(_extensionId, outcome) { return `Interrupted ${outcome.description}`; },
    });
    try {
        for (let index = 0; index < 137; index += 1) {
            observations.start("local:old-host", {
                ...start(index), ownerId: `crow-owner-${index}`, pid: 2_000_000_000 + index,
            });
        }
        const ownStarted = processStartedAt(process.pid);
        expect(ownStarted).toBeDefined();
        const liveExecutor = `worker:w0:${process.pid}:${new Date(ownStarted!).toISOString()}`;
        observations.start(liveExecutor, { ...start(200), pid: 2_000_001_000 });
        observations.start("unknown-executor", { ...start(201), pid: 2_000_001_001 });
        expect(await observations.recover("local:new-host")).toEqual({ delivered: 137, deferred: 0, failed: 0 });
        expect(inbox.tail()).toBe(137);
        expect(inbox.processObservations.running(liveExecutor, "", 10)).toHaveLength(1);
        expect(inbox.processObservations.running("unknown-executor", "", 10)).toHaveLength(1);
        expect(observations.acceptsPreviousStart("local:old-host", {
            ...start(0), ownerId: "crow-owner-0", pid: 2_000_000_000,
        })).toBe(true);
        expect(observations.acceptsPreviousStart("local:other", {
            ...start(0), ownerId: "crow-owner-0", pid: 2_000_000_000,
        })).toBe(false);
        expect(await observations.recover("local:new-host")).toEqual({ delivered: 0, deferred: 0, failed: 0 });
        expect(inbox.tail()).toBe(137);
    } finally {
        delivery.close();
        inbox.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("@core lost child cleanup verifies identity and interrupts only that observation", async () => {
    const root = join(tmpdir(), "vera-dev");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "crow-cleanup-"));
    const inbox = Inbox.open(join(directory, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"));
    const observations = new ProcessObservationCoordinator(inbox, delivery, {
        async formatProcessOutcome() { return "Interrupted"; },
    });
    const startedAt = new Date().toISOString();
    const child = spawn("/bin/bash", ["-c", "sleep 60 & wait"], {
        detached: true, stdio: "ignore", cwd: directory, env: { ...process.env, VERA_HOME: join(directory, "home") },
    });
    const pid = child.pid!;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const real = { ...start(300), pid, startedAt };
    const wrong = { ...start(301), pid, startedAt: "2000-01-01T00:00:00.000Z" };
    try {
        observations.start("local:executor", wrong);
        observations.start("local:executor", real);
        await expect(observations.interruptObservation("local:executor", wrong)).rejects.toThrow("replaced");
        expect(() => process.kill(pid, 0)).not.toThrow();
        await observations.interruptObservation("local:executor", real);
        await exited;
        expect(inbox.tail()).toBe(1);
        expect(inbox.readAfter(0, { limit: 10 })[0]?.kind).toBe("process.interrupted");
        expect(inbox.processObservations.get(wrong.processId)?.outcome).toBe("running");
        await observations.interruptObservation("local:executor", real);
        expect(inbox.tail()).toBe(1);
    } finally {
        signalVerifiedProcessGroup({ pid, started_at: startedAt }, "SIGKILL");
        await exited;
        delivery.close();
        inbox.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("executor interruption produces one readable notice without an invented exit code", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-crow-interrupt-"));
    const inbox = Inbox.open(join(directory, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"));
    const extensions = await startExtensionRegistry({
        extensions: [{ path: join(CORE_EXTENSIONS_DIRECTORY, "monitor"), enabled: true, config: null }],
        storageRoots: { profile: directory, machine: directory },
    });
    const observations = new ProcessObservationCoordinator(inbox, delivery, extensions);
    try {
        observations.start("crow-executor", start(0));
        observations.start("other-executor", start(1));
        expect(await observations.interruptExecutor("crow-executor")).toEqual({ delivered: 1, deferred: 0, failed: 0 });
        expect(await observations.interruptExecutor("crow-executor")).toEqual({ delivered: 0, deferred: 0, failed: 0 });
        const entry = inbox.readAfter(0, { limit: 10 })[0]!;
        expect(entry.kind).toBe("process.interrupted");
        expect(entry.address).toBe("crow-owner");
        expect(JSON.parse(entry.payload).text).toContain("Interrupted before its outcome could be confirmed");
        expect(JSON.parse(entry.payload).text).not.toContain("exit code");
        expect(inbox.processObservations.running("other-executor", "", 10)).toHaveLength(1);
        expect(inbox.tail()).toBe(1);
        await expect(observations.settle("crow-executor", settlement(0))).rejects.toThrow("recorded outcome");
        await observations.settle("other-executor", settlement(1));
        expect(inbox.tail()).toBe(2);
    } finally {
        await extensions.close();
        delivery.close();
        inbox.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { Inbox, type InboxEntryInput } from "../../src/store/inbox.ts";
import type {
    ManagedProcessObservationSettlement,
    ManagedProcessObservationStart,
} from "../../src/tools/process-runtime.ts";

const message: InboxEntryInput = {
    source: "vera.crow",
    kind: "crow.message",
    address: "crow-one",
    payload: '{"text":"the map is ready"}',
};

const start: ManagedProcessObservationStart = {
    ownerId: "crow-one",
    processId: "p-crow-one",
    extensionId: "vera.crow",
    description: "Read the treasure map",
    pid: 431,
    startedAt: "2026-11-16T12:00:00.000Z",
};

function scratch(): string {
    return mkdtempSync(join(tmpdir(), "vera-process-observations-"));
}

function settlement(overrides: Partial<ManagedProcessObservationSettlement> = {}): ManagedProcessObservationSettlement {
    return {
        ...start,
        elapsedMs: 320,
        exitCode: 3,
        outputTail: "the chest is locked\n",
        outputTruncated: false,
        ...overrides,
    };
}

test("@core admitted producer entries and their exact proof survive restart without admitting a family", async () => {
    const directory = scratch();
    const path = join(directory, "inbox.db");
    try {
        const first = Inbox.open(path);
        const before = new InboxDeliveryCoordinator(new ConsumerRegistry(first, "node-crow"));
        before.attach({ label: "crow-one", session: "crow-one", notify: () => {} });
        const inserted = await before.appendOnceAdmitted("vera.crow", "p-crow-one", message);
        await before.append({ ...message, payload: "not admitted" });
        before.close();
        first.close();

        const second = Inbox.open(path);
        const after = new InboxDeliveryCoordinator(new ConsumerRegistry(second, "node-crow"));
        const started: number[] = [];
        const asked: number[] = [];
        const session = after.attach({
            label: "crow-one", session: "crow-one", notify: () => {},
            canStartTurn: () => true,
            startTurn: (candidate) => { started.push(candidate.seq); },
            requestAdmission: async (candidate) => { asked.push(candidate.seq); return undefined; },
        });
        await session.pump();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(started).toEqual([inserted.entry.seq]);
        expect(asked).toEqual([inserted.entry.seq + 1]);
        expect(after.isPreAdmitted(inserted.entry.seq + 1)).toBe(false);

        const replay = await after.appendOnceAdmitted("vera.crow", "p-crow-one", { ...message, payload: "retry" });
        expect(replay).toEqual({ created: false, entry: inserted.entry });
        expect(second.tail()).toBe(2);
        expect(started).toEqual([inserted.entry.seq]);
        after.close();
        second.close();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("admitted append rolls back every write on proof failure and cannot upgrade another key", () => {
    const directory = scratch();
    const path = join(directory, "inbox.db");
    try {
        const inbox = Inbox.open(path);
        const raw = new Database(path);
        raw.exec("CREATE TRIGGER refuse_proof BEFORE INSERT ON admitted_entries BEGIN SELECT RAISE(ABORT, 'proof refused'); END");
        expect(() => inbox.appendOnceAdmitted("vera.crow", "p-one", message)).toThrow("proof refused");
        expect(inbox.tail()).toBe(0);
        raw.exec("DROP TRIGGER refuse_proof");
        const ordinary = inbox.appendOnce("vera.crow", "p-one", message);
        expect(() => inbox.appendOnceAdmitted("vera.crow", "p-one", message)).toThrow("does not match");
        expect(inbox.isDurablyAdmitted(ordinary.entry.seq)).toBe(false);
        const admitted = inbox.appendOnceAdmitted("vera.crow", "p-two", message);
        expect(() => inbox.appendOnceAdmitted("vera.crow", "p-two", { ...message, address: "crow-two" })).toThrow("does not match");
        expect(() => inbox.appendOnceAdmitted("vera.crow", "p-three", { ...message, address: null })).toThrow("requires an address");
        expect(inbox.isDurablyAdmitted(admitted.entry.seq)).toBe(true);
        raw.close();
        inbox.close();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a version 3 inbox migrates without losing existing entries", () => {
    const directory = scratch();
    const path = join(directory, "inbox.db");
    try {
        const first = Inbox.open(path);
        const legacy = first.append(message);
        first.close();
        const old = new Database(path);
        old.exec("DROP TABLE admitted_entries; DROP TABLE process_observations; PRAGMA user_version = 3");
        old.close();

        const migrated = Inbox.open(path);
        expect(migrated.entry(legacy.seq)).toEqual(legacy);
        expect(migrated.isDurablyAdmitted(legacy.seq)).toBe(false);
        expect(migrated.processObservations.register("crew-a/1", start)).toMatchObject({ outcome: "running" });
        migrated.close();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a crash after inbox insertion replays without a duplicate notification", () => {
    const directory = scratch();
    const path = join(directory, "inbox.db");
    try {
        const first = Inbox.open(path);
        first.processObservations.register("crew-a/1", start);
        first.processObservations.settle("crew-a/1", settlement());
        const stored = first.appendOnceAdmitted("vera.crow", start.processId, message);
        first.close();

        const second = Inbox.open(path);
        const pending = second.processObservations.pending("", 10);
        expect(pending).toHaveLength(1);
        const replayed = second.appendOnceAdmitted("vera.crow", pending[0]!.processId, message);
        expect(replayed).toEqual({ entry: stored.entry, created: false });
        expect(second.isDurablyAdmitted(replayed.entry.seq)).toBe(true);
        second.processObservations.markDelivered("crew-a/1", start.ownerId, start.processId);
        expect(second.tail()).toBe(1);
        second.close();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("@core observations persist exact ownership, terminal outcome and replay state", () => {
    const directory = scratch();
    const path = join(directory, "inbox.db");
    try {
        const first = Inbox.open(path);
        const observations = first.processObservations;
        expect(observations.register("crew-a/1", start)).toMatchObject({ ...start, outcome: "running", delivered: false });
        expect(observations.register("crew-a/1", start)).toEqual(observations.get(start.processId)!);
        expect(() => observations.register("crew-b/1", start)).toThrow("identity does not match");
        expect(() => observations.settle("crew-a/1", settlement({ ownerId: "crow-two" }))).toThrow("identity does not match");
        expect(() => observations.settle("crew-a/1", settlement({ extensionId: "vera.raven" }))).toThrow("identity does not match");
        expect(() => observations.settle("crew-b/1", settlement())).toThrow("identity does not match");
        expect(observations.settle("crew-a/1", settlement())).toMatchObject({ outcome: "settled", exitCode: 3 });
        expect(observations.settle("crew-a/1", settlement())).toEqual(observations.get(start.processId)!);
        expect(() => observations.settle("crew-a/1", settlement({ exitCode: 0 }))).toThrow("recorded outcome");
        first.close();

        const second = Inbox.open(path);
        const replayed = second.processObservations;
        expect(replayed.pending("", 1)).toMatchObject([{ ...start, outcome: "settled", exitCode: 3, delivered: false }]);
        expect(() => replayed.markDelivered("crew-b/1", start.ownerId, start.processId)).toThrow("not owned");
        replayed.markDelivered("crew-a/1", start.ownerId, start.processId);
        replayed.markDelivered("crew-a/1", start.ownerId, start.processId);
        expect(replayed.pending("", 1)).toEqual([]);
        second.close();

        const third = Inbox.open(path);
        expect(third.processObservations.get(start.processId)).toMatchObject({ delivered: true, exitCode: 3 });
        third.close();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("worker interruption is idempotent, isolated and never invents an exit code", () => {
    const directory = scratch();
    const path = join(directory, "inbox.db");
    try {
        const first = Inbox.open(path);
        const observations = first.processObservations;
        observations.register("crew-a/1", start);
        observations.register("crew-b/1", { ...start, ownerId: "crow-two", processId: "p-crow-two" });
        expect(() => observations.interrupt("crew-b/1", start.ownerId, start.processId)).toThrow("not owned");
        expect(observations.interrupt("crew-a/1", start.ownerId, start.processId)).toMatchObject({ outcome: "interrupted" });
        expect(observations.interrupt("crew-a/1", start.ownerId, start.processId)).toEqual(observations.get(start.processId)!);
        expect(() => observations.settle("crew-a/1", settlement())).toThrow("already interrupted");
        first.close();

        const second = Inbox.open(path);
        const interrupted = second.processObservations.pending("", 10);
        expect(interrupted).toHaveLength(1);
        expect(interrupted[0]).toMatchObject({ processId: start.processId, outcome: "interrupted" });
        expect(interrupted[0]).not.toHaveProperty("exitCode");
        expect(second.processObservations.running("crew-b/1", "", 10)).toHaveLength(1);
        second.close();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("observation pages and retained output are bounded", () => {
    const directory = scratch();
    const path = join(directory, "inbox.db");
    try {
        const inbox = Inbox.open(path);
        const observations = inbox.processObservations;
        for (let index = 0; index < 8; index += 1) {
            observations.register("crew-a/1", { ...start, processId: `p-crow-${index}` });
        }
        expect(() => observations.register("crew-a/1", { ...start, processId: "p-over-limit" })).toThrow("limit reached");
        const first = observations.running("crew-a/1", "", 3);
        const second = observations.running("crew-a/1", first[2]!.processId, 3);
        expect(first.map((entry) => entry.processId)).toEqual(["p-crow-0", "p-crow-1", "p-crow-2"]);
        expect(second.map((entry) => entry.processId)).toEqual(["p-crow-3", "p-crow-4", "p-crow-5"]);
        expect(() => observations.pending("", 101)).toThrow("page size");
        const result = observations.settle("crew-a/1", settlement({
            processId: "p-crow-0",
            outputTail: `${"crow\n".repeat(30)}${"🦜".repeat(2100)}\n`,
        }));
        expect(result.outputTruncated).toBe(true);
        expect(Buffer.byteLength(result.outputTail!, "utf8")).toBeLessThanOrEqual(8192);
        expect(result.outputTail!.match(/\n/g)!.length).toBeLessThanOrEqual(20);
        expect(result.outputTail).not.toContain("�");
        inbox.close();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

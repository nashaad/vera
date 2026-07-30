import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
    Inbox,
    INBOX_SCHEMA_VERSION,
    type InboxEntryInput,
} from "../../src/store/inbox.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import {
    InboxDeliveryCoordinator,
    type InboxPumpFailure,
} from "../../src/host/inbox-delivery.ts";
import type { PendingDelivery } from "../../src/store/session-store.ts";

const directories: string[] = [];

afterEach(() => {
    for (const path of directories.splice(0, directories.length)) {
        rmSync(path, { recursive: true, force: true });
    }
});

function scratch(): string {
    const path = mkdtempSync(join(tmpdir(), "vera-inbox-"));
    directories.push(path);
    return path;
}

function entry(overrides: Partial<InboxEntryInput> = {}): InboxEntryInput {
    return {
        source: "arc",
        kind: "post",
        payload: JSON.stringify({ issue: "nash-93" }),
        ...overrides,
    };
}

class RecordingTarget {
    readonly recorded: PendingDelivery[] = [];
    pending: string[] = [];
    failNext = false;

    recordDelivery(delivery: PendingDelivery): Promise<boolean> {
        if (this.failNext) {
            this.failNext = false;
            return Promise.reject(new Error("same id, different content"));
        }
        this.recorded.push(delivery);
        return Promise.resolve(true);
    }

    pendingDeliveryIds(): readonly string[] {
        return this.pending;
    }
}

function bench(options: { onPumpError?: (failure: InboxPumpFailure) => void } = {}) {
    const inbox = Inbox.open(":memory:");
    const consumers = new ConsumerRegistry(inbox, "node-a");
    const coordinator = new InboxDeliveryCoordinator(consumers, {
        now: () => 1_000,
        setTimer: () => 0,
        clearTimer: () => {},
        ...(options.onPumpError === undefined
            ? {}
            : { onPumpError: options.onPumpError }),
    });
    return { inbox, consumers, coordinator };
}

describe("inbox delivery hardening", () => {
    test("a session never receives an entry addressed to another consumer", async () => {
        const { inbox, coordinator } = bench();
        const target = new RecordingTarget();
        const session = coordinator.attach({
            label: "worker",
            session: "session-1",
            target,
            triggerTurn: () => {},
            minWakeIntervalMs: 0,
        });
        inbox.appendAll([
            entry({ address: "someone-else" }),
            entry({ address: "worker" }),
            entry({ address: null }),
        ]);

        await session.pump();

        expect(target.recorded).toHaveLength(1);
        const content = target.recorded[0]!.content;
        expect(content).toContain("2 new inbox entries");
        inbox.close();
    });

    test("an entry with a null actor is delivered to the session it names", async () => {
        const { inbox, coordinator } = bench();
        const target = new RecordingTarget();
        const session = coordinator.attach({
            label: "worker",
            actor: "worker-actor",
            session: "session-1",
            target,
            triggerTurn: () => {},
            minWakeIntervalMs: 0,
        });
        inbox.appendAll([entry({ actor: null, session: "session-1" })]);

        await session.pump();

        expect(target.recorded).toHaveLength(1);
        inbox.close();
    });

    test("the consumer's own entries are still suppressed on the full pair", async () => {
        const { inbox, coordinator } = bench();
        const target = new RecordingTarget();
        const session = coordinator.attach({
            label: "worker",
            actor: "worker-actor",
            session: "session-1",
            target,
            triggerTurn: () => {},
            minWakeIntervalMs: 0,
        });
        inbox.appendAll([entry({ actor: "worker-actor", session: "session-1" })]);

        await session.pump();

        expect(target.recorded).toHaveLength(0);
        inbox.close();
    });

    test("a stale delivery id cannot advance the offset past the log tail", async () => {
        const { inbox, coordinator } = bench();
        const target = new RecordingTarget();
        target.pending = ["inbox:0-9000"];
        const session = coordinator.attach({
            label: "worker",
            session: "session-1",
            target,
            triggerTurn: () => {},
            minWakeIntervalMs: 0,
        });

        expect(session.consumer.offset()).toBe(0);
        inbox.appendAll([entry(), entry()]);
        await session.pump();

        expect(target.recorded).toHaveLength(1);
        inbox.close();
    });

    test("a failed recordDelivery is surfaced and leaves the offset behind", async () => {
        const failures: InboxPumpFailure[] = [];
        const { inbox, coordinator } = bench({
            onPumpError: (failure) => failures.push(failure),
        });
        const target = new RecordingTarget();
        const session = coordinator.attach({
            label: "worker",
            session: "session-1",
            target,
            triggerTurn: () => {},
            minWakeIntervalMs: 0,
        });
        inbox.appendAll([entry()]);
        target.failNext = true;

        await session.pump();

        expect(failures).toHaveLength(1);
        expect(session.consumer.offset()).toBe(0);

        await session.pump();

        expect(target.recorded).toHaveLength(1);
        expect(session.consumer.offset()).toBe(1);
        inbox.close();
    });

    test("hello reclaims a dormant label without resetting its offset", () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        const first = consumers.hello({ label: "reviewer" });
        inbox.appendAll([entry(), entry()]);
        first.advance(2);
        first.release();

        const next = consumers.hello({ label: "reviewer" });

        expect(next.label).toBe("reviewer");
        expect(next.offset()).toBe(2);
        expect(inbox.offsetOf(first.id)).toBe(2);

        const live = consumers.hello({ label: "reviewer" });
        expect(live.label).toBe("reviewer-2");
        inbox.close();
    });

    test("the host spawn label cannot be claimed through hello", () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");

        expect(() => consumers.hello({ label: "host:spawn" })).toThrow(/reserved/);
        inbox.close();
    });

    test("migration steps run from the stored user_version", () => {
        const directory = scratch();
        const path = join(directory, "inbox.db");
        Inbox.open(path).close();

        const raw = new Database(path);
        expect(raw.query("PRAGMA user_version").get())
            .toEqual({ user_version: INBOX_SCHEMA_VERSION });
        // Rewind to the state a file stamped by the first step alone is in.
        raw.exec("DROP TABLE watch_cursors");
        raw.exec("PRAGMA user_version = 1");
        raw.close();

        const reopened = Inbox.open(path);
        reopened.setWatchCursor("vera.arc/main", "v1:7");

        expect(reopened.watchCursor("vera.arc/main")).toBe("v1:7");
        reopened.close();

        const after = new Database(path);
        expect(after.query("PRAGMA user_version").get())
            .toEqual({ user_version: INBOX_SCHEMA_VERSION });
        after.close();
    });

    test("a corrupt inbox file is quarantined and replaced", () => {
        const directory = scratch();
        const path = join(directory, "inbox.db");
        writeFileSync(path, "this is not a database");

        const inbox = Inbox.open(path);

        expect(inbox.tail()).toBe(0);
        inbox.append(entry());
        expect(inbox.tail()).toBe(1);
        expect(
            readdirSync(directory).some((name) => name.includes(".bad-")),
        ).toBe(true);
        inbox.close();
    });
});

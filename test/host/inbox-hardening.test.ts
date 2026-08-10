import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConsumerRegistry } from "../../src/host/consumers.ts";
import {
    InboxDeliveryCoordinator,
    type InboxNotice,
} from "../../src/host/inbox-delivery.ts";
import {
    Inbox,
    INBOX_SCHEMA_VERSION,
    type InboxEntryInput,
} from "../../src/store/inbox.ts";

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

function bench() {
    const inbox = Inbox.open(":memory:");
    const consumers = new ConsumerRegistry(inbox, "node-a");
    const coordinator = new InboxDeliveryCoordinator(consumers, {
        now: () => Date.parse("2026-08-09T12:00:10.000Z"),
    });
    return { inbox, consumers, coordinator };
}

describe("inbox notice hardening", () => {
    test("address filtering reveals only the matching unread count", async () => {
        const { inbox, coordinator } = bench();
        const notices: InboxNotice[] = [];
        const session = coordinator.attach({
            label: "worker",
            session: "session-1",
            notify: (notice) => notices.push(notice),
        });
        inbox.appendAll([
            entry({ address: "someone-else" }),
            entry({ address: "worker" }),
            entry({ address: null }),
        ]);

        await session.pump();

        expect(notices).toEqual([{ unreadCount: 2 }]);
        expect(session.consumer.offset()).toBe(0);
        inbox.close();
    });

    test("gap-only unread entries emit no notice and do not advance", async () => {
        const { inbox, coordinator } = bench();
        const notices: InboxNotice[] = [];
        const session = coordinator.attach({
            label: "worker",
            session: "session-1",
            notify: (notice) => notices.push(notice),
        });
        inbox.appendAll([
            entry({ kind: "source.gap", address: "worker" }),
            entry({ kind: "source.gap", address: null }),
        ]);

        await session.pump();

        expect(notices).toHaveLength(0);
        expect(session.consumer.offset()).toBe(0);
        inbox.close();
    });

    test("mixed unread entries count only non-gap entries", async () => {
        const { inbox, coordinator } = bench();
        const notices: InboxNotice[] = [];
        const session = coordinator.attach({
            label: "worker",
            session: "session-1",
            notify: (notice) => notices.push(notice),
        });
        inbox.appendAll([
            entry({ kind: "source.gap" }),
            entry({ kind: "post" }),
            entry({ kind: "source.gap" }),
        ]);

        await session.pump();

        expect(notices).toEqual([{ unreadCount: 1 }]);
        expect(session.consumer.offset()).toBe(0);
        inbox.close();
    });

    test("self-echo suppression requires the complete actor/session pair", async () => {
        const { inbox, coordinator } = bench();
        const notices: InboxNotice[] = [];
        const session = coordinator.attach({
            label: "worker",
            actor: "worker-actor",
            session: "session-1",
            notify: (notice) => notices.push(notice),
        });
        inbox.appendAll([
            entry({ actor: null, session: "session-1" }),
            entry({ actor: "worker-actor", session: "session-1" }),
        ]);

        await session.pump();

        expect(notices).toEqual([{ unreadCount: 1 }]);
        expect(session.consumer.offset()).toBe(0);
        inbox.close();
    });

    test("filtered unread status exposes count and oldest age without payloads", () => {
        const { inbox, consumers } = bench();
        const handle = consumers.hello({ label: "worker" });
        inbox.appendAll([
            entry({ ts: "2026-08-09T12:00:02.000Z", address: "worker" }),
            entry({ ts: "2026-08-09T12:00:04.000Z", address: "other" }),
            entry({ ts: "2026-08-09T12:00:06.000Z", kind: "source.gap" }),
        ]);

        expect(handle.unreadStatus({
            limit: 99,
            addresses: ["worker"],
            excludeKinds: ["source.gap"],
        }, Date.parse("2026-08-09T12:00:10.000Z"))).toEqual({
            count: 1,
            oldestAgeMs: 8_000,
        });
        expect(handle.offset()).toBe(0);
        inbox.close();
    });
});

describe("inbox storage hardening", () => {
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

    test("a corrupt inbox fails closed without replacing native messages", () => {
        const directory = scratch();
        const path = join(directory, "inbox.db");
        writeFileSync(path, "this is not a database");

        expect(() => Inbox.open(path)).toThrow();
        expect(readFileSync(path, "utf8")).toBe("this is not a database");
    });
});

import { describe, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConsumerRegistry } from "../../src/host/consumers.ts";
import {
    InboxDeliveryCoordinator,
    MAX_INBOX_NOTICE_COUNT,
    type AttachInboxConsumerRequest,
    type InboxNotice,
} from "../../src/host/inbox-delivery.ts";
import { InboxAdmissionPolicy } from "../../src/host/inbox-admission.ts";
import { Inbox, type InboxEntryInput } from "../../src/store/inbox.ts";

const SESSION = "session-1";

interface Harness {
    readonly inbox: Inbox;
    readonly coordinator: InboxDeliveryCoordinator;
    readonly notices: InboxNotice[];
    attach(overrides?: Partial<AttachInboxConsumerRequest>): ReturnType<
        InboxDeliveryCoordinator["attach"]
    >;
}

function harness(inbox: Inbox = Inbox.open(":memory:")): Harness {
    const consumers = new ConsumerRegistry(inbox, "node-a");
    const notices: InboxNotice[] = [];
    const coordinator = new InboxDeliveryCoordinator(consumers);
    return {
        inbox,
        coordinator,
        notices,
        attach: (overrides = {}) => coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: (notice) => notices.push(notice),
            ...overrides,
        }),
    };
}

function entry(overrides: Partial<InboxEntryInput> = {}): InboxEntryInput {
    return {
        source: "arc",
        kind: "post",
        payload: JSON.stringify({ issue: "nash-93" }),
        ...overrides,
    };
}

describe("inbox arrival notices", () => {
    test("a burst emits only its unread count and leaves the offset unchanged", async () => {
        const bench = harness();
        const session = bench.attach();
        bench.inbox.appendAll([entry(), entry(), entry()]);

        await session.pump();

        expect(bench.notices).toEqual([{ unreadCount: 3 }]);
        expect(Object.keys(bench.notices[0]!)).toEqual(["unreadCount"]);
        expect(session.consumer.offset()).toBe(0);
        expect(session.consumer.lag()).toBe(3);
    });

    test("an empty log emits no notice", async () => {
        const bench = harness();
        await bench.attach().pump();
        expect(bench.notices).toHaveLength(0);
    });

    test("a new consumer starts at the tail instead of noticing history", async () => {
        const bench = harness();
        bench.inbox.appendAll([entry(), entry()]);

        const session = bench.attach();
        await session.pump();

        expect(bench.notices).toHaveLength(0);
        expect(session.consumer.offset()).toBe(2);
    });

    test("self-echo is excluded without advancing past it", async () => {
        const bench = harness();
        const session = bench.attach({ actor: "nash" });
        bench.inbox.append(entry({ actor: "nash", session: SESSION }));

        await session.pump();
        expect(bench.notices).toHaveLength(0);
        expect(session.consumer.offset()).toBe(0);

        bench.inbox.append(entry({ actor: "someone-else", session: "other" }));
        await session.pump();

        expect(bench.notices).toEqual([{ unreadCount: 1 }]);
        expect(session.consumer.offset()).toBe(0);
    });

    test("notice counts are bounded", async () => {
        const bench = harness();
        const session = bench.attach();
        bench.inbox.appendAll(
            Array.from({ length: MAX_INBOX_NOTICE_COUNT + 20 }, () => entry()),
        );

        await session.pump();

        expect(bench.notices).toEqual([{
            unreadCount: MAX_INBOX_NOTICE_COUNT,
        }]);
        expect(session.consumer.offset()).toBe(0);
    });

    test("a released session stops emitting notices", async () => {
        const bench = harness();
        const session = bench.attach();
        session.release();
        bench.inbox.append(entry());

        await session.pump();
        await bench.coordinator.pumpAll();

        expect(bench.notices).toHaveLength(0);
    });

    test("pumpAll inspects every attached session without advancing either", async () => {
        const bench = harness();
        const first = bench.attach();
        const secondNotices: InboxNotice[] = [];
        const second = bench.attach({
            label: "worker",
            session: "session-2",
            notify: (notice) => secondNotices.push(notice),
        });
        expect(second.consumer.label).toBe("worker-2");
        bench.inbox.append(entry());

        await bench.coordinator.pumpAll();

        expect(bench.notices).toEqual([{ unreadCount: 1 }]);
        expect(secondNotices).toEqual([{ unreadCount: 1 }]);
        expect(first.consumer.offset()).toBe(0);
        expect(second.consumer.offset()).toBe(0);
    });

    test("an admitted source starts one delivery turn per arrival burst", async () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        let starts = 0;
        const coordinator = new InboxDeliveryCoordinator(consumers, {
            admission: new InboxAdmissionPolicy({ user: ["arc"] }),
        });
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: () => { starts += 1; },
        });

        await coordinator.append(entry({
            source: "arc",
            kind: "arc.post",
        }));
        await session.pump();

        expect(starts).toBe(1);
        inbox.close();
    });

    test("session admission is source-wide and clears on detach", async () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        const asked: string[] = [];
        let attached = true;
        let starts = 0;
        const coordinator = new InboxDeliveryCoordinator(consumers);
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => attached,
            startTurn: () => { starts += 1; },
            requestAdmission: async (candidate) => {
                asked.push(candidate.sourceFamily);
                return { mode: "session" };
            },
        });

        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));

        expect(asked).toEqual(["filesystem"]);
        expect(starts).toBe(2);

        attached = false;
        session.clientAttachmentChanged(false);
        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        expect(asked).toEqual(["filesystem"]);

        attached = true;
        session.clientAttachmentChanged(true);
        await session.pump();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(asked).toEqual(["filesystem", "filesystem"]);
        expect(starts).toBe(3);
        inbox.close();
    });

    test("unattended sessions hold unknown sources without asking", async () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        let attached = false;
        let asked = 0;
        const coordinator = new InboxDeliveryCoordinator(consumers);
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => attached,
            startTurn: () => undefined,
            requestAdmission: async () => {
                asked += 1;
                return { mode: "once" };
            },
        });

        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        expect(asked).toBe(0);

        attached = true;
        session.clientAttachmentChanged(true);
        await session.pump();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(asked).toBe(1);
        inbox.close();
    });

    test("detaching cancels a pending admission question", async () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        let aborted = false;
        const coordinator = new InboxDeliveryCoordinator(consumers);
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            requestAdmission: async (_candidate, signal) =>
                new Promise((resolve) => {
                    signal.addEventListener("abort", () => {
                        aborted = true;
                        resolve(undefined);
                    }, { once: true });
                }),
        });

        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        session.clientAttachmentChanged(false);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(aborted).toBe(true);
        inbox.close();
    });

    test("admission persistence failures report and leave the entry held", async () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        let failures = 0;
        let starts = 0;
        const coordinator = new InboxDeliveryCoordinator(consumers);
        coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: () => { starts += 1; },
            requestAdmission: async () => {
                throw new Error("config is read-only");
            },
            onAdmissionFailure: () => { failures += 1; },
        });

        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(failures).toBe(1);
        expect(starts).toBe(0);
        inbox.close();
    });

    test("always admission persists before waking and covers later entries", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-inbox-delivery-"));
        const userConfigPath = join(root, "config.json");
        writeFileSync(userConfigPath, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
        }));
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        const asked: string[] = [];
        let starts = 0;
        const coordinator = new InboxDeliveryCoordinator(consumers, {
            admission: new InboxAdmissionPolicy({
                user: [],
                userConfigPath,
            }),
        });
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: () => { starts += 1; },
            requestAdmission: async (candidate) => {
                asked.push(candidate.sourceFamily);
                return { mode: "always", scope: "user" };
            },
        });

        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));

        expect(asked).toEqual(["filesystem"]);
        expect(starts).toBe(2);
        expect(coordinator.admissionPolicy()?.allows("filesystem")).toBe(true);
        await session.pump();
        inbox.close();
        rmSync(root, { recursive: true, force: true });
    });

    test("project admission is selected per attached workspace", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-inbox-delivery-scope-"));
        const firstRoot = join(root, "first");
        const secondRoot = join(root, "second");
        mkdirSync(join(firstRoot, ".vera"), { recursive: true });
        mkdirSync(join(secondRoot, ".vera"), { recursive: true });
        writeFileSync(join(firstRoot, ".vera", "config.json"), JSON.stringify({
            inbox: { admit: ["filesystem"] },
        }));
        writeFileSync(join(secondRoot, ".vera", "config.json"), JSON.stringify({
            inbox: { admit: [] },
        }));
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        let firstStarts = 0;
        let secondStarts = 0;
        const coordinator = new InboxDeliveryCoordinator(consumers, {
            admissionFor: (projectRoot) => new InboxAdmissionPolicy({
                user: [],
                projectRoot,
            }),
        });
        coordinator.attach({
            label: "first",
            projectRoot: firstRoot,
            session: "first-session",
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: () => { firstStarts += 1; },
        });
        coordinator.attach({
            label: "second",
            projectRoot: secondRoot,
            session: "second-session",
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: () => { secondStarts += 1; },
        });

        await coordinator.append(entry({
            source: "watch/first",
            kind: "filesystem.changed",
            address: "first",
        }));
        await coordinator.append(entry({
            source: "watch/second",
            kind: "filesystem.changed",
            address: "second",
        }));

        expect(firstStarts).toBe(1);
        expect(secondStarts).toBe(0);
        inbox.close();
        rmSync(root, { recursive: true, force: true });
    });
});

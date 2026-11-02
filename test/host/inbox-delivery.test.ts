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
    type InboxAdmissionDecision,
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

    test("a cancelled admission question is asked again at the next arrival, not on its own", async () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        const answers: (InboxAdmissionDecision | undefined)[] = [
            undefined,
            undefined,
            { mode: "once" },
        ];
        const asked: number[] = [];
        const started: number[] = [];
        const coordinator = new InboxDeliveryCoordinator(consumers);
        coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: (candidate) => { started.push(candidate.seq); },
            requestAdmission: async (candidate) => {
                asked.push(candidate.seq);
                return answers.shift();
            },
        });

        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(asked).toEqual([1]);
        expect(started).toEqual([]);

        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(asked).toEqual([1, 1]);
        expect(started).toEqual([]);

        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(asked).toEqual([1, 1, 1]);
        expect(started).toEqual([1]);
        inbox.close();
    });

    test("an admitted entry behind an unanswered head starts a turn", async () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        const asked: number[] = [];
        const started: number[] = [];
        const coordinator = new InboxDeliveryCoordinator(consumers);
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: (candidate) => { started.push(candidate.seq); },
            requestAdmission: async (candidate) => {
                asked.push(candidate.seq);
                return undefined;
            },
        });

        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(session.hasAdmittedPending()).toBe(false);

        await coordinator.appendAdmitted(entry({
            source: "example.scout",
            kind: "extension_message",
        }));

        expect(started).toEqual([2]);
        expect(session.hasAdmittedPending()).toBe(true);
        expect(asked.every((seq) => seq === 1)).toBe(true);
        inbox.close();
    });

    test("only the first unadmitted entry is asked about while an admitted one starts behind it", async () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "node-a");
        const asked: string[] = [];
        const started: number[] = [];
        const coordinator = new InboxDeliveryCoordinator(consumers);
        coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: (candidate) => { started.push(candidate.seq); },
            requestAdmission: (candidate, signal) => {
                asked.push(`${candidate.seq}:${candidate.sourceFamily}`);
                return new Promise((resolve) => {
                    signal.addEventListener("abort", () => resolve(undefined), { once: true });
                });
            },
        });

        inbox.appendAll([
            entry({ source: "watch/git", kind: "filesystem.changed" }),
            entry({ source: "arc", kind: "arc.post" }),
        ]);
        await coordinator.appendAdmitted(entry({
            source: "example.scout",
            kind: "extension_message",
        }));

        expect(asked).toEqual(["1:filesystem"]);
        expect(started).toEqual([3]);
        inbox.close();
    });

    test("a dismissed question is asked again only by an arrival the conversation can see, or a reattach", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(
            new ConsumerRegistry(inbox, "node-a"),
        );
        const asked: string[] = [];
        const attachCrow = (label: string) => coordinator.attach({
            label,
            session: label,
            notify: () => undefined,
            canStartTurn: () => true,
            requestAdmission: async (candidate) => {
                asked.push(`${label}:${candidate.seq}`);
                return undefined;
            },
        });
        const crowA = attachCrow("crow-a");
        attachCrow("crow-b");
        const watched = { source: "watch/git", kind: "filesystem.changed" };

        await coordinator.append(entry({ ...watched, address: "crow-a" }));
        await settle();
        expect(asked).toEqual(["crow-a:1"]);

        await coordinator.append(entry({ ...watched, address: "crow-b" }));
        await settle();
        expect(asked).toEqual(["crow-a:1", "crow-b:2"]);

        await coordinator.append(entry({ ...watched, address: "crow-a" }));
        await settle();
        expect(asked).toEqual(["crow-a:1", "crow-b:2", "crow-a:1"]);

        await coordinator.append(entry(watched));
        await settle();
        expect(asked.slice(3).sort()).toEqual(["crow-a:1", "crow-b:2"]);

        crowA.clientAttachmentChanged(false);
        await crowA.pump();
        await settle();
        expect(asked.slice(5)).toEqual(["crow-a:1"]);
        inbox.close();
    });

    test("an arrival right after a dismissal asks again", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(
            new ConsumerRegistry(inbox, "node-a"),
        );
        const asked: number[] = [];
        let dismiss: (value: undefined) => void = () => undefined;
        coordinator.attach({
            label: "crow",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            requestAdmission: (candidate) => {
                asked.push(candidate.seq);
                return new Promise<undefined>((resolve) => { dismiss = resolve; });
            },
        });
        const watched = { source: "watch/git", kind: "filesystem.changed" };
        await coordinator.append(entry(watched));
        await settle();
        expect(asked).toEqual([1]);

        dismiss(undefined);
        await Promise.resolve();
        await coordinator.append(entry(watched));
        await settle();
        expect(asked).toEqual([1, 1]);
        inbox.close();
    });

    test("an entry delivered behind an unread one is acknowledged once, when the one before it is read", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(
            new ConsumerRegistry(inbox, "node-a"),
        );
        const started: number[] = [];
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: (candidate) => { started.push(candidate.seq); },
            requestAdmission: async () => undefined,
        });
        await coordinator.append(entry({
            source: "watch/git",
            kind: "filesystem.changed",
        }));
        await coordinator.appendAdmitted(entry({
            source: "example.scout",
            kind: "extension_message",
        }));
        await coordinator.appendAdmitted(entry({
            source: "example.scout",
            kind: "extension_message",
        }));
        await settle();
        expect(started).toEqual([2, 3]);
        expect(session.hasAdmittedPending()).toBe(true);

        session.noteDelivered(2);
        session.noteDelivered(3);
        expect(session.consumer.offset()).toBe(0);
        expect(session.hasAdmittedPending()).toBe(false);

        session.clientAttachmentChanged(false);
        await session.pump();
        await settle();
        expect(started).toEqual([2, 3]);

        session.consumer.acknowledge(1);
        session.acknowledgeDelivered();
        expect(session.consumer.offset()).toBe(3);
        expect(session.hasAdmittedPending()).toBe(false);

        session.acknowledgeDelivered();
        expect(session.consumer.offset()).toBe(3);
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

describe("inbox delivery edges", () => {
    test("an admitted entry past the first window of unread entries still starts a turn", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"));
        const started: number[] = [];
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: (candidate) => { started.push(candidate.seq); },
            requestAdmission: (_candidate, signal) => new Promise((resolve) => {
                signal.addEventListener("abort", () => resolve(undefined), { once: true });
            }),
        });
        inbox.appendAll(Array.from(
            { length: MAX_INBOX_NOTICE_COUNT },
            () => entry({ source: "watch/git", kind: "filesystem.changed" }),
        ));

        await coordinator.appendAdmitted(entry({
            source: "example.scout",
            kind: "extension_message",
        }));

        expect(started).toEqual([MAX_INBOX_NOTICE_COUNT + 1]);
        expect(session.hasAdmittedPending()).toBe(true);
        inbox.close();
    });

    test("an admitted family behind a full window of held entries still starts a turn", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"), {
            admission: new InboxAdmissionPolicy({ user: ["arc"] }),
        });
        const started: number[] = [];
        coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: (candidate) => { started.push(candidate.seq); },
        });
        inbox.appendAll(Array.from(
            { length: MAX_INBOX_NOTICE_COUNT },
            () => entry({ source: "watch/git", kind: "filesystem.changed" }),
        ));

        await coordinator.append(entry({ source: "arc", kind: "arc.post" }));

        expect(started).toEqual([MAX_INBOX_NOTICE_COUNT + 1]);
        inbox.close();
    });

    test("an arrival past the first window asks again after a dismissal", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"));
        const asked: number[] = [];
        coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            requestAdmission: async (candidate) => {
                asked.push(candidate.seq);
                return undefined;
            },
        });
        inbox.appendAll(Array.from(
            { length: MAX_INBOX_NOTICE_COUNT + 20 },
            () => entry({ source: "watch/git", kind: "filesystem.changed" }),
        ));
        await coordinator.pumpAll();
        await settle();
        expect(asked).toEqual([1]);

        await coordinator.append(entry({ source: "watch/git", kind: "filesystem.changed" }));
        await settle();

        expect(asked).toEqual([1, 1]);
        inbox.close();
    });

    test("a start that fails asynchronously is retried at the next pump", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"), {
            admission: new InboxAdmissionPolicy({ user: ["arc"] }),
        });
        const started: number[] = [];
        let failNext = true;
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: async (candidate) => {
                started.push(candidate.seq);
                if (failNext) {
                    failNext = false;
                    throw new Error("the delivery could not be recorded");
                }
            },
        });

        await coordinator.append(entry({ source: "arc", kind: "arc.post" }));
        await settle();
        expect(started).toEqual([1]);

        await session.pump();
        await settle();

        expect(started).toEqual([1, 1]);
        await session.pump();
        await settle();
        expect(started).toEqual([1, 1]);
        inbox.close();
    });

    test("a start that throws keeps the earlier wake of its family", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"), {
            admission: new InboxAdmissionPolicy({ user: ["arc"] }),
        });
        const started: number[] = [];
        let failSecond = true;
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: (candidate) => {
                started.push(candidate.seq);
                if (candidate.seq === 2 && failSecond) {
                    failSecond = false;
                    throw new Error("recipient closed");
                }
            },
        });
        inbox.appendAll([
            entry({ source: "arc", kind: "arc.post" }),
            entry({ source: "arc", kind: "arc.post" }),
        ]);

        await session.pump();
        await session.pump();

        expect(started).toEqual([1, 2, 2]);
        inbox.close();
    });

    test("a failed start does not start a later entry of the same family a second time", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"), {
            admission: new InboxAdmissionPolicy({ user: ["arc"] }),
            retryDelaysMs: [],
        });
        const started: number[] = [];
        let rejectFirst: ((error: Error) => void) | undefined;
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: (candidate) => {
                started.push(candidate.seq);
                if (candidate.seq === 1 && started.length === 1) {
                    return new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
                }
            },
        });
        inbox.appendAll([
            entry({ source: "arc", kind: "arc.post" }),
            entry({ source: "arc", kind: "arc.post" }),
        ]);
        await session.pump();
        expect(started).toEqual([1, 2]);

        rejectFirst?.(new Error("the delivery could not be recorded"));
        await settle();
        await session.pump();

        expect(started).toEqual([1, 2, 1]);
        session.release();
        inbox.close();
    });

    test("a start that keeps failing is retried a few times, then reported once", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"), {
            admission: new InboxAdmissionPolicy({ user: ["arc"] }),
            retryDelaysMs: [5, 5],
        });
        const started: number[] = [];
        const reported: number[] = [];
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: async (candidate) => {
                started.push(candidate.seq);
                if (candidate.seq === 1) throw new Error("the delivery could not be recorded");
            },
            onStartFailure: (candidate) => { reported.push(candidate.seq); },
        });

        await coordinator.append(entry({ source: "arc", kind: "arc.post" }));
        await Bun.sleep(150);

        expect(started).toEqual([1, 1, 1]);
        expect(reported).toEqual([1]);

        // A later arrival still gets one more try, and the entry is not reported again.
        await coordinator.append(entry({ source: "arc", kind: "arc.post" }));
        await Bun.sleep(150);
        expect(started.filter((seq) => seq === 1)).toHaveLength(4);
        expect(reported).toEqual([1]);
        session.release();
        inbox.close();
    });

    test("a retry that succeeds is not reported and stops retrying", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"), {
            admission: new InboxAdmissionPolicy({ user: ["arc"] }),
            retryDelaysMs: [5, 5],
        });
        const started: number[] = [];
        const reported: number[] = [];
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: async (candidate) => {
                started.push(candidate.seq);
                if (started.length === 1) throw new Error("the delivery could not be recorded");
            },
            onStartFailure: (candidate) => { reported.push(candidate.seq); },
        });

        await coordinator.append(entry({ source: "arc", kind: "arc.post" }));
        await Bun.sleep(100);

        expect(started).toEqual([1, 1]);
        expect(reported).toEqual([]);
        session.release();
        inbox.close();
    });

    test("releasing the session cancels a pending retry", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"), {
            admission: new InboxAdmissionPolicy({ user: ["arc"] }),
            retryDelaysMs: [20],
        });
        const started: number[] = [];
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: async (candidate) => {
                started.push(candidate.seq);
                throw new Error("the delivery could not be recorded");
            },
        });
        await coordinator.append(entry({ source: "arc", kind: "arc.post" }));
        await settle();
        expect(started).toEqual([1]);

        session.release();
        await Bun.sleep(80);

        expect(started).toEqual([1]);
        inbox.close();
    });

    test("a client that reattaches sees a delivery failure reported again", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"), {
            admission: new InboxAdmissionPolicy({ user: ["arc"] }),
            retryDelaysMs: [5, 5],
        });
        const started: number[] = [];
        const reported: number[] = [];
        let attached = true;
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => attached,
            startTurn: async (candidate) => {
                started.push(candidate.seq);
                throw new Error("the delivery could not be recorded");
            },
            onStartFailure: (candidate) => { reported.push(candidate.seq); },
        });

        await coordinator.append(entry({ source: "arc", kind: "arc.post" }));
        await Bun.sleep(100);
        expect(reported).toEqual([1]);

        attached = false;
        session.clientAttachmentChanged(false);
        attached = true;
        session.clientAttachmentChanged(true);
        await session.pump();
        await Bun.sleep(100);

        expect(started).toHaveLength(6);
        expect(reported).toEqual([1, 1]);
        session.release();
        inbox.close();
    });

    test("a start from a detached attachment that fails late leaves the new attachment's mark alone", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"), {
            admission: new InboxAdmissionPolicy({ user: ["arc"] }),
            retryDelaysMs: [5],
        });
        const started: number[] = [];
        let attached = true;
        let rejectOld: ((error: Error) => void) | undefined;
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => attached,
            startTurn: (candidate) => {
                started.push(candidate.seq);
                if (started.length === 1) {
                    return new Promise<void>((_resolve, reject) => { rejectOld = reject; });
                }
                return new Promise<void>(() => undefined);
            },
        });
        await coordinator.append(entry({ source: "arc", kind: "arc.post" }));
        expect(started).toEqual([1]);

        attached = false;
        session.clientAttachmentChanged(false);
        attached = true;
        session.clientAttachmentChanged(true);
        await session.pump();
        expect(started).toEqual([1, 1]);

        rejectOld?.(new Error("the delivery could not be recorded"));
        await settle();
        await session.pump();
        await Bun.sleep(50);

        expect(started).toEqual([1, 1]);
        session.release();
        inbox.close();
    });

    test("releasing the session aborts a pending admission question", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"));
        let signal: AbortSignal | undefined;
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            requestAdmission: (_candidate, questionSignal) => {
                signal = questionSignal;
                return new Promise((resolve) => {
                    questionSignal.addEventListener("abort", () => resolve(undefined), { once: true });
                });
            },
        });
        await coordinator.append(entry({ source: "watch/git", kind: "filesystem.changed" }));
        expect(signal?.aborted).toBe(false);

        session.release();
        await settle();

        expect(signal?.aborted).toBe(true);
        inbox.close();
    });

    test("an answer that arrives after release starts nothing", async () => {
        const inbox = Inbox.open(":memory:");
        const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"));
        const started: number[] = [];
        let answer: ((decision: InboxAdmissionDecision) => void) | undefined;
        const session = coordinator.attach({
            label: "worker",
            session: SESSION,
            notify: () => undefined,
            canStartTurn: () => true,
            startTurn: (candidate) => { started.push(candidate.seq); },
            requestAdmission: () => new Promise((resolve) => { answer = resolve; }),
        });
        await coordinator.append(entry({ source: "watch/git", kind: "filesystem.changed" }));

        session.release();
        answer?.({ mode: "once" });
        await settle();

        expect(started).toEqual([]);
        inbox.close();
    });
});

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

import { describe, expect, test } from "bun:test";

import { ConsumerRegistry } from "../../src/host/consumers.ts";
import {
    InboxDeliveryCoordinator,
    MAX_INBOX_NOTICE_COUNT,
    type AttachInboxConsumerRequest,
    type InboxNotice,
} from "../../src/host/inbox-delivery.ts";
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
});

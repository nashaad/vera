import { expect, test } from "bun:test";

import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxAdmissionPolicy } from "../../src/host/inbox-admission.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { MasterInboxBridge, WorkerInboxBridge } from "../../src/host/master/inbox.ts";
import { Inbox } from "../../src/store/inbox.ts";

for (const masterAdmits of [true, false]) {
    test(`the master ${masterAdmits ? "admits" : "holds"} a worker inbox entry`, async () => {
        const inbox = Inbox.open(":memory:");
        const master = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node"), {
            admission: new InboxAdmissionPolicy({ user: masterAdmits ? ["arc"] : [] }),
        });
        const worker = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node"), {
            admission: new InboxAdmissionPolicy({ user: masterAdmits ? [] : ["arc"] }),
        });
        const masterBridge: MasterInboxBridge = new MasterInboxBridge(master, (method, args, signal): Promise<unknown> =>
            workerBridge.handle(method, args, signal ?? new AbortController().signal));
        const workerBridge: WorkerInboxBridge = new WorkerInboxBridge((method, args, signal): Promise<unknown> =>
            masterBridge.handle(method, args, signal));
        worker.setSessionBridge(workerBridge);
        worker.setExternalPump((seq) => master.pumpLocal(seq));
        const starts: number[] = [];
        const session = worker.attach({
            label: "crow", session: "crow", notify: () => {}, canStartTurn: () => true,
            startTurn: (candidate) => { starts.push(candidate.seq); },
        });
        try {
            session.clientAttachmentChanged(true);
            await session.pump();
            await master.append({ source: "arc", kind: "arc.post", address: "crow", payload: "{}" });
            await master.pumpAll();
            await worker.pumpAll();
            expect(starts).toEqual(masterAdmits ? [1] : []);
            expect(session.hasAdmittedPending()).toBe(masterAdmits);
        } finally {
            session.release();
            await worker.drainRemote();
            masterBridge.close();
            worker.close();
            master.close();
            inbox.close();
        }
    });
}

test("a second worker waits until the first releases the same inbox session", async () => {
    const inbox = Inbox.open(":memory:");
    const master = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node"), {
        admission: new InboxAdmissionPolicy({ user: ["arc"] }),
    });
    const starts: string[] = [];
    const makeWorker = (name: string) => {
        const worker = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node"));
        const masterBridge: MasterInboxBridge = new MasterInboxBridge(master, (method, args, signal): Promise<unknown> =>
            workerBridge.handle(method, args, signal ?? new AbortController().signal));
        const workerBridge: WorkerInboxBridge = new WorkerInboxBridge((method, args, signal): Promise<unknown> =>
            masterBridge.handle(method, args, signal));
        worker.setSessionBridge(workerBridge);
        const session = worker.attach({
            label: "crow", session: "crow", notify: () => {}, canStartTurn: () => true,
            startTurn: () => { starts.push(name); },
        });
        session.clientAttachmentChanged(true);
        return { worker, masterBridge, session };
    };
    const first = makeWorker("first");
    let second: ReturnType<typeof makeWorker> | undefined;
    try {
        await first.session.pump();
        second = makeWorker("second");
        const secondPump = second.session.pump();
        expect(await Promise.race([
            secondPump.then(() => "ready"),
            Bun.sleep(50).then(() => "waiting"),
        ])).toBe("waiting");
        await master.append({ source: "arc", kind: "arc.post", address: null, payload: "{}" });
        expect(starts).toEqual(["first"]);
        await first.session.acknowledge(1);
        first.session.release();
        await first.worker.drainRemote();
        await secondPump;
        await master.pumpAll();
        expect(starts).toEqual(["first"]);
    } finally {
        first.session.release();
        second?.session.release();
        await first.worker.drainRemote();
        await second?.worker.drainRemote();
        first.masterBridge.close();
        second?.masterBridge.close();
        first.worker.close();
        second?.worker.close();
        master.close();
        inbox.close();
    }
});

test("an entry arriving while a worker registers its inbox remains unread", async () => {
    const inbox = Inbox.open(":memory:");
    const master = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node"), {
        admission: new InboxAdmissionPolicy({ user: ["arc"] }),
    });
    const worker = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node", true));
    const release = Promise.withResolvers<void>();
    const masterBridge: MasterInboxBridge = new MasterInboxBridge(master, (method, args, signal): Promise<unknown> =>
        workerBridge.handle(method, args, signal ?? new AbortController().signal));
    const workerBridge: WorkerInboxBridge = new WorkerInboxBridge(async (method, args, signal): Promise<unknown> => {
        if (method === "attach") await release.promise;
        return await masterBridge.handle(method, args, signal);
    });
    worker.setSessionBridge(workerBridge);
    const starts: number[] = [];
    const session = worker.attach({
        label: "crow", session: "crow", notify: () => {}, canStartTurn: () => true,
        startTurn: (candidate) => { starts.push(candidate.seq); },
    });
    try {
        session.clientAttachmentChanged(true);
        const pumping = session.pump();
        await master.append({ source: "arc", kind: "arc.post", address: "crow", payload: "{}" });
        release.resolve();
        await pumping;
        expect(starts).toEqual([1]);
        expect(session.consumer.offset()).toBe(0);
    } finally {
        release.resolve();
        session.release();
        await worker.drainRemote();
        masterBridge.close();
        worker.close();
        master.close();
        inbox.close();
    }
});

test("an interrupted start stays held across claims while a later entry wakes normally", async () => {
    const inbox = Inbox.open(":memory:");
    const master = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node"));
    const sent = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = new MasterInboxBridge(master, async (method) => {
        if (method === "start") { sent.resolve(); await release.promise; }
    });
    const starts: number[] = [];
    const notices: number[] = [];
    const second = new MasterInboxBridge(master, async (method, args) => {
        if (method === "start") starts.push((args[1] as { seq: number }).seq);
        if (method === "notify") notices.push((args[1] as { unreadCount: number }).unreadCount);
    });
    const registration = { label: "crow", session: "crow", requestAdmission: false, initialOffset: 0 };
    try {
        await first.handle("attach", ["first", registration]);
        await first.handle("attachment", ["first", true]);
        await master.appendAdmitted({ source: "arc", kind: "arc.post", address: "crow", payload: "first" });
        await sent.promise;
        first.interrupt();
        first.close();

        await second.handle("attach", ["second", registration]);
        await second.handle("pump", ["second"]);
        expect(notices).toEqual([]);
        await second.handle("attachment", ["second", true]);
        await second.handle("pump", ["second"]);
        await second.handle("pump", ["second"]);
        expect(notices).toEqual([1]);
        expect(starts).toEqual([]);
        await master.appendAdmitted({ source: "arc", kind: "arc.post", address: "crow", payload: "second" });
        expect(starts).toEqual([2]);
        await second.handle("acknowledge", ["second", 1]);
        await second.handle("acknowledge", ["second", 2]);
        await second.handle("pump", ["second"]);
        expect(starts).toEqual([2]);
    } finally {
        release.resolve();
        first.close();
        second.close();
        master.close();
        inbox.close();
    }
});

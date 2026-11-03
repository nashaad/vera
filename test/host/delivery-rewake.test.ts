import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxAdmissionPolicy } from "../../src/host/inbox-admission.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) =>
        rm(path, { recursive: true, force: true })
    ));
});

test("a wake held behind an aborted turn is dropped, and the next pump asks for it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-delivery-abort-"));
    temporaryDirectories.push(root);
    const eventLogPath = join(root, "events.jsonl");
    const inbox = Inbox.open(":memory:");
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        { admission: new InboxAdmissionPolicy({ user: ["arc"] }) },
    );
    const registry = new AgentRegistry({
        // The first reply streams slowly enough to abort; the second is the delivery turn.
        createAdapter: () => new FauxAdapter(
            [textResponse("a long and slow reply ".repeat(8)), textResponse("woke")],
            { chunkSize: 4, delayMs: 20 },
        ),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    try {
        const agent = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
            eventLogPath,
        });
        const attachment = agent.attach();
        await receiveType(attachment, "history");
        attachment.send({ type: "prompt", content: "work" });
        await receiveType(attachment, "user_prompt");

        // The wake queues behind the running turn.
        await coordinator.append({
            source: "arc",
            kind: "arc.post",
            address: "deck",
            payload: "{}",
        });
        expect(agent.idleForReplacement()).toBe(false);

        attachment.send({ type: "abort" });
        await receiveType(attachment, "turn_finished");
        expect(await becomes(() => agent.idleForReplacement())).toBe(true);

        // The user's abort is not undone by a turn nobody asked for.
        await Bun.sleep(300);
        expect(await deliveryTurnsStarted(eventLogPath)).toBe(0);
        expect(agent.idleForReplacement()).toBe(true);

        // The entry is still unread, so the next pump wakes it again.
        await coordinator.pumpAll();
        await receiveType(attachment, "turn_finished");
        expect(await deliveryTurnsStarted(eventLogPath)).toBe(1);
        expect(await becomes(() => agent.idleForReplacement())).toBe(true);
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
}, 30_000);

test("a wake folded into a queued one does not make a later pump wake the entries again", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-delivery-fold-"));
    temporaryDirectories.push(root);
    const eventLogPath = join(root, "events.jsonl");
    const inbox = Inbox.open(":memory:");
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        { admission: new InboxAdmissionPolicy({ user: ["arc"] }) },
    );
    const registry = new AgentRegistry({
        // The third reply is only used when the entries are woken a second time.
        createAdapter: () => new FauxAdapter(
            [
                textResponse("a long and slow reply ".repeat(12)),
                textResponse("woke"),
                textResponse("woke again"),
            ],
            { chunkSize: 4, delayMs: 15 },
        ),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    try {
        const agent = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
            eventLogPath,
        });
        const attachment = agent.attach();
        await receiveType(attachment, "history");
        attachment.send({ type: "prompt", content: "work" });
        await receiveType(attachment, "user_prompt");

        // The second wake finds the first still queued behind the running turn and folds into it.
        await coordinator.append({ source: "arc", kind: "arc.post", address: "deck", payload: "{\"n\":1}" });
        await Bun.sleep(50);
        await coordinator.append({ source: "arc", kind: "arc.post", address: "deck", payload: "{\"n\":2}" });
        await receiveType(attachment, "turn_finished");
        await receiveType(attachment, "turn_finished");
        expect(await deliveryTurnsStarted(eventLogPath)).toBe(1);

        // The wake turn left both entries unread, but the conversation was already woken for them.
        await coordinator.append({ source: "arc", kind: "arc.post", address: "someone-else", payload: "{}" });
        await coordinator.pumpAll();
        await Bun.sleep(300);
        expect(await deliveryTurnsStarted(eventLogPath)).toBe(1);
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
}, 30_000);

async function deliveryTurnsStarted(eventLogPath: string): Promise<number> {
    const events = (await readFile(eventLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
    return events.filter((event) => event.type === "delivery_turn_started").length;
}

async function receiveType<T extends AgentUpdate["type"]>(
    attachment: AgentAttachment,
    type: T,
    timeoutMs = 10_000,
): Promise<Extract<AgentUpdate, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const update = await Promise.race([
            attachment.receive(),
            Bun.sleep(Math.max(0, deadline - Date.now())).then(() => undefined),
        ]);
        if (update === undefined) break;
        if (update.type === type) return update as Extract<AgentUpdate, { type: T }>;
    }
    throw new Error(`No ${type} update arrived`);
}

async function becomes(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await Bun.sleep(25);
    }
    return condition();
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

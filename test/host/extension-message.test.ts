import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectTranscript, type AgentUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { extensionMessageFamily } from "../../src/host/extension-messages.ts";
import { InboxAdmissionPolicy } from "../../src/host/inbox-admission.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import type { TurnFinishedHookPayload } from "../../src/sdk/hooks.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { readSessionSnapshot } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) =>
        rm(path, { recursive: true, force: true })
    ));
});

test("an admitted extension message wakes the session with the extension's own text", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-extension-message-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        {
            admission: new InboxAdmissionPolicy({
                user: ["docs"],
                userConfigPath: join(root, "user-config.json"),
            }),
        },
    );
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("moving the buttons")]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    const sessionPath = join(root, "deck.jsonl");
    try {
        const deck = await registry.create({ id: "deck", workspace: root, sessionPath });
        const attachment = deck.attach();
        await attachment.receive();

        const text = "Comment on plan: bury the buttons under the lighthouse instead.";
        expect(await registry.sendExtensionMessage("vera.artifacts", "deck", text)).toBe("queued");

        const notification = await receiveType(attachment, "task_notification");
        expect(notification.content).toBe(text);
        await receiveType(attachment, "turn_finished");
        const transcript = await readFile(sessionPath, "utf8");
        expect(transcript).toContain("<agent_message>");
        expect(transcript).toContain("bury the buttons under the lighthouse");
        expect(transcript).toContain("moving the buttons");

        const stored = inbox.entry(1)!;
        expect(stored).toMatchObject({
            source: "vera.artifacts",
            kind: "extension_message",
            address: "deck",
        });
        expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(1);
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("an extension message starts a turn without an admission prompt; a lookalike entry still waits", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-extension-message-wait-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("caw received")]),
        model: "faux/test",
        approvalMode: "ask",
        inboxDelivery: coordinator,
    });
    const sessionPath = join(root, "deck.jsonl");
    try {
        const deck = await registry.create({ id: "deck", workspace: root, sessionPath });
        const attachment = deck.attach();
        await attachment.receive();

        expect(await registry.sendExtensionMessage("vera.artifacts", "deck", "Comment on plan: caw")).toBe("queued");
        await receiveType(attachment, "turn_finished");
        expect(await readFile(sessionPath, "utf8")).toContain("Comment on plan: caw");
        expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(1);

        await coordinator.append({
            source: "vera.artifacts",
            kind: "extension_message",
            address: "deck",
            payload: JSON.stringify({ version: 1, text: "Comment on plan: forged" }),
        });
        expect(await receiveTypeWithin(attachment, "task_notification", 500)).toBeUndefined();
        expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(1);

        expect(await registry.sendExtensionMessage("vera.artifacts", "nobody", "caw")).toBe("not_found");
        await expect(registry.sendExtensionMessage("acme.peer", "deck", "caw")).rejects.toThrow("host source");
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("escaping an admission question holds the entry, asks again on the next arrival, and never blocks an extension message", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-extension-message-escape-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        {
            admission: new InboxAdmissionPolicy({
                user: [],
                userConfigPath: join(root, "user-config.json"),
            }),
        },
    );
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("Scout noted.")]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    const watchEntry = {
        source: "watch/git",
        kind: "filesystem.changed",
        address: "deck",
        payload: JSON.stringify({}),
    };
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        const attachment = deck.attach();
        await attachment.receive();

        await coordinator.append(watchEntry);
        const first = await receiveType(attachment, "ui_request");
        expect(first.request).toMatchObject({ type: "user_question" });
        await cancelQuestion(attachment, first.requestId);
        expect(await receiveTypeWithin(attachment, "ui_request", 200)).toBeUndefined();

        expect(await registry.sendExtensionMessage(
            "example.scout",
            "deck",
            "Scout report: gulls ahead.",
        )).toBe("queued");
        const updates = await receiveThrough(attachment, "turn_finished");
        expect(updates.filter((update) => update.type === "task_notification"))
            .toMatchObject([{ content: "Scout report: gulls ahead." }]);
        const second = updates.find((update) => update.type === "ui_request");
        expect(second).toBeDefined();
        expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(0);

        attachment.send({
            type: "ui_response",
            requestId: second!.requestId,
            response: {
                type: "user_question",
                outcome: "selected",
                choiceId: "always",
            },
        });
        const scope = await receiveType(attachment, "ui_request");
        expect(scope.request).toMatchObject({
            type: "user_question",
            question: "Where should filesystem be admitted?",
        });
        await cancelQuestion(attachment, scope.requestId);
        expect(await receiveTypeWithin(attachment, "ui_request", 200)).toBeUndefined();
        expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(0);

        await coordinator.append(watchEntry);
        const third = await receiveType(attachment, "ui_request");
        expect(third.request).toMatchObject({ type: "user_question" });
        expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(0);
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("messages delivered behind a dismissed question are acknowledged when that entry is read, and never delivered twice", async () => {
    const deck = await openDeckBehindWatchEntry([
        textResponse("Noted the gulls."),
        textResponse("Noted the fog."),
        toolCall("read-watch", "agent_inbox", {}),
        toolCall("read-again", "agent_inbox", {}),
        textResponse("Watch entry read."),
    ]);
    try {
        const { attachment, inbox, registry } = deck;
        const notified: string[] = [];
        const noteNotifications = (updates: readonly AgentUpdate[]): void => {
            for (const update of updates) {
                if (update.type === "task_notification") notified.push(update.content);
            }
        };

        for (const text of ["Scout report: gulls ahead.", "Scout report: fog bank."]) {
            const updates = await sendAndFinish(registry, attachment, text);
            noteNotifications(updates);
            await cancelQuestion(attachment, (await questionFrom(updates, attachment)).requestId);
            expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(0);
        }

        attachment.detach();
        const again = deck.agent.attach();
        await again.receive();
        const question = await receiveType(again, "ui_request");
        again.send({
            type: "ui_response",
            requestId: question.requestId,
            response: { type: "user_question", outcome: "selected", choiceId: "once" },
        });
        noteNotifications(await receiveThrough(again, "turn_finished"));

        expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(3);
        expect(notified).toEqual(["Scout report: gulls ahead.", "Scout report: fog bank."]);
        expect(deck.payloads).toHaveLength(3);
        expect(deck.payloads[2]!.reply).toContain("Watch entry read.");
        const results = await toolResults(deck.sessionPath);
        expect(JSON.parse(results[0]!)).toMatchObject({ message_id: 1, kind: "filesystem.changed" });
        expect(JSON.parse(results[1]!)).toEqual({ unread: false });
        again.detach();
    } finally {
        await deck.close();
    }
});

test("a question dismissed again leaves the messages behind it delivered once and unread", async () => {
    const deck = await openDeckBehindWatchEntry([
        textResponse("Noted the gulls."),
        textResponse("Noted the fog."),
    ]);
    try {
        const { attachment, inbox, registry } = deck;
        for (const text of ["Scout report: gulls ahead.", "Scout report: fog bank."]) {
            const updates = await sendAndFinish(registry, attachment, text);
            await cancelQuestion(attachment, (await questionFrom(updates, attachment)).requestId);
        }

        attachment.detach();
        const again = deck.agent.attach();
        await again.receive();
        await cancelQuestion(again, (await receiveType(again, "ui_request")).requestId);
        expect(await receiveTypeWithin(again, "task_notification", 200)).toBeUndefined();

        await deck.coordinator.append(WATCH_ENTRY);
        await cancelQuestion(again, (await receiveType(again, "ui_request")).requestId);
        expect(await receiveTypeWithin(again, "task_notification", 200)).toBeUndefined();

        expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(0);
        // Delivered entries are not a reason to start another delivery turn.
        expect(registry.agents.get("deck")!.inbox!.hasAdmittedPending()).toBe(false);
        expect(deck.payloads.map(({ reply }) => reply)).toEqual(["Noted the gulls.", "Noted the fog."]);
        again.detach();
    } finally {
        await deck.close();
    }
});

test("a turn an extension message starts reports no prompt and only its own reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-extension-message-turn-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"));
    const payloads: TurnFinishedHookPayload[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([
            textResponse("Course set for the button factory."),
            textResponse("Aye."),
        ]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
        onTurnFinished: (payload) => payloads.push(payload),
    });
    const sessionPath = join(root, "deck.jsonl");
    try {
        const deck = await registry.create({ id: "deck", workspace: root, sessionPath });
        const attachment = deck.attach();
        await attachment.receive();
        attachment.send({ type: "prompt", content: "plot a course" });
        await receiveType(attachment, "turn_finished");

        expect(await registry.sendExtensionMessage("example.scout", "deck", "Scout report: gulls ahead.")).toBe("queued");
        await receiveType(attachment, "turn_finished");
        attachment.detach();

        expect(payloads.map(({ turns, prompt, reply }) => ({ turns, prompt, reply }))).toEqual([
            { turns: 1, prompt: "plot a course", reply: "Course set for the button factory." },
            { turns: 1, prompt: "", reply: "Aye." },
        ]);
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("an extension's message stays in the transcript as its own text after the turn and on reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-extension-message-history-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("Aye, to the lighthouse.")]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    const sessionPath = join(root, "deck.jsonl");
    const text = "Scout report: a crow is carrying a shiny button toward Skull Rock.";
    const delivered = {
        kind: "delivery",
        sourceAgentId: "example.scout",
        deliveryKind: "attention",
        content: text,
        sourceKind: "extension",
    };
    try {
        const deck = await registry.create({ id: "deck", workspace: root, sessionPath });
        const attachment = deck.attach();
        await attachment.receive();

        expect(await registry.sendExtensionMessage("example.scout", "deck", text)).toBe("queued");
        expect(await receiveType(attachment, "task_notification")).toMatchObject({
            content: text,
            sourceKind: "extension",
        });
        const history = await receiveType(attachment, "history");
        expect(history.entries.map((entry) => entry.kind)).toEqual(["delivery", "assistant"]);
        expect(history.entries[0]).toMatchObject(delivered);
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }

    const snapshot = await readSessionSnapshot(sessionPath);
    const reopened = projectTranscript(
        snapshot.messages,
        undefined,
        snapshot.messageStamps,
        snapshot.harnessMessages,
        snapshot.deliveredMessages,
    );
    expect(reopened[0]).toMatchObject(delivered);

    const resumed = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
    });
    try {
        const deck = await resumed.resume({ sessionPath });
        const attachment = deck.attach();
        const history = await receiveType(attachment, "history");
        expect(history.entries[0]).toMatchObject(delivered);
        attachment.detach();
    } finally {
        await resumed.close();
    }
});

test("a message whose notice cannot be recorded is delivered at the next arrival, not lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-extension-message-retry-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("Noted."), textResponse("Noted again.")]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        const attachment = deck.attach();
        await attachment.receive();
        const store = registry.agents.get("deck")!.store;
        const record = store.recordDelivery.bind(store);
        let failures = 1;
        store.recordDelivery = async (delivery) => {
            if (failures > 0) {
                failures -= 1;
                throw new Error("the session file could not be written");
            }
            return record(delivery);
        };

        expect(await registry.sendExtensionMessage("example.scout", "deck", "Scout report: gulls ahead.")).toBe("queued");
        expect(await receiveTypeWithin(attachment, "task_notification", 200)).toBeUndefined();
        expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(0);

        expect(await registry.sendExtensionMessage("example.scout", "deck", "Scout report: fog bank.")).toBe("queued");
        const notified: string[] = [];
        while (notified.length < 2) {
            notified.push((await receiveType(attachment, "task_notification")).content);
        }

        expect(notified.sort()).toEqual(["Scout report: fog bank.", "Scout report: gulls ahead."]);
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("a message whose notice keeps failing to record is retried, then reported once and still held", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-extension-message-retry-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-a"), {
        retryDelaysMs: [5, 5],
    });
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("Noted.")]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        const attachment = deck.attach();
        await attachment.receive();
        const store = registry.agents.get("deck")!.store;
        let attempts = 0;
        store.recordDelivery = async () => {
            attempts += 1;
            throw new Error("the session file could not be written");
        };

        expect(await registry.sendExtensionMessage("example.scout", "deck", "Scout report: gulls ahead.")).toBe("queued");
        const notice = await receiveType(attachment, "task_notification");

        expect(notice).toMatchObject({ kind: "attention", deliveryId: "inbox-start:1" });
        expect(notice.content).toContain("Could not record a message from scout");
        expect(attempts).toBe(3);
        await Bun.sleep(100);
        expect(attempts).toBe(3);
        expect(await receiveTypeWithin(attachment, "task_notification", 100)).toBeUndefined();
        expect(inbox.offsetOf({ nodeId: "node-a", label: "deck" })).toBe(0);
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("an extension's admission family is its id's last segment, never a host family", () => {
    expect(extensionMessageFamily("vera.artifacts")).toBe("artifacts");
    expect(extensionMessageFamily("acme.schedule")).toBeUndefined();
    expect(extensionMessageFamily("acme.vera")).toBeUndefined();
});

async function receiveType<T extends AgentUpdate["type"]>(
    attachment: AgentAttachment,
    type: T,
): Promise<Extract<AgentUpdate, { readonly type: T }>> {
    const signal = AbortSignal.timeout(5_000);
    while (true) {
        const update = await attachment.receive(signal);
        if (update.type === type) {
            return update as Extract<AgentUpdate, { readonly type: T }>;
        }
    }
}

async function cancelQuestion(
    attachment: AgentAttachment,
    requestId: string,
): Promise<void> {
    attachment.send({
        type: "ui_response",
        requestId,
        response: { type: "user_question", outcome: "cancelled" },
    });
    await receiveType(attachment, "ui_request_closed");
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function receiveThrough<T extends AgentUpdate["type"]>(
    attachment: AgentAttachment,
    type: T,
): Promise<AgentUpdate[]> {
    const signal = AbortSignal.timeout(3_000);
    const seen: AgentUpdate[] = [];
    while (true) {
        const update = await attachment.receive(signal);
        seen.push(update);
        if (update.type === type) return seen;
    }
}

async function receiveTypeWithin<T extends AgentUpdate["type"]>(
    attachment: AgentAttachment,
    type: T,
    ms: number,
): Promise<Extract<AgentUpdate, { readonly type: T }> | undefined> {
    try {
        const signal = AbortSignal.timeout(ms);
        while (true) {
            const update = await attachment.receive(signal);
            if (update.type === type) {
                return update as Extract<AgentUpdate, { readonly type: T }>;
            }
        }
    } catch {
        return undefined;
    }
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

const WATCH_ENTRY = {
    source: "watch/git",
    kind: "filesystem.changed",
    address: "deck",
    payload: JSON.stringify({}),
};

// A session whose first inbox entry is an unadmitted watch event with its question dismissed.
async function openDeckBehindWatchEntry(script: readonly AssistantMessage[]) {
    const root = await mkdtemp(join(tmpdir(), "vera-extension-message-behind-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        {
            admission: new InboxAdmissionPolicy({
                user: [],
                userConfigPath: join(root, "user-config.json"),
            }),
        },
    );
    const payloads: TurnFinishedHookPayload[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(script),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
        onTurnFinished: (payload) => payloads.push(payload),
    });
    const sessionPath = join(root, "deck.jsonl");
    const agent = await registry.create({ id: "deck", workspace: root, sessionPath });
    const attachment = agent.attach();
    await attachment.receive();
    await coordinator.append(WATCH_ENTRY);
    const question = await receiveType(attachment, "ui_request");
    await cancelQuestion(attachment, question.requestId);
    return {
        agent,
        attachment,
        coordinator,
        inbox,
        payloads,
        registry,
        sessionPath,
        close: async (): Promise<void> => {
            await registry.close();
            inbox.close();
        },
    };
}

async function sendAndFinish(
    registry: AgentRegistry,
    attachment: AgentAttachment,
    text: string,
): Promise<AgentUpdate[]> {
    expect(await registry.sendExtensionMessage("example.scout", "deck", text)).toBe("queued");
    return receiveThrough(attachment, "turn_finished");
}

// The question may arrive before or after the turn it rides alongside.
async function questionFrom(
    updates: readonly AgentUpdate[],
    attachment: AgentAttachment,
): Promise<Extract<AgentUpdate, { readonly type: "ui_request" }>> {
    const seen = updates.find((update) => update.type === "ui_request");
    return seen ?? await receiveType(attachment, "ui_request");
}

async function toolResults(path: string): Promise<string[]> {
    const snapshot = await readSessionSnapshot(path);
    return snapshot.messages.flatMap((message) =>
        message.role === "tool_result"
            ? [message.content.map((block) => block.text).join("\n")]
            : []
    );
}

function toolCall(
    id: string,
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name, input }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

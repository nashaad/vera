import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { extensionMessageFamily } from "../../src/host/extension-messages.ts";
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

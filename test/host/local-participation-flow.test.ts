import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { InboxAdmissionPolicy } from "../../src/host/inbox-admission.ts";
import { parsePeerMessage } from "../../src/host/local-participation.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ModelStream,
} from "../../src/model/types.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) =>
        rm(path, { recursive: true, force: true })
    ));
});

test("two native sessions send, explicitly read, receipt, reply, and read again", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-local-flow-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(":memory:");
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
    );
    const scripts: AssistantMessage[][] = [
        [
            toolCall("left-send", "agent_send", {
                to: "right",
                text: "Can you inspect the parser race?",
            }),
            textResponse("sent"),
            toolCall("left-read-receipt", "agent_inbox", {}),
            textResponse("receipt seen"),
            toolCall("left-read-reply", "agent_inbox", {}),
            textResponse("reply seen"),
        ],
        [
            toolCall("right-read", "agent_inbox", {}),
            textResponse("question read"),
            toolCall("right-reply", "agent_send", {
                to: "left",
                text: "The parser needs a serialized acknowledgement.",
                reply_to: 1,
            }),
            textResponse("reply sent"),
        ],
    ];
    // Ask mode: neither side may take the other's turn, so every message in
    // this flow is read because the agent went looking for it.
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(scripts.shift() ?? []),
        model: "faux/test",
        approvalMode: "ask",
        inboxDelivery: coordinator,
    });
    const leftPath = join(root, "left.jsonl");
    const rightPath = join(root, "right.jsonl");
    const leftEvents = join(root, "left-events.jsonl");
    const rightEvents = join(root, "right-events.jsonl");

    try {
        const left = await registry.create({
            id: "left",
            workspace: root,
            sessionPath: leftPath,
            eventLogPath: leftEvents,
        });
        const right = await registry.create({
            id: "right",
            workspace: root,
            sessionPath: rightPath,
            eventLogPath: rightEvents,
        });
        const leftAttachment = left.attach();
        const rightAttachment = right.attach();
        expect((await leftAttachment.receive()).type).toBe("history");
        expect((await rightAttachment.receive()).type).toBe("history");

        await runPrompt(leftAttachment, "Ask the right participant.");
        expect(await receiveType(rightAttachment, "notice")).toMatchObject({
            type: "notice",
            key: "inbox",
            count: 1,
        });
        expect(inbox.offsetOf({ nodeId: "node-a", label: "right" })).toBe(0);
        expect(JSON.parse(await lastToolResult(leftPath))).toEqual({
            message_id: 1,
            stored: true,
            recipient_live: true,
            notice: "ui",
            delivered: false,
            not_delivered_because: "approval_mode",
        });
        expect(await eventTypes(rightEvents)).not.toContain("turn_started");
        expect(await eventTypes(rightEvents)).not.toContain("delivery_turn_started");
        const preReadEvents = await readFile(rightEvents, "utf8").catch(() => "");
        const preReadSession = await readFile(rightPath, "utf8");
        expect(preReadEvents).toContain(
            '"type":"notice","key":"inbox","count":1',
        );
        expect(preReadEvents).not.toContain("Can you inspect the parser race?");
        expect(preReadEvents).not.toContain("peer.message");
        expect(preReadSession).not.toContain("Can you inspect the parser race?");

        await runPrompt(rightAttachment, "Read the question.");
        const firstRead = JSON.parse(await lastToolResult(rightPath)) as {
            message_id: number;
            complete: boolean;
        };
        expect(firstRead.message_id).toBe(1);
        expect(firstRead.complete).toBe(true);
        expect(inbox.offsetOf({ nodeId: "node-a", label: "right" })).toBe(1);
        expect(inbox.entry(2)).toMatchObject({
            kind: "peer.read",
            actor: "right",
            address: "left",
            payload: JSON.stringify({ message_id: 1, complete: true }),
        });
        expect(await receiveType(leftAttachment, "notice")).toMatchObject({
            type: "notice",
            key: "inbox",
            count: 1,
        });

        await runPrompt(rightAttachment, "Reply to the sender.");
        expect(JSON.parse(await lastToolResult(rightPath))).toMatchObject({
            message_id: 3,
            stored: true,
            recipient_live: true,
            notice: "ui",
        });
        const reply = inbox.entry(3)!;
        expect(parsePeerMessage(reply)).toMatchObject({
            from: "right",
            to: "left",
            reply_to: 1,
            text: "The parser needs a serialized acknowledgement.",
        });

        await runPrompt(leftAttachment, "Read the complete-retrieval receipt.");
        expect(JSON.parse(await lastToolResult(leftPath))).toMatchObject({
            message_id: 2,
            kind: "peer.read",
            read_message_id: 1,
            complete: true,
        });
        expect(inbox.offsetOf({ nodeId: "node-a", label: "left" })).toBe(2);

        await runPrompt(leftAttachment, "Read the reply.");
        expect(JSON.parse(await lastToolResult(leftPath))).toMatchObject({
            message_id: 3,
            kind: "peer.message",
            from: "right",
            to: "left",
            reply_to: 1,
            complete: true,
        });
        expect(inbox.offsetOf({ nodeId: "node-a", label: "left" })).toBe(3);
        expect(inbox.readAfter(0, { limit: 20 }).filter(
            (entry) => entry.kind === "peer.read"
        )).toHaveLength(2);

        leftAttachment.detach();
        rightAttachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("an outside-harness entry stays inert and unread across a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-local-external-"));
    temporaryDirectories.push(root);
    const inboxPath = join(root, "inbox.db");
    const sessionPath = join(root, "right.jsonl");
    const eventPath = join(root, "right-events.jsonl");
    const secret = "outside payload must wait for agent_inbox";
    let inbox = Inbox.open(inboxPath);
    let coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
    );
    let registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });

    const right = await registry.create({
        id: "right",
        workspace: root,
        sessionPath,
        eventLogPath: eventPath,
    });
    const attachment = right.attach();
    await attachment.receive();
    const stored = await coordinator.append({
        source: "foreign-harness",
        kind: "outside.message",
        actor: "remote-actor",
        session: "remote-session",
        address: "right",
        payload: JSON.stringify({ text: secret }),
    });
    expect(await receiveType(attachment, "notice")).toMatchObject({
        key: "inbox",
        count: 1,
    });
    expect(inbox.offsetOf({ nodeId: "node-a", label: "right" })).toBe(0);
    expect(await readFile(eventPath, "utf8").catch(() => "")).not.toContain(secret);
    expect(await readFile(sessionPath, "utf8")).not.toContain(secret);
    attachment.detach();
    await registry.close();
    inbox.close();

    inbox = Inbox.open(inboxPath);
    coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
    );
    registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([
            toolCall("read-external", "agent_inbox", {}),
            textResponse("read"),
        ]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    try {
        const resumed = await registry.resume({
            sessionPath,
            eventLogPath: eventPath,
        });
        const resumedAttachment = resumed.attach();
        await resumedAttachment.receive();
        await runPrompt(resumedAttachment, "Read the pending outside message.");
        expect(JSON.parse(await lastToolResult(sessionPath))).toMatchObject({
            message_id: stored.seq,
            source: "foreign-harness",
            kind: "outside.message",
            actor: "remote-actor",
            address: "right",
            payload: JSON.stringify({ text: secret }),
            payload_truncated: false,
            complete: true,
        });
        expect(inbox.offsetOf({ nodeId: "node-a", label: "right" }))
            .toBe(stored.seq);
        resumedAttachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("an invalid reply id falls back to a new durable message", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-local-reply-fallback-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(":memory:");
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
    );
    const senderPath = join(root, "sender.jsonl");
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([
            toolCall("send", "agent_send", {
                to: "recipient",
                text: "Please inspect the parser.",
                reply_to: 1,
            }),
            textResponse("sent"),
        ]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });

    try {
        const sender = await registry.create({
            id: "sender",
            workspace: root,
            sessionPath: senderPath,
        });
        const recipient = await registry.create({
            id: "recipient",
            workspace: root,
            sessionPath: join(root, "recipient.jsonl"),
        });
        const senderAttachment = sender.attach();
        const recipientAttachment = recipient.attach();
        await senderAttachment.receive();
        await recipientAttachment.receive();

        await runPrompt(senderAttachment, "Send a new message.");

        expect(JSON.parse(await lastToolResult(senderPath))).toMatchObject({
            message_id: 1,
            stored: true,
            reply_to_applied: false,
        });
        const message = parsePeerMessage(inbox.entry(1)!);
        expect(message).toMatchObject({
            from: "sender",
            to: "recipient",
            text: "Please inspect the parser.",
        });
        expect(message).not.toHaveProperty("reply_to");

        senderAttachment.detach();
        recipientAttachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

 test("concurrent native sends keep unique ordered host message ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-local-concurrent-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(":memory:");
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
    );
    const adapters = [
        new FauxAdapter([
            toolCall("send-a", "agent_send", { to: "right", text: "from a" }),
            textResponse("sent a"),
        ]),
        new FauxAdapter([
            toolCall("send-b", "agent_send", { to: "right", text: "from b" }),
            textResponse("sent b"),
        ]),
        new FauxAdapter([]),
    ];
    const registry = new AgentRegistry({
        createAdapter: () => adapters.shift() ?? new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    try {
        const leftA = await registry.create({
            id: "left-a",
            workspace: root,
            sessionPath: join(root, "left-a.jsonl"),
        });
        const leftB = await registry.create({
            id: "left-b",
            workspace: root,
            sessionPath: join(root, "left-b.jsonl"),
        });
        const right = await registry.create({
            id: "right",
            workspace: root,
            sessionPath: join(root, "right.jsonl"),
        });
        const attachments = [leftA.attach(), leftB.attach(), right.attach()];
        await Promise.all(attachments.map((item) => item.receive()));
        await Promise.all([
            runPrompt(attachments[0]!, "send a"),
            runPrompt(attachments[1]!, "send b"),
        ]);
        const messages = inbox.readAfter(0, { limit: 10 }).filter(
            (entry) => entry.kind === "peer.message",
        );
        expect(messages.map((entry) => entry.seq)).toEqual([1, 2]);
        expect(new Set(messages.map((entry) => entry.actor))).toEqual(
            new Set(["left-a", "left-b"]),
        );
        expect(inbox.offsetOf({ nodeId: "node-a", label: "right" })).toBe(0);
        attachments.forEach((item) => item.detach());
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("agent_inbox cannot skip an earlier outside-harness message", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-local-order-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(":memory:");
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
    );
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([
            toolCall("skip-first", "agent_inbox", { message_id: 2 }),
            textResponse("could not skip"),
        ]),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    const sessionPath = join(root, "right.jsonl");
    try {
        const right = await registry.create({
            id: "right",
            workspace: root,
            sessionPath,
        });
        const attachment = right.attach();
        await attachment.receive();
        await coordinator.append({
            source: "external-a",
            kind: "message",
            address: "right",
            payload: "first",
        });
        await coordinator.append({
            source: "external-b",
            kind: "message",
            address: "right",
            payload: "second",
        });
        await runPrompt(attachment, "Try to read message two first.");
        const result = (await SessionStore.open(sessionPath)).messages().findLast(
            (entry) => entry.role === "tool_result",
        );
        expect(result?.role).toBe("tool_result");
        if (result?.role === "tool_result") {
            expect(result.isError).toBe(true);
            expect(result.content[0]?.text).toContain("read message 1 first");
        }
        expect(inbox.offsetOf({ nodeId: "node-a", label: "right" })).toBe(0);
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("an auto-mode recipient is woken with a notice, never the message", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-local-wake-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(":memory:");
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
    );
    const secret = "the parser race is in the tokenizer";
    const scripts: AssistantMessage[][] = [
        [
            toolCall("send", "agent_send", { to: "right", text: secret }),
            textResponse("sent"),
        ],
        [textResponse("noted")],
    ];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(scripts.shift() ?? []),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    const leftPath = join(root, "left.jsonl");
    const rightPath = join(root, "right.jsonl");

    try {
        const left = await registry.create({
            id: "left",
            workspace: root,
            sessionPath: leftPath,
        });
        const right = await registry.create({
            id: "right",
            workspace: root,
            sessionPath: rightPath,
        });
        const leftAttachment = left.attach();
        const rightAttachment = right.attach();
        await leftAttachment.receive();
        await rightAttachment.receive();

        await runPrompt(leftAttachment, "Tell the right participant.");
        expect(JSON.parse(await lastToolResult(leftPath))).toMatchObject({
            message_id: 1,
            stored: true,
            delivered: true,
        });
        const notification = await receiveType(
            rightAttachment,
            "task_notification",
        );
        expect(notification).toMatchObject({
            kind: "peer",
            sourceAgentId: "left",
        });
        await receiveType(rightAttachment, "turn_finished");

        const transcript = await readFile(rightPath, "utf8");
        expect(transcript).toContain("<agent_message>");
        expect(transcript).toContain("agent_inbox");
        expect(transcript).not.toContain(secret);
        expect(inbox.offsetOf({ nodeId: "node-a", label: "right" })).toBe(0);

        leftAttachment.detach();
        rightAttachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("peer messages use inbox admission before waking a recipient", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-local-admission-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(":memory:");
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        {
            admission: new InboxAdmissionPolicy({
                user: [],
                userConfigPath: join(root, "user-config.json"),
            }),
        },
    );
    const scripts: AssistantMessage[][] = [
        [
            toolCall("send", "agent_send", { to: "right", text: "secret" }),
            textResponse("sent"),
        ],
        [textResponse("must not run")],
    ];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(scripts.shift() ?? []),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    try {
        const left = await registry.create({
            id: "left",
            workspace: root,
            sessionPath: join(root, "left.jsonl"),
            eventLogPath: join(root, "left-events.jsonl"),
        });
        const right = await registry.create({
            id: "right",
            workspace: root,
            sessionPath: join(root, "right.jsonl"),
            eventLogPath: join(root, "right-events.jsonl"),
        });
        const leftAttachment = left.attach();
        const rightAttachment = right.attach();
        await leftAttachment.receive();
        await rightAttachment.receive();

        await runPrompt(leftAttachment, "send the message");
        await receiveType(rightAttachment, "notice");
        const question = await receiveType(rightAttachment, "ui_request");
        expect(question).toMatchObject({
            request: { type: "user_question", outOfBand: true },
        });
        expect(await eventTypes(join(root, "right-events.jsonl")))
            .not.toContain("delivery_turn_started");
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("a chain of peer messages stops waking sessions at the hop cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-local-hop-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(":memory:");
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
    );
    const pingPong = (to: string): AssistantMessage[] => [
        toolCall(`${to}-1`, "agent_send", { to, text: "ping" }),
        textResponse("sent"),
        toolCall(`${to}-2`, "agent_send", { to, text: "ping" }),
        textResponse("sent"),
        toolCall(`${to}-3`, "agent_send", { to, text: "ping" }),
        textResponse("sent"),
    ];
    const scripts = [pingPong("right"), pingPong("left")];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(scripts.shift() ?? []),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    const leftPath = join(root, "left.jsonl");
    const rightPath = join(root, "right.jsonl");

    try {
        const left = await registry.create({
            id: "left",
            workspace: root,
            sessionPath: leftPath,
        });
        const right = await registry.create({
            id: "right",
            workspace: root,
            sessionPath: rightPath,
        });
        const leftAttachment = left.attach();
        const rightAttachment = right.attach();
        await leftAttachment.receive();
        await rightAttachment.receive();

        await runPrompt(leftAttachment, "Start the exchange.");
        const blocked = await waitForToolResult(
            rightPath,
            (value) => value.not_delivered_because === "hop_limit",
        );
        expect(blocked).toMatchObject({
            stored: true,
            delivered: false,
            not_delivered_because: "hop_limit",
        });

        leftAttachment.detach();
        rightAttachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

test("a session cannot be woken faster than the rate limit allows", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-local-rate-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(":memory:");
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
    );
    const burst: AssistantMessage[] = [];
    for (let index = 1; index <= 7; index += 1) {
        burst.push(
            toolCall(`send-${index}`, "agent_send", {
                to: "right",
                text: `ping ${index}`,
            }),
        );
    }
    burst.push(textResponse("sent the burst"));
    const scripts = [burst, []];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(scripts.shift() ?? []),
        model: "faux/test",
        approvalMode: "auto",
        inboxDelivery: coordinator,
    });
    const leftPath = join(root, "left.jsonl");

    try {
        const left = await registry.create({
            id: "left",
            workspace: root,
            sessionPath: leftPath,
        });
        const right = await registry.create({
            id: "right",
            workspace: root,
            sessionPath: join(root, "right.jsonl"),
        });
        const leftAttachment = left.attach();
        const rightAttachment = right.attach();
        await leftAttachment.receive();
        await rightAttachment.receive();

        await runPrompt(leftAttachment, "Send a burst.");
        const results = (await SessionStore.open(leftPath)).messages()
            .filter((entry) => entry.role === "tool_result")
            .map((entry) =>
                JSON.parse(
                    entry.role === "tool_result"
                        ? entry.content[0]?.text ?? "{}"
                        : "{}",
                ) as Record<string, unknown>
            );
        expect(results.filter((value) => value.delivered === true))
            .toHaveLength(6);
        expect(results.at(-1)).toMatchObject({
            stored: true,
            delivered: false,
            not_delivered_because: "rate_limit",
        });

        leftAttachment.detach();
        rightAttachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
});

async function waitForToolResult(
    sessionPath: string,
    matches: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const results = (await SessionStore.open(sessionPath)).messages()
            .filter((entry) => entry.role === "tool_result");
        for (const entry of results) {
            if (entry.role !== "tool_result") continue;
            let value: Record<string, unknown>;
            try {
                value = JSON.parse(entry.content[0]?.text ?? "{}");
            } catch {
                continue;
            }
            if (matches(value)) return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No matching tool result in ${sessionPath}`);
}

 async function runPrompt(
    attachment: AgentAttachment,
    content: string,
    timeoutMs?: number,
): Promise<AgentUpdate[]> {
    attachment.send({ type: "prompt", content });
    const updates: AgentUpdate[] = [];
    const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    while (true) {
        const update = await attachment.receive(signal);
        updates.push(update);
        if (update.type === "turn_finished") return updates;
    }
}

async function receiveType<T extends AgentUpdate["type"]>(
    attachment: AgentAttachment,
    type: T,
): Promise<Extract<AgentUpdate, { readonly type: T }>> {
    while (true) {
        const update = await attachment.receive();
        if (update.type === type) {
            return update as Extract<AgentUpdate, { readonly type: T }>;
        }
    }
}

async function lastToolResult(path: string): Promise<string> {
    const store = await SessionStore.open(path);
    const result = store.messages().findLast(
        (message) => message.role === "tool_result",
    );
    if (result?.role !== "tool_result") throw new Error("missing tool result");
    return result.content.map((block) => block.text).join("\n");
}

async function eventTypes(path: string): Promise<string[]> {
    return (await readFile(path, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { type: string }).type);
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

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

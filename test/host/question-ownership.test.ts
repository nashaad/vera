import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UserQuestionUiResponse } from "../../src/engine/events.ts";
import {
    isUserQuestionUiRequestUpdate,
    type AgentUpdate,
    type UserQuestionUiRequestUpdate,
} from "../../src/engine/protocol.ts";
import {
    attachAgent,
    type AttachedAgentClient,
} from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "ask",
} as const;

const socketTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

socketTest(
    "question ownership: first valid answer wins and closes every client",
    async () => {
        const setup = await createQuestionHost();
        const first = await attachAgent({
            socketPath: setup.socketPath,
            agentId: "agent-1",
        });
        const second = await attachAgent({
            socketPath: setup.socketPath,
            agentId: "agent-1",
        });
        try {
            await receiveMatchingHistory(first, second);
            await first.send({ type: "prompt", content: "ask me" });
            const firstRequest = await receiveQuestion(first);
            const secondRequest = await receiveQuestion(second);
            expect(secondRequest).toEqual(firstRequest);

            await select(first, firstRequest.requestId, "unknown");
            await expectNoUpdate(first);
            await expectNoUpdate(second);
            expect(await eventCount(setup.eventLogPath, "ui_response")).toBe(0);

            await select(second, firstRequest.requestId, "manual");
            const firstRemainder = await receiveThroughTurn(first);
            const secondRemainder = await receiveThroughTurn(second);
            expect(secondRemainder).toEqual(firstRemainder);
            expect(firstRemainder.filter(
                (update) => update.type === "ui_request_closed",
            )).toEqual([expect.objectContaining({
                requestId: firstRequest.requestId,
            })]);

            const firstCheckpoint = await first.receive();
            const secondCheckpoint = await second.receive();
            expect(secondCheckpoint).toEqual(firstCheckpoint);
            expect(firstCheckpoint.type).toBe("history");

            await cancel(first, firstRequest.requestId);
            await expectNoUpdate(first);
            await expectNoUpdate(second);
            expect(await eventCount(setup.eventLogPath, "ui_response")).toBe(1);

            const store = await SessionStore.open(setup.sessionPath);
            const result = store.messages().find(
                (message) => message.role === "tool_result",
            );
            expect(result?.content[0]?.text).toBe(
                JSON.stringify({ choice_id: "manual", label: "Wait for me" }),
            );
        } finally {
            first.close();
            second.close();
            await setup.close();
        }
    },
    5_000,
);

socketTest(
    "question ownership: a reconnect replays the pending resident question",
    async () => {
        const setup = await createQuestionHost();
        const original = await attachAgent({
            socketPath: setup.socketPath,
            agentId: "agent-1",
        });
        let reconnected: AttachedAgentClient | undefined;
        try {
            expect((await original.receive()).type).toBe("history");
            await original.send({ type: "prompt", content: "ask me" });
            const request = await receiveQuestion(original);
            await original.detach();

            reconnected = await attachAgent({
                socketPath: setup.socketPath,
                agentId: "agent-1",
            });
            expect((await reconnected.receive()).type).toBe("history");
            expect(await reconnected.receive()).toMatchObject({
                type: "user_prompt",
                content: "ask me",
            });
            expect(await receiveQuestionUpdate(reconnected)).toEqual(request);

            await cancel(reconnected, request.requestId);
            const remainder = await receiveThroughTurn(reconnected);
            expect(remainder.filter(
                (update) => update.type === "ui_request_closed",
            )).toHaveLength(1);
            expect(await eventCount(setup.eventLogPath, "ui_response")).toBe(1);

            const store = await SessionStore.open(setup.sessionPath);
            const result = store.messages().find(
                (message) => message.role === "tool_result",
            );
            expect(result?.content[0]?.text).toBe(
                JSON.stringify({ cancelled: true }),
            );
        } finally {
            original.close();
            reconnected?.close();
            await setup.close();
        }
    },
    5_000,
);

interface QuestionHostSetup {
    readonly socketPath: string;
    readonly eventLogPath: string;
    readonly sessionPath: string;
    close(): Promise<void>;
}

async function createQuestionHost(): Promise<QuestionHostSetup> {
    const root = await mkdtemp(join(tmpdir(), "vera-question-owner-"));
    const socketPath = join(root, "host.sock");
    const eventLogPath = join(root, "events", "agent-1.jsonl");
    const sessionPath = join(root, "sessions", "agent-1.jsonl");
    const host = await startResidentHost({
        config,
        createAdapter: () => new FauxAdapter([
            questionResponse(),
            textResponse("finished"),
        ]),
        socketPath,
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "events"),
    });
    await host.registry.create({ id: "agent-1", workspace: root });
    return {
        socketPath,
        eventLogPath,
        sessionPath,
        async close(): Promise<void> {
            await host.close();
            await rm(root, { recursive: true, force: true });
        },
    };
}

async function receiveMatchingHistory(
    first: AttachedAgentClient,
    second: AttachedAgentClient,
): Promise<void> {
    const firstHistory = await first.receive();
    const secondHistory = await second.receive();
    expect(secondHistory).toEqual(firstHistory);
    expect(firstHistory.type).toBe("history");
}

async function receiveQuestion(
    client: AttachedAgentClient,
): Promise<UserQuestionUiRequestUpdate> {
    expect((await client.receive()).type).toBe("user_prompt");
    return receiveQuestionUpdate(client);
}

async function receiveQuestionUpdate(
    client: AttachedAgentClient,
): Promise<UserQuestionUiRequestUpdate> {
    while (true) {
        const update = await client.receive();
        if (
            update.type === "ui_request"
            && isUserQuestionUiRequestUpdate(update)
        ) {
            return update;
        }
    }
}

function select(
    client: AttachedAgentClient,
    requestId: string,
    choiceId: string,
): Promise<void> {
    return answer(client, requestId, {
        type: "user_question",
        outcome: "selected",
        choiceId,
    });
}

function cancel(
    client: AttachedAgentClient,
    requestId: string,
): Promise<void> {
    return answer(client, requestId, {
        type: "user_question",
        outcome: "cancelled",
    });
}

function answer(
    client: AttachedAgentClient,
    requestId: string,
    response: UserQuestionUiResponse,
): Promise<void> {
    return client.send({ type: "ui_response", requestId, response });
}

async function receiveThroughTurn(
    client: AttachedAgentClient,
): Promise<AgentUpdate[]> {
    const updates: AgentUpdate[] = [];
    while (true) {
        const update = await client.receive();
        updates.push(update);
        if (update.type === "turn_finished") {
            return updates;
        }
    }
}

async function expectNoUpdate(client: AttachedAgentClient): Promise<void> {
    await expect(client.receive(AbortSignal.timeout(20))).rejects.toThrow();
}

async function eventCount(path: string, type: string): Promise<number> {
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    return lines.filter((line) => (
        JSON.parse(line) as { readonly type: string }
    ).type === type).length;
}

function questionResponse(): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "question-1",
            name: "ask_user",
            input: {
                question: "How should Vera continue?",
                choices: [
                    { id: "automatic", label: "Continue automatically" },
                    { id: "manual", label: "Wait for me" },
                ],
            },
        }],
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

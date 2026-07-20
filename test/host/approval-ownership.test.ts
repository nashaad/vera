import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolApprovalUiResponse } from "../../src/engine/events.ts";
import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    attachAgent,
    type AttachedAgentClient,
} from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
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

for (const scenario of [
    {
        name: "allow wins and a late deny is harmless",
        winner: "first" as const,
        decision: "allow" as const,
        lateDecision: "deny" as const,
        expectedToolStarts: 1,
    },
    {
        name: "deny wins and a late allow is harmless",
        winner: "second" as const,
        decision: "deny" as const,
        lateDecision: "allow" as const,
        expectedToolStarts: 0,
    },
]) {
    socketTest(`approval ownership: ${scenario.name}`, async () => {
        const setup = await createApprovalHost();
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
            await first.send({ type: "prompt", content: "run it" });
            const firstRequest = await receiveApproval(first);
            const secondRequest = await receiveApproval(second);
            expect(secondRequest).toEqual(firstRequest);

            const winner = scenario.winner === "first" ? first : second;
            const loser = scenario.winner === "first" ? second : first;
            await answer(winner, firstRequest.requestId, scenario.decision);

            const firstRemainder = await receiveThroughTurn(first);
            const secondRemainder = await receiveThroughTurn(second);
            expect(secondRemainder).toEqual(firstRemainder);
            expect(firstRemainder.filter(
                (update) => update.type === "ui_request_closed",
            )).toHaveLength(1);
            expect(firstRemainder.filter(
                (update) => update.type === "tool_started",
            )).toHaveLength(scenario.expectedToolStarts);
            const firstCheckpoint = await first.receive();
            const secondCheckpoint = await second.receive();
            expect(firstCheckpoint).toEqual(secondCheckpoint);
            expect(firstCheckpoint.type).toBe("history");

            await answer(loser, firstRequest.requestId, scenario.lateDecision);
            await expectNoUpdate(first);
            await expectNoUpdate(second);
            expect(await eventCount(setup.eventLogPath, "ui_response")).toBe(1);
            expect(await eventCount(
                setup.eventLogPath,
                "tool_execution_started",
            )).toBe(scenario.expectedToolStarts);
        } finally {
            first.close();
            second.close();
            await setup.close();
        }
    }, 5_000);
}

for (const detached of ["first", "second"] as const) {
    socketTest(
        `approval ownership: detaching the ${detached} client leaves the other in control`,
        async () => {
            const setup = await createApprovalHost();
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
                await first.send({ type: "prompt", content: "run it" });
                const firstRequest = await receiveApproval(first);
                const secondRequest = await receiveApproval(second);
                expect(secondRequest).toEqual(firstRequest);

                const leaving = detached === "first" ? first : second;
                const remaining = detached === "first" ? second : first;
                await leaving.detach();
                await answer(remaining, firstRequest.requestId, "deny");

                const remainder = await receiveThroughTurn(remaining);
                expect(remainder.filter(
                    (update) => update.type === "ui_request_closed",
                )).toHaveLength(1);
                expect(remainder.some(
                    (update) => update.type === "turn_finished",
                )).toBe(true);
                expect(await eventCount(setup.eventLogPath, "ui_response")).toBe(1);
            } finally {
                first.close();
                second.close();
                await setup.close();
            }
        },
        5_000,
    );
}

interface ApprovalHostSetup {
    readonly socketPath: string;
    readonly eventLogPath: string;
    close(): Promise<void>;
}

async function createApprovalHost(): Promise<ApprovalHostSetup> {
    const root = await mkdtemp(join(tmpdir(), "vera-approval-owner-"));
    const socketPath = join(root, "host.sock");
    const eventLogPath = join(root, "events", "agent-1.jsonl");
    const host = await startResidentHost({
        config,
        createAdapter: () => new FauxAdapter([
            toolResponse(),
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
    expect(firstHistory).toEqual(secondHistory);
    expect(firstHistory.type).toBe("history");
}

interface ApprovalRequestUpdate {
    readonly type: "ui_request";
    readonly requestId: string;
    readonly request: {
        readonly type: "tool_approval";
    };
    readonly seq: number;
}

async function receiveApproval(
    client: AttachedAgentClient,
): Promise<ApprovalRequestUpdate> {
    expect((await client.receive()).type).toBe("user_prompt");
    const update = await client.receive();
    if (
        update.type !== "ui_request"
        || !isToolApprovalUiRequestUpdate(update)
    ) {
        throw new Error(`Expected approval request, received ${update.type}`);
    }
    return update;
}

function answer(
    client: AttachedAgentClient,
    requestId: string,
    decision: ToolApprovalUiResponse["decision"],
): Promise<void> {
    return client.send({
        type: "ui_response",
        requestId,
        response: { type: "tool_approval", decision },
    });
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

function toolResponse(): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "bash-1",
            name: "bash",
            input: { command: "printf approval-ran" },
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

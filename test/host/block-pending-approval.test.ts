import { expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { blockSessionThroughHost } from "../../src/host/session-block-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { socketTest } from "../support/socket-probe.ts";

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "ask",
} as const;

socketTest(
    "a block that lands while a tool approval is open denies it at once and runs no tool",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-block-approval-"));
        const socketPath = join(root, "host.sock");
        const eventLogPath = join(root, "events", "agent-1.jsonl");
        const host = await startResidentHost({
            config,
            createAdapter: () => new FauxAdapter([
                toolResponse(),
                textResponse("must not run"),
            ]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "events"),
            blockedDirectory: join(root, "blocked"),
        });
        try {
            await host.registry.create({ id: "agent-1", workspace: root });
            const client = await attachAgent({ socketPath, agentId: "agent-1" });
            await client.receive();
            await client.send({ type: "prompt", content: "run it" });
            const request = await receiveApprovalRequest(client);

            const blocked = await blockSessionThroughHost(socketPath, {
                targetAgentId: "agent-1",
                sessionIds: ["agent-1"],
                reason: "approval test",
            });
            expect(blocked).toEqual({ status: "blocked", sessionIds: ["agent-1"] });
            const blockReturned = Date.now();

            const closed = await receiveUntil(
                client,
                (update) => update.type === "ui_request_closed",
            );
            expect(Date.now() - blockReturned).toBeLessThan(2_000);
            expect(closed.type).toBe("ui_request_closed");
            expect(closed).toMatchObject({ requestId: request.requestId });

            const remainder = await receiveUntilTurnFinished(client);
            expect(remainder.some((update) => update.type === "tool_started")).toBe(false);
            expect(await eventCount(eventLogPath, "tool_execution_started")).toBe(0);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    10_000,
);

interface ApprovalRequest {
    readonly requestId: string;
}

async function receiveApprovalRequest(client: AttachedAgentClient): Promise<ApprovalRequest> {
    const update = await receiveUntil(client, (candidate) => (
        candidate.type === "ui_request" && isToolApprovalUiRequestUpdate(candidate)
    ));
    if (update.type !== "ui_request") throw new Error("Expected an approval request");
    return { requestId: update.requestId };
}

async function receiveUntil(
    client: AttachedAgentClient,
    match: (update: AgentUpdate) => boolean,
): Promise<AgentUpdate> {
    while (true) {
        const update = await client.receive(AbortSignal.timeout(5_000));
        if (match(update)) return update;
    }
}

async function receiveUntilTurnFinished(client: AttachedAgentClient): Promise<AgentUpdate[]> {
    const updates: AgentUpdate[] = [];
    while (true) {
        const update = await client.receive(AbortSignal.timeout(5_000));
        updates.push(update);
        if (update.type === "turn_finished") return updates;
    }
}

async function eventCount(path: string, type: string): Promise<number> {
    let contents: string;
    try {
        contents = await readFile(path, "utf8");
    } catch {
        return 0;
    }
    return contents
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { type: string }).type)
        .filter((eventType) => eventType === type).length;
}

function toolResponse(): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "bash-1",
            name: "bash",
            input: { command: "env APPROVAL=ran" },
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

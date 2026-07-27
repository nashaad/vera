import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { abortAgentThroughHost } from "../../src/host/agent-abort-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { sendPromptThroughHost } from "../../src/host/agent-send-client.ts";
import {
    attachAgent,
    type AttachedAgentClient,
} from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

// This covers background work and host control, not permissions. "auto" would
// send background_agent to the review model, which no faux adapter here answers,
// so the reviewer reports an unreadable decision, the turn falls back to a user
// prompt, and nothing is listening to answer it.
const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "full_access",
} as const;

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "background work survives detach and remains controllable through the host",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-background-flow-"));
        const socketPath = join(root, "host.sock");
        const lockPath = join(root, "host.json");
        const sessionDirectory = join(root, "sessions");
        const eventLogDirectory = join(root, "events");
        let adapterNumber = 0;
        const host = await startResidentHost({
            config,
            createAdapter() {
                adapterNumber += 1;
                return adapterNumber === 1
                    ? new FauxAdapter([
                        backgroundToolResponse(),
                        textResponse("Background work started."),
                        textResponse("I incorporated the background result."),
                    ])
                    : new FauxAdapter([
                        textResponse("All integration tests pass."),
                        textResponse("The focused tests pass too."),
                        textResponse("This response should be aborted."),
                    ], { delayMs: 75 });
            },
            socketPath,
            lockPath,
            sessionDirectory,
            eventLogDirectory,
        });

        try {
            await host.registry.create({ id: "parent", workspace: root });
            const parent = await attachAgent({ socketPath, agentId: "parent" });
            expect((await parent.receive()).type).toBe("history");
            await parent.send({
                type: "prompt",
                content: "Run the integration tests in the background",
            });
            await finishTurn(parent);
            await parent.detach();

            const child = await waitForAgent(
                socketPath,
                (agent) =>
                    agent.kind === "background" && agent.status === "completed",
            );
            expect(child.session_path).toBe(
                join(sessionDirectory, `${child.id}.jsonl`),
            );
            const parentStore = await SessionStore.open(
                join(sessionDirectory, "parent.jsonl"),
            );
            await waitForAgent(
                socketPath,
                (agent) => agent.id === "parent" && agent.status === "idle",
            );
            expect((await SessionStore.open(
                join(sessionDirectory, "parent.jsonl"),
            )).pendingDeliveries()).toEqual([]);

            const parentEvents = await eventTypes(
                join(eventLogDirectory, "parent.jsonl"),
            );
            expect(parentEvents.filter((type) => type === "model_request"))
                .toHaveLength(3);
            expect(parentEvents.filter((type) => type === "task_notification"))
                .toHaveLength(1);

            expect(await sendPromptThroughHost(
                socketPath,
                child.id,
                "Run the focused tests",
            )).toBe("The focused tests pass too.");

            const activeSend = sendPromptThroughHost(
                socketPath,
                child.id,
                "Keep working until I cancel",
            );
            await waitForAgent(
                socketPath,
                (agent) => agent.id === child.id && agent.status === "working",
            );
            await abortAgentThroughHost(socketPath, child.id);
            expect(await activeSend).toBe("");
        } finally {
            await host.close();
        }

        const restarted = await startResidentHost({
            config,
            createAdapter: () => new FauxAdapter([
                textResponse("I received the durable completion."),
            ]),
            socketPath,
            lockPath,
            sessionDirectory,
            eventLogDirectory,
        });
        try {
            const parent = await attachAgent({ socketPath, agentId: "parent" });
            expect((await parent.receive()).type).toBe("history");
            await parent.send({
                type: "prompt",
                content: "What did the background task report?",
            });
            expect(await finishTurn(parent)).toBe(
                "I received the durable completion.",
            );
            await parent.detach();

            const parentStore = await SessionStore.open(
                join(sessionDirectory, "parent.jsonl"),
            );
            expect(parentStore.pendingDeliveries()).toEqual([]);
            const internal = parentStore.messages().find(
                (message) => message.role === "user" && message.internal === true,
            );
            const internalText = internal?.content
                .map((block) => block.type === "text" ? block.text : "")
                .join("\n");
            expect(internalText).toContain(
                "<summary>All integration tests pass.</summary>",
            );
        } finally {
            await restarted.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    5_000,
);

async function finishTurn(client: AttachedAgentClient): Promise<string> {
    let response = "";
    while (true) {
        const update = await client.receive();
        if (update.type === "assistant_delta") {
            response += update.text;
        }
        if (update.type === "turn_finished") {
            return response;
        }
    }
}

async function waitForAgent(
    socketPath: string,
    predicate: (agent: RegisteredAgentSummary) => boolean,
): Promise<RegisteredAgentSummary> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const agent = (await listAgentsThroughHost(socketPath)).find(predicate);
        if (agent !== undefined) {
            return agent;
        }
        await Bun.sleep(5);
    }
    throw new Error("Timed out waiting for resident agent state");
}

async function eventTypes(path: string): Promise<string[]> {
    return (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { type: string }).type);
}

function backgroundToolResponse(): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "background-1",
            name: "background_agent",
            input: { description: "Run the integration tests" },
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

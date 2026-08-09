import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { FauxAdapter } from "./faux-adapter.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
} from "../../src/model/types.ts";

const EXTENSION = join(import.meta.dir, "../../examples/extensions/btw");
const sessions = new Map<string, TuiAgentClient>();
let nextSession = 1;

function session(id: string, speaker: "AGENT" | "SIDEKICK"): TuiAgentClient {
    const channel = createInProcessChannel();
    let turns = 0;
    const adapter: ModelAdapter = {
        stream(request) {
            turns += 1;
            return new FauxAdapter([
                response(`${speaker} ANSWERED ${turns}`),
            ]).stream(request);
        },
    };
    void runHeadlessLoop(channel.engine, adapter, "test", "high", {
        approvalMode: speaker === "SIDEKICK" ? "readonly" : "auto",
        readModelSettings: () => ({
            model: "test",
            reasoningEffort: "high",
            contextWindow: 100,
        }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () =>
            speaker === "SIDEKICK" ? "readonly" : "auto",
        updateApprovalMode: async () => undefined,
    });
    const client: TuiAgentClient = {
        agentId: id,
        workspace: process.cwd(),
        async send(command): Promise<void> {
            channel.client.send(command);
        },
        receive(signal) {
            return channel.client.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };
    sessions.set(id, client);
    return client;
}

await startTui({
    client: session("main-1", "AGENT"),
    createSession: async () => session(`main-${++nextSession}`, "AGENT"),
    createAgent: async (_workspace, approvalMode) => {
        if (approvalMode !== "readonly") {
            throw new Error(`expected readonly, received ${approvalMode}`);
        }
        return session(`side-${++nextSession}`, "SIDEKICK");
    },
    attachAgent: async (agentId) => {
        const client = sessions.get(agentId);
        if (client === undefined) throw new Error(`unknown agent ${agentId}`);
        return client;
    },
    clientExtensions: [{ path: EXTENSION, enabled: true, config: null }],
});

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

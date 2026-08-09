import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
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
    let approvalMode = speaker === "SIDEKICK" ? "readonly" : "auto";
    let modelSettings: ModelTurnSettings = {
        provider: "faux",
        model: "test",
        reasoningEffort: "high",
        contextWindow: 100,
        availableModels: [{
            provider: "faux",
            model: "test",
            label: "test",
            description: "Faux test model",
            defaultLevel: "high",
            levels: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
            ],
        }],
    };
    const adapter: ModelAdapter = {
        stream(request) {
            turns += 1;
            return new FauxAdapter([
                response(`${speaker} ANSWERED ${turns}`),
            ]).stream(request);
        },
    };
    void runHeadlessLoop(channel.engine, adapter, "test", "high", {
        approvalMode,
        readModelSettings: () => modelSettings,
        updateModelSettings: async (patch) => {
            modelSettings = {
                ...modelSettings,
                ...(patch.model === undefined ? {} : { model: patch.model }),
                ...(patch.provider === undefined
                    ? {}
                    : { provider: patch.provider }),
                ...(patch.reasoningEffort === undefined
                    ? {}
                    : patch.reasoningEffort === null
                    ? { reasoningEffort: undefined }
                    : { reasoningEffort: patch.reasoningEffort }),
            };
            return modelSettings;
        },
        readApprovalMode: () => approvalMode,
        updateApprovalMode: async (mode) => {
            approvalMode = mode;
            return approvalMode;
        },
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

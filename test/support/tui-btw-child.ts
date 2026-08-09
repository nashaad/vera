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

function session(
    id: string,
    speaker: "AGENT" | "SIDEKICK" | "CHILD",
): TuiAgentClient {
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
            if (speaker === "SIDEKICK" && turns === 5) {
                return new FauxAdapter([{
                    role: "assistant",
                    content: [{
                        type: "tool_call",
                        id: "sidekick-approval",
                        name: "bash",
                        input: {
                            command: "printf approved > /tmp/vera-sidekick-approval",
                        },
                    }],
                    source: { provider: "faux", api: "scripted", model: "test" },
                    usage: emptyUsage(),
                    stopReason: "tool_use",
                }]).stream(request);
            }
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

const main = session("main-1", "AGENT");
session("child-1", "CHILD");

await startTui({
    client: main,
    listAgents: async () => [{
        id: "main-1",
        workspace: process.cwd(),
        session_path: "/sessions/main-1.jsonl",
        kind: "interactive",
        status: "idle",
        live: true,
        title: "Main session",
    }, {
        id: "child-1",
        workspace: process.cwd(),
        session_path: "/sessions/child-1.jsonl",
        kind: "background",
        status: "working",
        live: true,
        parent_id: "main-1",
    }],
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
    resumeSession: async (sessionPath) => {
        const agentId = sessionPath.includes("child-1") ? "child-1" : "main-1";
        const client = sessions.get(agentId);
        if (client === undefined) throw new Error(`unknown session ${sessionPath}`);
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

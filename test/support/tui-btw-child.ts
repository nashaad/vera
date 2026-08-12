import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import {
    HOST_CAPABILITY_AGENT_BRANCH_COMPACTION_BARRIERS,
    HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES,
    HOST_CAPABILITY_AGENT_BRANCH_OPTIONS,
    HOST_CAPABILITY_AGENT_CONTEXT_SYNC,
    HOST_CAPABILITY_HARNESS_MESSAGES,
} from "../../src/host/capabilities.ts";
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
let sidekickId: string | undefined;

function session(
    id: string,
    speaker: "AGENT" | "SIDEKICK" | "PEER" | "CHILD",
    initialApprovalMode?: string,
): TuiAgentClient {
    const channel = createInProcessChannel();
    const clientReady = Promise.withResolvers<void>();
    let turns = 0;
    let imageTurns = 0;
    let manualSeq = 3;
    let askedPeerQuestion = false;
    let approvalMode = initialApprovalMode
        ?? (speaker === "SIDEKICK" ? "readonly" : "auto");
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
            if (
                speaker === "PEER"
                && !askedPeerQuestion
                && JSON.stringify(request).includes("ask from peer")
            ) {
                askedPeerQuestion = true;
                return new FauxAdapter([{
                    role: "assistant",
                    content: [{
                        type: "tool_call",
                        id: "peer-question",
                        name: "ask_user",
                        input: {
                            question: "Answer the peer?",
                            choices: [
                                { id: "yes", label: "Yes" },
                                { id: "no", label: "No" },
                            ],
                        },
                    }],
                    source: { provider: "faux", api: "scripted", model: "test" },
                    usage: emptyUsage(),
                    stopReason: "tool_use",
                }]).stream(request);
            }
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
            const footerMilestoneTurn = JSON.stringify(request)
                .includes("milestone working footer");
            return new FauxAdapter(
                [response(`${speaker} ANSWERED ${turns}`)],
                footerMilestoneTurn ? { delayMs: 250 } : undefined,
            ).stream(request);
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
        supportsHostCapability(capability): boolean {
            return capability === HOST_CAPABILITY_AGENT_BRANCH_OPTIONS
                || capability === HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES
                || capability
                    === HOST_CAPABILITY_AGENT_BRANCH_COMPACTION_BARRIERS
                || capability === HOST_CAPABILITY_AGENT_CONTEXT_SYNC
                || capability === HOST_CAPABILITY_HARNESS_MESSAGES;
        },
        async send(command): Promise<void> {
            if (command.type === "attach_image") {
                await clientReady.promise;
                channel.engine.send({
                    type: "image_attached",
                    requestId: command.requestId,
                    attachment: {
                        id: `${id}-${command.requestId}`,
                        name: "screenshot.png",
                        mediaType: "image/png",
                        bytes: 3,
                        width: 1,
                        height: 1,
                    },
                });
                return;
            }
            if (
                speaker === "SIDEKICK"
                && command.type === "prompt"
                && (command.attachmentIds?.length ?? 0) > 0
            ) {
                imageTurns += 1;
                channel.engine.send({
                    type: "user_prompt",
                    content: command.content,
                    attachments: command.attachmentIds?.map((attachmentId) => ({
                        id: attachmentId,
                        name: "screenshot.png",
                    })),
                    seq: manualSeq++,
                });
                channel.engine.send({
                    type: "assistant_delta",
                    text: `SIDEKICK SAW IMAGE ${imageTurns}`,
                    seq: manualSeq++,
                });
                channel.engine.send({
                    type: "turn_finished",
                    seq: manualSeq++,
                });
                return;
            }
            channel.client.send(command);
        },
        async receive(signal) {
            const update = await channel.client.receive(signal);
            if (update.type === "permissions") clientReady.resolve();
            return update;
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
        parent_id: sidekickId ?? "main-1",
    }],
    createSession: async () => session(`main-${++nextSession}`, "AGENT"),
    createAgent: async (_workspace, approvalMode) => {
        if (approvalMode !== "readonly" && approvalMode !== "ask") {
            throw new Error(`expected readonly or ask, received ${approvalMode}`);
        }
        return approvalMode === "readonly"
            ? session(`side-${++nextSession}`, "SIDEKICK", approvalMode)
            : session(`peer-${++nextSession}`, "PEER", approvalMode);
    },
    branchAgent: async (
        _sourceAgentId,
        approvalMode,
        _attachmentLifetime,
        _initialMessages,
    ) => {
        sidekickId = `side-${++nextSession}`;
        return session(sidekickId, "SIDEKICK", approvalMode);
    },
    syncAgentContext: async () => ({ outcome: "unchanged", turns: 0 }),
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

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

const EXTENSION = join(import.meta.dir, "./injecting-extension");

/** What a seat is: a model the user already admitted, and its provider. */
const POOLED = ["advisor", "second", "broken"].map((poolName) => ({
    provider: "faux",
    model: `faux-${poolName}`,
    label: `faux-${poolName}`,
    poolName,
    available: true,
    verified: true,
    levels: [],
}));

/** Answers with what it was actually sent, so a hidden note is still visible
 * somewhere a test can read it. */
const agent: ModelAdapter = {
    stream(request) {
        const last = request.messages.filter((message) =>
            message.role === "user"
        ).at(-1);
        const text = typeof last?.content === "string"
            ? last.content
            : JSON.stringify(last?.content ?? "");
        return new FauxAdapter([
            response(
                text.includes("ambient fact")
                    ? "AGENT SAW THE HEAD"
                    : "AGENT SAW NO HEAD",
            ),
        ]).stream(request);
    },
};

/** A conversation of its own, so `/clear` has somewhere to go. */
function session(id: string): TuiAgentClient {
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        agent,
        "test",
        "high",
        {
            approvalMode: "auto",
            readModelSettings: () => ({
                model: "test",
                reasoningEffort: "high",
                contextWindow: 100,
                pooled: POOLED,
            }),
            updateModelSettings: async () => undefined,
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => undefined,
            async consult(request) {
                if (request.model === "faux-broken") {
                    throw new Error("provider is down");
                }
                return {
                    text: `SEAT SAW ${request.messages.at(-1)?.content ?? ""}`,
                    model: request.model,
                };
            },
            sendConsultReply: (_ownerId, reply) => channel.engine.send(reply),
        },
    );
    return {
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
}

await startTui({
    client: session("first-session"),
    createSession: async () => session("second-session"),
    clientExtensions: [{ path: EXTENSION, enabled: true, config: {} }],
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

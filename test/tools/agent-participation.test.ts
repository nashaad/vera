import { expect, test } from "bun:test";

import { agentInboxTool } from "../../src/tools/agent-inbox.ts";
import {
    MAX_PEER_MESSAGE_BYTES,
    agentSendTool,
} from "../../src/tools/agent-send.ts";
import { toolDefinitionsForCapabilities } from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const runtime = new ToolRuntime("/workspace");
const signal = new AbortController().signal;

test("agent_send produces a host-owned effect with optional reply identity", async () => {
    expect(await agentSendTool.execute({
        to: "peer-1",
        text: "Please inspect this.",
        reply_to: 42,
    }, runtime, signal)).toEqual({
        kind: "effect",
        effect: {
            type: "agent_send",
            to: "peer-1",
            text: "Please inspect this.",
            replyTo: 42,
        },
    });
});

test("agent_send rejects empty, malformed, and encoded-oversized input", async () => {
    expect(agentSendTool.execute({ to: "", text: "hello" }, runtime, signal))
        .rejects.toThrow(/non-empty to/);
    expect(agentSendTool.execute({
        to: "peer",
        text: "hello",
        reply_to: 0,
    }, runtime, signal)).rejects.toThrow(/positive integer/);
    expect(agentSendTool.execute({
        to: "peer",
        text: "\u0000".repeat(MAX_PEER_MESSAGE_BYTES),
    }, runtime, signal)).rejects.toThrow(/encode to at most/);
});

test("agent_inbox produces a sequential read effect", async () => {
    expect(await agentInboxTool.execute({
        message_id: 7,
    }, runtime, signal)).toEqual({
        kind: "effect",
        effect: {
            type: "agent_inbox",
            messageId: 7,
        },
    });
    expect(agentInboxTool.execute({ message_id: 1.5 }, runtime, signal))
        .rejects.toThrow(/positive integer/);
});

test("native participation tools are exposed only with their effects", () => {
    const absent = toolDefinitionsForCapabilities(["agent_roster"])
        .map((tool) => tool.name);
    const present = toolDefinitionsForCapabilities([
        "agent_roster",
        "agent_send",
        "agent_inbox",
    ]).map((tool) => tool.name);

    expect(absent).not.toContain("agent_send");
    expect(absent).not.toContain("agent_inbox");
    expect(present).toContain("agent_send");
    expect(present).toContain("agent_inbox");
});

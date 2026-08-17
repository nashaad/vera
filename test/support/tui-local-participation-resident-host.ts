import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { startResidentHost } from "../../src/host/runtime.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelInputMessage,
    type ModelRequest,
    type ModelStream,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";
import { veraRuntimeDirectory } from "../../src/profile-paths.ts";

const readyPath = process.env.VERA_TEST_READY_PATH;
if (readyPath === undefined || readyPath.length === 0) {
    throw new Error("VERA_TEST_READY_PATH is required");
}

class LeftParticipantAdapter implements ModelAdapter {
    stream(request: ModelRequest): ModelStream {
        const latest = request.messages.at(-1);
        let response: AssistantMessage;
        if (latest?.role === "tool_result" && latest.toolName === "agent_send") {
            response = textResponse("LEFT SENT");
        } else if (
            latest?.role === "tool_result"
            && latest.toolName === "agent_inbox"
        ) {
            const result = toolResultJson(latest);
            response = result.kind === "peer.read"
                ? toolCall("left-read-reply", "agent_inbox", {})
                : textResponse(`LEFT READ REPLY ${String(result.text ?? "")}`);
        } else if (hasToolResult(request.messages, "agent_send")) {
            response = toolCall("left-read-receipt", "agent_inbox", {});
        } else {
            response = toolCall("left-send", "agent_send", {
                to: "right",
                text: "Can you check the acknowledgement ordering?",
            });
        }
        return new FauxAdapter([response]).stream(request);
    }
}

class RightParticipantAdapter implements ModelAdapter {
    stream(request: ModelRequest): ModelStream {
        const latest = request.messages.at(-1);
        let response: AssistantMessage;
        if (
            latest?.role === "tool_result"
            && latest.toolName === "agent_inbox"
        ) {
            const result = toolResultJson(latest);
            response = toolCall("right-reply", "agent_send", {
                to: "left",
                text: "Use serialized acknowledgement.",
                reply_to: result.message_id,
            });
        } else if (
            latest?.role === "tool_result"
            && latest.toolName === "agent_send"
        ) {
            response = textResponse("RIGHT REPLIED");
        } else {
            response = toolCall("right-read", "agent_inbox", {});
        }
        return new FauxAdapter([response]).stream(request);
    }
}

function hasToolResult(
    messages: readonly ModelInputMessage[],
    toolName: string,
): boolean {
    return messages.some((message) =>
        message.role === "tool_result" && message.toolName === toolName
    );
}

function toolResultJson(message: Extract<ModelInputMessage, { role: "tool_result" }>):
    Record<string, unknown> {
    return JSON.parse(
        message.content.map((content) => content.text).join("\n"),
    ) as Record<string, unknown>;
}

function toolCall(
    id: string,
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name, input }],
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

const adapters: ModelAdapter[] = [
    new LeftParticipantAdapter(),
    new RightParticipantAdapter(),
];
const home = homedir();
const host = await startResidentHost({
    config: {
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        // Ask mode: a peer message notifies, and the recipient reads it only
        // when its own turn comes around, which is the loop under test.
        approval_mode: "ask",
        experimental: { inbox: true },
    },
    createAdapter: () => adapters.shift() ?? new FauxAdapter([]),
    sessionDirectory: join(veraRuntimeDirectory(), "sessions"),
    eventLogDirectory: join(veraRuntimeDirectory(), "events"),
    inboxPath: join(veraRuntimeDirectory(), "inbox.db"),
});

await host.registry.create({ id: "left", workspace: process.cwd() });
await host.registry.create({ id: "right", workspace: process.cwd() });
await writeFile(readyPath, "ready\n", "utf8");

try {
    await new Promise<void>((resolve) => {
        const stop = (): void => resolve();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
} finally {
    await host.close();
}

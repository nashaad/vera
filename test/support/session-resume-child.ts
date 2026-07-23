import { runNdjsonBridge } from "../../clients/stdio/ndjson-bridge.ts";
import { transformMessages } from "../../src/model/transform.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelInputMessage,
    type ModelMessage,
    type ModelRequest,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";

const mode = process.argv[2];
const sessionPath = process.argv[3];
const eventLogPath = process.argv[4];
const approvalMode = parseApprovalMode(process.env.VERA_TEST_APPROVAL_MODE);

if ((mode !== "new" && mode !== "resume") || sessionPath === undefined) {
    throw new Error("Usage: session-resume-child.ts <new|resume> <session-path> [log-path]");
}

const adapter = mode === "new"
    ? new FauxAdapter([
        textResponse("stored alpha"),
        textResponse("abcdefgh"),
    ], { chunkSize: 1, delayMs: 40 })
    : contextAdapter();

await runNdjsonBridge(
    process.stdin,
    process.stdout,
    adapter,
    "test",
    undefined,
    mode === "new"
        ? {
            sessionPath,
            ...(approvalMode === undefined ? {} : { approvalMode }),
            ...(eventLogPath === undefined ? {} : { eventLogPath }),
        }
        : {
            resumeSessionPath: sessionPath,
            ...(approvalMode === undefined ? {} : { approvalMode }),
            ...(eventLogPath === undefined ? {} : { eventLogPath }),
        },
);

function parseApprovalMode(value: string | undefined): ApprovalMode | undefined {
    if (
        value === "ask"
        || value === "auto"
        || value === "full_access"
    ) {
        return value;
    }
    return undefined;
}

function contextAdapter(): ModelAdapter {
    return {
        stream(request: ModelRequest) {
            const providerMessages = transformMessages(request.messages, {
                target: {
                    provider: "faux",
                    api: "strict-replay",
                    model: request.model,
                },
            });
            const response = textResponse([
                `context=${request.messages.map(describeMessage).join("|")}`,
                `safe_roles=${providerMessages.map((message) => message.role).join(",")}`,
                `workspace=${requestWorkspace(request)}`,
            ].join(";"));
            return new FauxAdapter([response]).stream(request);
        },
    };
}

function requestWorkspace(request: ModelRequest): string {
    const line = request.systemPrompt
        ?.split("\n")
        .find((candidate) => candidate.startsWith("Working directory: "));
    return line?.slice("Working directory: ".length) ?? "missing";
}

function describeMessage(message: ModelInputMessage): string {
    if (message.role === "tool_result") {
        return `tool_result:${message.toolName}`;
    }
    const text = message.content
        .map((block) => block.type === "text" ? block.text : "")
        .join("");
    if (text.length > 0) {
        return `${message.role}:${text}`;
    }
    if (message.role === "assistant") {
        const tools = message.content
            .filter((block) => block.type === "tool_call")
            .map((block) => block.name)
            .join(",");
        return `assistant_tools:${tools}`;
    }
    return message.role;
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "strict-replay", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

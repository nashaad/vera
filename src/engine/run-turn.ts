import type {
    AssistantMessage,
    ModelAdapter,
    ModelMessage,
    ToolCallContent,
    ToolResultMessage,
    UserMessage,
} from "../model/types.ts";
import type { FrameEndpoint } from "../rpc/in-process-channel.ts";
import type { AgentFrame, ClientFrame } from "../rpc/frames.ts";
import { bashTool, runBash } from "../tools/bash.ts";

export interface RunTurnState {
    readonly messages: ModelMessage[];
    seq: number;
}

export async function runHeadlessLoop(
    endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
    adapter: ModelAdapter,
    model: string,
): Promise<void> {
    const state: RunTurnState = { messages: [], seq: 0 };

    while (true) {
        await runTurn(endpoint, adapter, model, state);
    }
}

export async function runTurn(
    endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
    adapter: ModelAdapter,
    model: string,
    state: RunTurnState,
): Promise<AssistantMessage> {
    const frame = await endpoint.receive();

    if (frame.type !== "prompt") {
        throw new Error(`Expected prompt frame, received ${frame.type}`);
    }

    const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: frame.content }],
    };
    state.messages.push(userMessage);
    let assistantMessage: AssistantMessage;

    while (true) {
        const stream = adapter.stream({
            model,
            messages: state.messages,
            tools: [bashTool],
        });

        for await (const event of stream) {
            if (event.type === "text_delta") {
                state.seq += 1;
                endpoint.send({
                    type: "assistant_delta",
                    text: event.text,
                    seq: state.seq,
                });
            }
        }

        assistantMessage = await stream.result();
        state.messages.push(assistantMessage);

        if (assistantMessage.stopReason !== "tool_use") {
            break;
        }

        for (const block of assistantMessage.content) {
            if (block.type === "tool_call") {
                const result = await executeTool(endpoint, state, block);
                state.messages.push(result);
            }
        }
    }

    state.seq += 1;
    endpoint.send({ type: "turn_finished", seq: state.seq });
    return assistantMessage;
}

async function executeTool(
    endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
    state: RunTurnState,
    toolCall: ToolCallContent,
): Promise<ToolResultMessage> {
    state.seq += 1;
    endpoint.send({
        type: "tool_started",
        tool: toolCall.name,
        args: toolCall.input,
        seq: state.seq,
    });

    let output: string;
    let isError: boolean;

    if (toolCall.name !== "bash") {
        output = `Unknown tool: ${toolCall.name}`;
        isError = true;
    } else if (typeof toolCall.input.command !== "string") {
        output = "Bash tool requires a string command";
        isError = true;
    } else {
        const result = await runBash(toolCall.input.command);
        output = result.output;
        isError = result.isError;
    }

    state.seq += 1;
    endpoint.send({
        type: "tool_finished",
        tool: toolCall.name,
        seq: state.seq,
    });

    return {
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: output }],
        isError,
    };
}

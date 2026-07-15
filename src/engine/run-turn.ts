import type {
    AssistantMessage,
    ModelAdapter,
    ModelMessage,
    UserMessage,
} from "../model/types.ts";
import type { FrameEndpoint } from "../rpc/in-process-channel.ts";
import type { AgentFrame, ClientFrame } from "../rpc/frames.ts";
import { availableTools, executeToolCall } from "../tools/execute.ts";

export interface RunTurnState {
    readonly messages: ModelMessage[];
    readonly workspace: string;
    seq: number;
}

export async function runHeadlessLoop(
    endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
    adapter: ModelAdapter,
    model: string,
): Promise<void> {
    const state: RunTurnState = {
        messages: [],
        workspace: process.cwd(),
        seq: 0,
    };

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
            tools: availableTools,
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
                state.seq += 1;
                endpoint.send({
                    type: "tool_started",
                    tool: block.name,
                    args: block.input,
                    seq: state.seq,
                });

                const result = await executeToolCall(block, state.workspace);
                state.messages.push(result);

                state.seq += 1;
                endpoint.send({
                    type: "tool_finished",
                    tool: block.name,
                    seq: state.seq,
                });
            }
        }
    }

    state.seq += 1;
    endpoint.send({ type: "turn_finished", seq: state.seq });
    return assistantMessage;
}

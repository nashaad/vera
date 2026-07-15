import type {
    AssistantMessage,
    ModelAdapter,
    ModelMessage,
    UserMessage,
} from "../model/types.ts";
import type { FrameEndpoint } from "../rpc/in-process-channel.ts";
import type { AgentFrame, ClientFrame } from "../rpc/frames.ts";

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
    const stream = adapter.stream({
        model,
        messages: state.messages,
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

    const assistantMessage = await stream.result();
    state.messages.push(assistantMessage);
    state.seq += 1;
    endpoint.send({ type: "turn_finished", seq: state.seq });
    return assistantMessage;
}

import type {
    AssistantMessage,
    ModelAdapter,
    UserMessage,
} from "../model/types.ts";
import type { FrameEndpoint } from "../rpc/in-process-channel.ts";
import type { AgentFrame, ClientFrame } from "../rpc/frames.ts";

export async function runTurn(
    endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
    adapter: ModelAdapter,
    model: string,
): Promise<AssistantMessage> {
    const frame = await endpoint.receive();

    if (frame.type !== "prompt") {
        throw new Error(`Expected prompt frame, received ${frame.type}`);
    }

    const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: frame.content }],
    };
    const stream = adapter.stream({
        model,
        messages: [userMessage],
    });
    let seq = 0;

    for await (const event of stream) {
        if (event.type === "text_delta") {
            seq += 1;
            endpoint.send({
                type: "assistant_delta",
                text: event.text,
                seq,
            });
        }
    }

    const assistantMessage = await stream.result();
    seq += 1;
    endpoint.send({ type: "turn_finished", seq });
    return assistantMessage;
}

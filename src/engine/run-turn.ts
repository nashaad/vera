import type {
    AssistantMessage,
    ModelAdapter,
    ModelMessage,
    ModelReasoningEffort,
    UserMessage,
} from "../model/types.ts";
import type { FrameEndpoint } from "../rpc/in-process-channel.ts";
import type {
    AgentFrame,
    ClientFrame,
    PromptFrame,
} from "../rpc/frames.ts";
import { availableTools, executeToolCall } from "../tools/execute.ts";
import { ToolRuntime } from "../tools/runtime.ts";

export interface RunTurnState {
    readonly messages: ModelMessage[];
    readonly toolRuntime: ToolRuntime;
    readonly queuedPrompts: PromptFrame[];
    seq: number;
}

export async function runHeadlessLoop(
    endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
    adapter: ModelAdapter,
    model: string,
    reasoningEffort?: ModelReasoningEffort,
): Promise<void> {
    const state: RunTurnState = {
        messages: [],
        toolRuntime: new ToolRuntime(process.cwd()),
        queuedPrompts: [],
        seq: 0,
    };

    while (true) {
        await runTurn(endpoint, adapter, model, state, reasoningEffort);
    }
}

export async function runTurn(
    endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
    adapter: ModelAdapter,
    model: string,
    state: RunTurnState,
    reasoningEffort?: ModelReasoningEffort,
): Promise<AssistantMessage> {
    const frame = state.queuedPrompts.shift() ?? await endpoint.receive();

    if (frame.type !== "prompt") {
        throw new Error(`Expected prompt frame, received ${frame.type}`);
    }

    const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: frame.content }],
    };
    state.messages.push(userMessage);
    let assistantMessage: AssistantMessage;
    const turnController = new AbortController();
    const receiveController = new AbortController();
    const abortFrame = receiveAbort(
        endpoint,
        turnController,
        receiveController.signal,
        state.queuedPrompts,
    );

    try {
        while (true) {
            const stream = adapter.stream({
                model,
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                messages: state.messages,
                tools: availableTools,
                signal: turnController.signal,
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

                    const result = await executeToolCall(
                        block,
                        state.toolRuntime,
                        turnController.signal,
                    );
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
    } finally {
        receiveController.abort(new Error("Turn finished"));
        await abortFrame;
    }

    state.seq += 1;
    endpoint.send({ type: "turn_finished", seq: state.seq });
    return assistantMessage;
}

async function receiveAbort(
    endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
    turnController: AbortController,
    signal: AbortSignal,
    queuedPrompts: PromptFrame[],
): Promise<void> {
    while (!signal.aborted) {
        try {
            const frame = await endpoint.receive(signal);
            if (frame.type === "abort") {
                turnController.abort(new Error("Turn aborted"));
                return;
            }
            queuedPrompts.push(frame);
        } catch {
            return;
        }
    }
}

import type { AgentFrame, ClientFrame } from "./frames.ts";
import { AsyncQueue } from "./async-queue.ts";

export interface FrameEndpoint<OutgoingFrame, IncomingFrame> {
    send(frame: OutgoingFrame): void;
    receive(signal?: AbortSignal): Promise<IncomingFrame>;
}

export interface InProcessChannel {
    client: FrameEndpoint<ClientFrame, AgentFrame>;
    engine: FrameEndpoint<AgentFrame, ClientFrame>;
}

function createEndpoint<OutgoingFrame, IncomingFrame>(
    outgoing: AsyncQueue<OutgoingFrame>,
    incoming: AsyncQueue<IncomingFrame>,
): FrameEndpoint<OutgoingFrame, IncomingFrame> {
    return {
        send(frame): void {
            outgoing.push(frame);
        },
        receive(signal?: AbortSignal): Promise<IncomingFrame> {
            return incoming.receive(signal);
        },
    };
}

export function createInProcessChannel(): InProcessChannel {
    const clientToEngine = new AsyncQueue<ClientFrame>();
    const engineToClient = new AsyncQueue<AgentFrame>();

    return {
        client: createEndpoint(clientToEngine, engineToClient),
        engine: createEndpoint(engineToClient, clientToEngine),
    };
}

import type { AgentFrame, ClientFrame } from "./frames.ts";

export interface FrameEndpoint<OutgoingFrame, IncomingFrame> {
    send(frame: OutgoingFrame): void;
    receive(): Promise<IncomingFrame>;
}

export interface InProcessChannel {
    client: FrameEndpoint<ClientFrame, AgentFrame>;
    engine: FrameEndpoint<AgentFrame, ClientFrame>;
}

class AsyncQueue<T> {
    private readonly values: T[] = [];
    private readonly receivers: Array<(value: T) => void> = [];

    push(value: T): void {
        const receiver = this.receivers.shift();

        if (receiver !== undefined) {
            receiver(value);
            return;
        }

        this.values.push(value);
    }

    receive(): Promise<T> {
        const value = this.values.shift();

        if (value !== undefined) {
            return Promise.resolve(value);
        }

        return new Promise((resolve) => {
            this.receivers.push(resolve);
        });
    }
}

function createEndpoint<OutgoingFrame, IncomingFrame>(
    outgoing: AsyncQueue<OutgoingFrame>,
    incoming: AsyncQueue<IncomingFrame>,
): FrameEndpoint<OutgoingFrame, IncomingFrame> {
    return {
        send(frame): void {
            outgoing.push(frame);
        },
        receive(): Promise<IncomingFrame> {
            return incoming.receive();
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

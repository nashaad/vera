import type { AgentUpdate, ClientCommand } from "./protocol.ts";
import { AsyncQueue } from "./async-queue.ts";

export interface MessageChannel<OutgoingMessage, IncomingMessage> {
    send(message: OutgoingMessage): void;
    receive(signal?: AbortSignal): Promise<IncomingMessage>;
}

export interface InProcessChannel {
    client: MessageChannel<ClientCommand, AgentUpdate>;
    engine: MessageChannel<AgentUpdate, ClientCommand>;
}

function createEndpoint<OutgoingMessage, IncomingMessage>(
    outgoing: AsyncQueue<OutgoingMessage>,
    incoming: AsyncQueue<IncomingMessage>,
): MessageChannel<OutgoingMessage, IncomingMessage> {
    return {
        send(message): void {
            outgoing.push(message);
        },
        receive(signal?: AbortSignal): Promise<IncomingMessage> {
            return incoming.receive(signal);
        },
    };
}

export function createInProcessChannel(): InProcessChannel {
    const clientToEngine = new AsyncQueue<ClientCommand>();
    const engineToClient = new AsyncQueue<AgentUpdate>();

    return {
        client: createEndpoint(clientToEngine, engineToClient),
        engine: createEndpoint(engineToClient, clientToEngine),
    };
}

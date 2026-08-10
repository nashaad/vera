import type { AttachedAgentClient } from "../../src/host/attached-client.ts";
import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";

export interface TuiAgentClient {
    readonly agentId?: string;
    readonly workspace?: string;
    readonly backgroundAgents?: AttachedAgentClient["backgroundAgents"];
    readonly capabilities?: AttachedAgentClient["capabilities"];
    supportsHostCapability?: AttachedAgentClient["supportsHostCapability"];
    onBackgroundAgents?: AttachedAgentClient["onBackgroundAgents"];
    send(command: ClientCommand): Promise<void>;
    receive(signal?: AbortSignal): Promise<AgentUpdate>;
    listExtensionCommands?: AttachedAgentClient["listExtensionCommands"];
    runExtensionCommand?: AttachedAgentClient["runExtensionCommand"];
    detach(): Promise<void>;
    close(): void;
}

export type IdentifiedTuiAgentClient = TuiAgentClient & {
    readonly agentId: string;
};

export function requireIdentifiedTuiAgentClient(
    client: TuiAgentClient,
): IdentifiedTuiAgentClient {
    if (client.agentId === undefined || client.agentId.length === 0) {
        client.close();
        throw new Error("Attached agent has no identity");
    }
    return client as IdentifiedTuiAgentClient;
}

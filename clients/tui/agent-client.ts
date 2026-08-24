import type { AttachedAgentClient } from "../../src/host/attached-client.ts";
import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";

export interface TuiAgentClient {
    readonly agentId?: string;
    readonly workspace?: string;
    /** True when the session is available for terminal replay only. */
    readonly failed?: boolean;
    readonly backgroundAgents?: AttachedAgentClient["backgroundAgents"];
    readonly capabilities?: AttachedAgentClient["capabilities"];
    supportsHostCapability?: AttachedAgentClient["supportsHostCapability"];
    onBackgroundAgents?: AttachedAgentClient["onBackgroundAgents"];
    readonly workIndex?: AttachedAgentClient["workIndex"];
    onWorkIndex?: AttachedAgentClient["onWorkIndex"];
    send(command: ClientCommand): Promise<void>;
    receive(signal?: AbortSignal): Promise<AgentUpdate>;
    listExtensionCommands?: AttachedAgentClient["listExtensionCommands"];
    runExtensionCommand?: AttachedAgentClient["runExtensionCommand"];
    release?: AttachedAgentClient["release"];
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

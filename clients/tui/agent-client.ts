import type { AttachedAgentClient } from "../../src/host/attached-client.ts";
import {
    dismissRestartRecordThroughHost,
    listRestartRecordsThroughHost,
    type RestartRecordDismissResult,
} from "../../src/host/restart-records-client.ts";
import type { RestartRecordWire } from "../../src/host/protocol.ts";
import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";

export interface TuiAgentClient {
    readonly agentId?: string;
    readonly workspace?: string;
    readonly scratchDirectory?: string;
    readonly failed?: boolean;
    readonly viewOnly?: boolean;
    readonly home?: boolean;
    readonly backgroundAgents?: AttachedAgentClient["backgroundAgents"];
    readonly capabilities?: AttachedAgentClient["capabilities"];
    supportsHostCapability?: AttachedAgentClient["supportsHostCapability"];
    onBackgroundAgents?: AttachedAgentClient["onBackgroundAgents"];
    readonly workIndex?: AttachedAgentClient["workIndex"];
    onWorkIndex?: AttachedAgentClient["onWorkIndex"];
    onSessionTitle?: AttachedAgentClient["onSessionTitle"];
    readonly stopWait?: AttachedAgentClient["stopWait"];
    onStopWait?: AttachedAgentClient["onStopWait"];
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

export interface HostRestartRecords {
    list(): Promise<readonly RestartRecordWire[]>;
    dismiss(sessionId: string): Promise<RestartRecordDismissResult>;
}

// One short connection per request, so a session view can read records without an attached client.
export function hostRestartRecords(
    socketPath: () => Promise<string>,
): HostRestartRecords {
    return {
        list: async () => listRestartRecordsThroughHost(await socketPath()),
        dismiss: async (sessionId) =>
            dismissRestartRecordThroughHost(await socketPath(), sessionId),
    };
}

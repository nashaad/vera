import type { AgentSendEffect, ToolOutput } from "../../tools/types.ts";
import type { ResidentAgent } from "../resident-agent.ts";
import type { RegisteredAgentSummary } from "./support.ts";

export interface PeerCaller {
    readonly id: string;
    readonly workspace: string;
    readonly label: string;
    readonly hop: number;
    readonly readThrough: number;
}

export interface PeerRosterEntry {
    readonly participant_id: string;
    readonly [key: string]: unknown;
}

export interface StoredPeerSessions {
    list(): Promise<Iterable<RegisteredAgentSummary>>;
    withTarget<T>(
        id: string,
        run: (summary: RegisteredAgentSummary | undefined, resume: () => Promise<ResidentAgent>) => Promise<T>,
    ): Promise<T>;
}

export interface PeerSessionServices {
    peerRoster(callerId: string, workspace: string, details: boolean): Promise<readonly PeerRosterEntry[]>;
    peerSend(caller: PeerCaller, effect: AgentSendEffect): Promise<ToolOutput>;
    peerLabel(id: string): Promise<string | undefined>;
}

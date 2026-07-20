import { createConnection, type Socket } from "node:net";

import {
    parseClientCommand,
    type ClientCommand,
} from "../engine/protocol.ts";
import type { RegisteredAgentSummary } from "./agent-registry.ts";

export const HOST_PROTOCOL_VERSION = 1;

export interface HostIdentity {
    readonly pid: number;
    readonly started_at: string;
    readonly protocol_version?: number;
}

export interface HostIdentityRequest {
    readonly type: "host_identity";
}

export interface ListAgentsRequest {
    readonly type: "list_agents";
}

export interface CreateAgentRequest {
    readonly type: "create_agent";
    readonly workspace: string;
}

export interface ResumeAgentRequest {
    readonly type: "resume_agent";
    readonly session_path: string;
}

export interface HostIdentityResponse {
    readonly type: "host_identity";
    readonly pid: number;
    readonly started_at: string;
    readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
}

export interface AttachRequest {
    readonly type: "attach";
    readonly agent_id: string;
}

export interface DetachRequest {
    readonly type: "detach";
}

export interface AttachedResponse {
    readonly type: "attached";
    readonly agent_id: string;
    readonly workspace: string;
}

export interface AttachFailedResponse {
    readonly type: "attach_failed";
    readonly agent_id: string;
    readonly reason: "not_found" | "unavailable";
}

export interface DetachedResponse {
    readonly type: "detached";
}

export interface AgentListResponse {
    readonly type: "agent_list";
    readonly agents: readonly RegisteredAgentSummary[];
}

export interface AgentReadyResponse {
    readonly type: "agent_ready";
    readonly agent_id: string;
    readonly workspace: string;
}

export interface AgentStartFailedResponse {
    readonly type: "agent_start_failed";
    readonly operation: "create" | "resume";
}

export interface ProtocolErrorResponse {
    readonly type: "protocol_error";
    readonly reason: "unsupported_or_invalid_command";
}

export type HostRequest =
    | HostIdentityRequest
    | ListAgentsRequest
    | CreateAgentRequest
    | ResumeAgentRequest
    | AttachRequest;
export type AttachedClientMessage = ClientCommand | DetachRequest;
export type HostResponse =
    | HostIdentityResponse
    | AgentListResponse
    | AgentReadyResponse
    | AgentStartFailedResponse
    | AttachedResponse
    | AttachFailedResponse
    | DetachedResponse
    | ProtocolErrorResponse;

export function parseHostRequest(source: string): HostRequest | undefined {
    const value = parseJsonObject(source);
    if (value?.type === "host_identity") {
        return { type: "host_identity" };
    }
    if (value?.type === "list_agents") {
        return { type: "list_agents" };
    }
    if (
        value?.type === "create_agent"
        && typeof value.workspace === "string"
        && value.workspace.length > 0
    ) {
        return { type: "create_agent", workspace: value.workspace };
    }
    if (
        value?.type === "resume_agent"
        && typeof value.session_path === "string"
        && value.session_path.length > 0
    ) {
        return { type: "resume_agent", session_path: value.session_path };
    }
    if (
        value?.type === "attach"
        && typeof value.agent_id === "string"
        && value.agent_id.length > 0
    ) {
        return { type: "attach", agent_id: value.agent_id };
    }
    return undefined;
}

export function parseAttachedClientMessage(
    source: string,
): AttachedClientMessage | undefined {
    const value = parseJsonObject(source);
    if (value?.type === "detach") {
        return { type: "detach" };
    }
    return parseClientCommand(value);
}

export function encodeHostResponse(response: HostResponse): string {
    return `${JSON.stringify(response)}\n`;
}

export function requestHostIdentity(
    socketPath: string,
): Promise<HostIdentity | undefined> {
    return new Promise((resolve) => {
        let socket: Socket;
        try {
            socket = createConnection(socketPath);
        } catch {
            resolve(undefined);
            return;
        }
        let finished = false;
        let buffered = "";
        const deadline = setTimeout(() => finish(undefined), 250);
        const finish = (identity: HostIdentity | undefined): void => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(deadline);
            socket.destroy();
            resolve(identity);
        };
        socket.setEncoding("utf8");
        socket.once("connect", () => {
            socket.write(`${JSON.stringify({ type: "host_identity" })}\n`);
        });
        socket.on("data", (chunk: string) => {
            buffered += chunk;
            if (buffered.length > 4_096) {
                finish(undefined);
                return;
            }
            const newline = buffered.indexOf("\n");
            if (newline !== -1) {
                finish(parseHostIdentity(buffered.slice(0, newline)));
            }
        });
        socket.once("error", () => finish(undefined));
        socket.once("end", () => finish(undefined));
        socket.once("close", () => finish(undefined));
    });
}

function parseHostIdentity(source: string): HostIdentity | undefined {
    const response = parseJsonObject(source);
    if (
        response?.type !== "host_identity"
        || !Number.isInteger(response.pid)
        || (response.pid as number) <= 0
        || typeof response.started_at !== "string"
        || Number.isNaN(Date.parse(response.started_at))
    ) {
        return undefined;
    }
    return {
        pid: response.pid as number,
        started_at: response.started_at,
        ...(Number.isSafeInteger(response.protocol_version)
            && (response.protocol_version as number) > 0
            ? { protocol_version: response.protocol_version as number }
            : {}),
    };
}

function parseJsonObject(source: string): Record<string, unknown> | undefined {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return undefined;
    }
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

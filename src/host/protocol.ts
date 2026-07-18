import { createConnection, type Socket } from "node:net";

import type { ClientCommand } from "../engine/protocol.ts";
import type { RegisteredAgentSummary } from "./agent-registry.ts";

export interface HostIdentity {
    readonly pid: number;
    readonly started_at: string;
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
    | DetachedResponse;

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
    if (value?.type === "prompt" && typeof value.content === "string") {
        return { type: "prompt", content: value.content };
    }
    if (value?.type === "abort") {
        return { type: "abort" };
    }
    if (
        value?.type === "ui_response"
        && typeof value.requestId === "string"
        && typeof value.response === "object"
        && value.response !== null
    ) {
        const response = value.response as Record<string, unknown>;
        if (
            response.type === "tool_approval"
            && (response.decision === "allow" || response.decision === "deny")
        ) {
            return {
                type: "ui_response",
                requestId: value.requestId,
                response: {
                    type: "tool_approval",
                    decision: response.decision,
                },
            };
        }
    }
    return undefined;
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

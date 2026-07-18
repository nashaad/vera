import { connectHost } from "./connection.ts";

export interface ReadyAgent {
    readonly id: string;
    readonly workspace: string;
}

export class AgentStartError extends Error {
    constructor(readonly operation: "create" | "resume") {
        super(`Resident agent ${operation} failed`);
        this.name = "AgentStartError";
    }
}

export function createAgentThroughHost(
    socketPath: string,
    workspace: string,
): Promise<ReadyAgent> {
    return requestAgentStart(socketPath, {
        type: "create_agent",
        workspace,
    });
}

export function resumeAgentThroughHost(
    socketPath: string,
    sessionPath: string,
): Promise<ReadyAgent> {
    return requestAgentStart(socketPath, {
        type: "resume_agent",
        session_path: sessionPath,
    });
}

interface CreateAgentMessage {
    readonly type: "create_agent";
    readonly workspace: string;
}

interface ResumeAgentMessage {
    readonly type: "resume_agent";
    readonly session_path: string;
}

type StartAgentMessage = CreateAgentMessage | ResumeAgentMessage;

async function requestAgentStart(
    socketPath: string,
    request: StartAgentMessage,
): Promise<ReadyAgent> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send(request);
        const response = asRecord(await connection.receive());
        if (
            response?.type === "agent_start_failed"
            && response.operation === operationOf(request)
        ) {
            throw new AgentStartError(operationOf(request));
        }
        if (
            response?.type !== "agent_ready"
            || typeof response.agent_id !== "string"
            || response.agent_id.length === 0
            || typeof response.workspace !== "string"
            || response.workspace.length === 0
        ) {
            throw new Error("Host returned an invalid agent startup response");
        }
        return {
            id: response.agent_id,
            workspace: response.workspace,
        };
    } finally {
        connection.close();
    }
}

function operationOf(request: StartAgentMessage): "create" | "resume" {
    return request.type === "create_agent" ? "create" : "resume";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

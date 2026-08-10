import { connectHost } from "./connection.ts";
import type { UserMessage } from "../model/types.ts";

export interface ReadyAgent {
    readonly id: string;
    readonly workspace: string;
}

export interface BranchedAgent extends ReadyAgent {
    readonly prompt?: UserMessage;
}

export class AgentStartError extends Error {
    /**
     * `reason` is the host's own words when the failure was written for a user,
     * and it becomes the message, because "Resident agent create failed" tells
     * nobody that a provider needs connecting.
     */
    constructor(
        readonly operation: "create" | "resume",
        readonly reason?: string,
    ) {
        super(reason ?? `Resident agent ${operation} failed`);
        this.name = "AgentStartError";
    }
}

export class AgentBranchError extends Error {
    constructor(
        readonly reason: "unsupported_options" | "source_unavailable" | "failed",
    ) {
        super(reason === "unsupported_options"
            ? "Resident host does not support branch options"
            : reason === "source_unavailable"
                ? "Source agent is unavailable for branching"
                : "Resident agent branch failed");
        this.name = "AgentBranchError";
    }
}

export function createAgentThroughHost(
    socketPath: string,
    workspace: string,
    approvalMode?: string,
    lifetime?: "ephemeral" | "durable",
): Promise<ReadyAgent> {
    return requestAgentStart(socketPath, {
        type: "create_agent",
        workspace,
        ...(approvalMode === undefined
            ? {}
            : { approval_mode: approvalMode }),
        ...(lifetime === undefined ? {} : { lifetime }),
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

export async function branchAgentThroughHost(
    socketPath: string,
    sourceAgentId: string,
    position: "before" | "at",
    entryId?: string,
    options: {
        readonly approvalMode?: string;
        readonly lifetime?: "ephemeral" | "durable";
    } = {},
): Promise<BranchedAgent> {
    const connection = await connectHost({ socketPath });
    const hasOptions = options.approvalMode !== undefined
        || options.lifetime === "ephemeral";
    try {
        await connection.send({
            type: "branch_agent",
            source_agent_id: sourceAgentId,
            position,
            ...(entryId === undefined ? {} : { entry_id: entryId }),
            ...(options.approvalMode === undefined
                ? {}
                : { approval_mode: options.approvalMode }),
            ...(options.lifetime === "ephemeral"
                ? { lifetime: "ephemeral" as const }
                : {}),
        });
        const response = asRecord(await connection.receive());
        if (response?.type === "agent_branch_failed") {
            const reason = response.reason === "unsupported_options"
                    || response.reason === "source_unavailable"
                    || response.reason === "failed"
                ? response.reason
                : "failed";
            throw new AgentBranchError(reason);
        }
        if (
            response?.type !== "agent_branched"
            || typeof response.agent_id !== "string"
            || response.agent_id.length === 0
            || typeof response.workspace !== "string"
            || response.workspace.length === 0
            || !isOptionalUserPrompt(response.prompt)
            || (response.requires_commit !== undefined
                && response.requires_commit !== true)
            || (hasOptions && response.requires_commit !== true)
        ) {
            throw new Error("Host returned an invalid agent branch response");
        }
        if (response.requires_commit === true) {
            await connection.send({
                type: "commit_agent_branch",
                agent_id: response.agent_id,
            });
            const committed = asRecord(await connection.receive());
            if (
                committed?.type !== "agent_branch_committed"
                || committed.agent_id !== response.agent_id
            ) {
                throw new Error("Host did not commit the agent branch");
            }
        }
        return {
            id: response.agent_id,
            workspace: response.workspace,
            ...(response.prompt === undefined
                ? {}
                : { prompt: structuredClone(response.prompt) }),
        };
    } finally {
        connection.close();
    }
}

interface CreateAgentMessage {
    readonly type: "create_agent";
    readonly workspace: string;
    readonly approval_mode?: string;
    readonly lifetime?: "ephemeral" | "durable";
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
            throw new AgentStartError(
                operationOf(request),
                typeof response.reason === "string"
                        && response.reason.length > 0
                    ? response.reason
                    : undefined,
            );
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

function isOptionalUserPrompt(value: unknown): value is UserMessage | undefined {
    if (value === undefined) return true;
    const prompt = asRecord(value);
    return prompt?.role === "user"
        && Array.isArray(prompt.content)
        && prompt.content.every((item) => {
            const content = asRecord(item);
            return (
                content?.type === "text"
                && typeof content.text === "string"
            ) || (
                content?.type === "image_attachment"
                && typeof content.attachmentId === "string"
                && content.attachmentId.length > 0
            );
        });
}

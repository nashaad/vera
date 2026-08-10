import { HOST_CAPABILITIES } from "../../src/host/capabilities.ts";
import {
    AgentBranchCommitError,
    branchAgentThroughHost,
    createAgentThroughHost,
    resumeAgentThroughHost,
} from "../../src/host/agent-start-client.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import type { UserMessage } from "../../src/model/types.ts";
import type {
    IdentifiedTuiAgentClient,
    TuiAgentClient,
} from "./agent-client.ts";

export interface ConfiguredTuiAgentClients {
    attach(agentId: string): Promise<IdentifiedTuiAgentClient>;
    create(
        workspace: string,
        approvalMode?: string,
        lifetime?: "ephemeral" | "durable",
    ): Promise<TuiAgentClient>;
    branch(
        sourceAgentId: string,
        approvalMode?: string,
        lifetime?: "ephemeral" | "durable",
        initialMessages?: readonly UserMessage[],
        signal?: AbortSignal,
    ): Promise<TuiAgentClient>;
    clone(agentId: string): Promise<TuiAgentClient>;
    fork(
        agentId: string,
        boundaryId: string,
    ): Promise<{ readonly client: TuiAgentClient; readonly prompt: UserMessage }>;
    resume(sessionPath: string): Promise<TuiAgentClient>;
}

export function createConfiguredTuiAgentClients(
    socketPath: () => string,
): ConfiguredTuiAgentClients {
    const attach = (agentId: string) => attachAgent({
        socketPath: socketPath(),
        agentId,
        requestedCapabilities: HOST_CAPABILITIES,
    });
    return {
        attach,
        async create(workspace, approvalMode, lifetime = "durable") {
            const ready = await createAgentThroughHost(
                socketPath(),
                workspace,
                approvalMode,
                lifetime,
            );
            return attach(ready.id);
        },
        async branch(
            sourceAgentId,
            approvalMode,
            lifetime = "durable",
            initialMessages = [],
            signal,
        ) {
            try {
                const ready = await branchAgentThroughHost(
                    socketPath(),
                    sourceAgentId,
                    "at",
                    undefined,
                    { approvalMode, lifetime, initialMessages, signal },
                );
                return attach(ready.id);
            } catch (error) {
                if (error instanceof AgentBranchCommitError) {
                    return attach(error.agentId);
                }
                throw error;
            }
        },
        async clone(agentId) {
            const ready = await branchAgentThroughHost(
                socketPath(),
                agentId,
                "at",
            );
            return attach(ready.id);
        },
        async fork(agentId, boundaryId) {
            const ready = await branchAgentThroughHost(
                socketPath(),
                agentId,
                "before",
                boundaryId,
            );
            if (ready.prompt === undefined) {
                throw new Error("Host did not return the fork prompt");
            }
            return { client: await attach(ready.id), prompt: ready.prompt };
        },
        async resume(sessionPath) {
            const ready = await resumeAgentThroughHost(socketPath(), sessionPath);
            return attach(ready.id);
        },
    };
}

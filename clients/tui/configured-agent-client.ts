import { randomUUID } from "node:crypto";

import {
    AgentBranchCommitError,
    branchAgentThroughHost,
    createAgentThroughHost,
    resumeAgentThroughHost,
    syncAgentContextThroughHost,
} from "../../src/host/agent-start-client.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
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
        hideInheritedMessages?: boolean,
        signal?: AbortSignal,
    ): Promise<TuiAgentClient>;
    sync(agentId: string, signal?: AbortSignal): Promise<{
        readonly outcome:
            | "synced"
            | "unchanged"
            | "busy"
            | "stale_cursor"
            | "not_found"
            | "failed";
        readonly turns: number;
    }>;
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
    const clientId = randomUUID();
    const attach = (agentId: string) => attachReconnectingAgent({
        socketPath,
        agentId,
        interactive: true,
        clientId,
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
            hideInheritedMessages = false,
            signal,
        ) {
            try {
                const ready = await branchAgentThroughHost(
                    socketPath(),
                    sourceAgentId,
                    "at",
                    undefined,
                    {
                        approvalMode,
                        lifetime,
                        initialMessages,
                        hideInheritedMessages,
                        signal,
                    },
                );
                return attach(ready.id);
            } catch (error) {
                if (error instanceof AgentBranchCommitError) {
                    return attach(error.agentId);
                }
                throw error;
            }
        },
        sync(agentId, signal) {
            return syncAgentContextThroughHost(socketPath(), agentId, signal);
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

import { randomUUID } from "node:crypto";

import {
    AgentBranchCommitError,
    branchAgentThroughHost,
    createAgentThroughHost,
    resumeAgentThroughHost,
    syncAgentContextThroughHost,
    type ReadyAgentLocation,
} from "../../src/host/agent-start-client.ts";
import {
    createHostLockfile,
    readHostLockRecordFile,
    type HostLockRecord,
} from "../../src/host/lockfile.ts";
import {
    attachReconnectingAgent,
    HostBuildChangedError,
} from "../../src/host/reconnecting-agent-client.ts";
import { CLIENT_CAPABILITIES } from "../../src/host/capabilities.ts";
import type { UserMessage } from "../../src/model/types.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";
import type {
    IdentifiedTuiAgentClient,
    TuiAgentClient,
} from "./agent-client.ts";

export interface ConfiguredTuiAgentClients {
    attach(agentId: string): Promise<IdentifiedTuiAgentClient>;
    /** The primary TUI requests history paging; panes keep `attach`. */
    attachPaged(agentId: string): Promise<IdentifiedTuiAgentClient>;
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
    buildId: string = thisProcessBuildId(),
): ConfiguredTuiAgentClients {
    const clientId = randomUUID();
    const attach = (agentId: string, initialLocation?: ReadyAgentLocation) => attachReconnectingAgent({
        socketPath,
        agentId,
        buildId,
        interactive: true,
        clientId,
        failOnDisconnect: true,
        ...(initialLocation === undefined ? {} : { initialLocation }),
    });
    const attachPaged = (agentId: string, initialLocation?: ReadyAgentLocation) => attachReconnectingAgent({
        socketPath,
        agentId,
        buildId,
        interactive: true,
        clientId,
        failOnDisconnect: true,
        requestedCapabilities: CLIENT_CAPABILITIES,
        ...(initialLocation === undefined ? {} : { initialLocation }),
    });
    const pairedSocket = () => pairedHostSocket(socketPath(), buildId);
    return {
        attach,
        attachPaged,
        async create(workspace, approvalMode, lifetime = "durable") {
            const ready = await createAgentThroughHost(
                await pairedSocket(),
                workspace,
                approvalMode,
                lifetime,
            );
            return attachPaged(ready.id, ready.location);
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
                    await pairedSocket(),
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
                return attachPaged(ready.id, ready.location);
            } catch (error) {
                if (error instanceof AgentBranchCommitError) {
                    return attachPaged(error.agentId);
                }
                throw error;
            }
        },
        async sync(agentId, signal) {
            return syncAgentContextThroughHost(await pairedSocket(), agentId, signal);
        },
        async clone(agentId) {
            const ready = await branchAgentThroughHost(
                await pairedSocket(),
                agentId,
                "at",
            );
            return attachPaged(ready.id, ready.location);
        },
        async fork(agentId, boundaryId) {
            const ready = await branchAgentThroughHost(
                await pairedSocket(),
                agentId,
                "before",
                boundaryId,
            );
            if (ready.prompt === undefined) {
                throw new Error("Host did not return the fork prompt");
            }
            return { client: await attachPaged(ready.id, ready.location), prompt: ready.prompt };
        },
        async resume(sessionPath) {
            const ready = await resumeAgentThroughHost(await pairedSocket(), sessionPath);
            return attachPaged(ready.id, ready.location);
        },
    };
}

// Each request after startup opens its own connection, so it checks the lockfile's build first.
export async function pairedHostSocket(
    socketPath: string,
    clientBuildId: string,
    readRecord: () => Promise<HostLockRecord | undefined> = readHostLockRecordFile,
): Promise<string> {
    const record = await readRecord();
    if (
        record !== undefined
        && record.socket_path === socketPath
        && record.build_id !== undefined
        && record.build_id !== clientBuildId
    ) {
        throw new HostBuildChangedError(clientBuildId, record.build_id);
    }
    return socketPath;
}

// Reconnect host must not reach dispatch on another build: it would start that build's client in this terminal.
export async function refuseOtherHostBuild(
    clientBuildId: string,
    readHostBuild: () => Promise<string | undefined> = readLiveHostBuild,
): Promise<void> {
    const hostBuildId = await readHostBuild();
    if (hostBuildId !== undefined && hostBuildId !== clientBuildId) {
        throw new HostBuildChangedError(clientBuildId, hostBuildId);
    }
}

async function readLiveHostBuild(): Promise<string | undefined> {
    const record = await createHostLockfile().read();
    return record?.build_id;
}

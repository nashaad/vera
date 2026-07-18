import {
    configuredModelFallback,
    type VeraConfig,
} from "../config.ts";
import type { ModelAdapter } from "../model/types.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { startHostServer, type HostServer } from "./server.ts";

export interface StartResidentHostOptions {
    readonly config: VeraConfig;
    readonly createAdapter?: () => ModelAdapter;
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
}

export interface ResidentHost {
    readonly registry: AgentRegistry;
    readonly server: HostServer;
    close(): Promise<void>;
}

export async function startResidentHost(
    options: StartResidentHostOptions,
): Promise<ResidentHost> {
    const modelFallback = configuredModelFallback(options.config);
    const registry = new AgentRegistry({
        createAdapter: options.createAdapter
            ?? (() => createConfiguredModelAdapter(options.config)),
        model: options.config.model,
        approvalMode: options.config.approval_mode,
        ...(options.config.reasoning_effort === undefined
            ? {}
            : { reasoningEffort: options.config.reasoning_effort }),
        ...(modelFallback === undefined ? {} : { modelFallback }),
    });

    let server: HostServer;
    try {
        server = await startHostServer({
            ...(options.socketPath === undefined
                ? {}
                : { socketPath: options.socketPath }),
            ...(options.lockPath === undefined
                ? {}
                : { lockPath: options.lockPath }),
            ...(options.pid === undefined ? {} : { pid: options.pid }),
            ...(options.startedAt === undefined
                ? {}
                : { startedAt: options.startedAt }),
            findAgent: (agentId) => registry.find(agentId),
            listAgents: () => registry.list(),
            createAgent: (workspace) => registry.create({ workspace }),
            resumeAgent: (sessionPath) => registry.resume({ sessionPath }),
        });
    } catch (error) {
        await registry.close();
        throw error;
    }

    let closing: Promise<void> | undefined;
    return {
        registry,
        server,
        close(): Promise<void> {
            closing ??= closeResidentHost(server, registry);
            return closing;
        },
    };
}

async function closeResidentHost(
    server: HostServer,
    registry: AgentRegistry,
): Promise<void> {
    try {
        await server.close();
    } finally {
        await registry.close();
    }
}

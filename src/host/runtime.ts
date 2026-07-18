import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
    configuredModelFallback,
    type VeraConfig,
} from "../config.ts";
import type { ModelAdapter } from "../model/types.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";
import { defaultSessionDirectory } from "../store/session-store.ts";
import { AgentRegistry } from "./agent-registry.ts";
import type { ResidentAgent } from "./resident-agent.ts";
import { startHostServer, type HostServer } from "./server.ts";

export interface StartResidentHostOptions {
    readonly config: VeraConfig;
    readonly createAdapter?: () => ModelAdapter;
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    readonly sessionDirectory?: string;
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
        await restoreStoredAgents(
            registry,
            options.sessionDirectory ?? defaultSessionDirectory(),
        );
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
            resumeAgent: (sessionPath) => resumeOrFind(registry, sessionPath),
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

async function restoreStoredAgents(
    registry: AgentRegistry,
    sessionDirectory: string,
): Promise<void> {
    let names: string[];
    try {
        names = await readdir(sessionDirectory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }
        throw error;
    }

    for (const name of names.filter((value) => value.endsWith(".jsonl")).sort()) {
        await registry.resume({ sessionPath: join(sessionDirectory, name) });
    }
}

async function resumeOrFind(
    registry: AgentRegistry,
    sessionPath: string,
): Promise<ResidentAgent> {
    const canonicalPath = await realpath(sessionPath);
    const existing = registry.list().find(
        (agent) => agent.session_path === canonicalPath,
    );
    if (existing !== undefined) {
        const agent = registry.find(existing.id);
        if (agent !== undefined) {
            return agent;
        }
    }
    return registry.resume({ sessionPath: canonicalPath });
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

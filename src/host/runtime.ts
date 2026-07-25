import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
    configuredModelFallback,
    configuredReviewer,
    configuredReviewers,
    updateVeraConfigDefaults,
    type VeraConfig,
} from "../config.ts";
import type { ModelAdapter } from "../model/types.ts";
import { availableModels } from "../engine/model-settings.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";
import { defaultSessionDirectory } from "../store/session-store.ts";
import { AgentRegistry } from "./agent-registry.ts";
import type { ResidentAgent } from "./resident-agent.ts";
import { startHostServer, type HostServer } from "./server.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistry,
    type ExtensionRegistryFailure,
} from "../extensions/registry.ts";

export interface StartResidentHostOptions {
    readonly config: VeraConfig;
    readonly createAdapter?: () => ModelAdapter;
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    readonly sessionDirectory?: string;
    readonly eventLogDirectory?: string;
    readonly onRestoreFailure?: (failure: SessionRestoreFailure) => void;
    readonly onExtensionDiagnostic?: (
        extensionId: string,
        message: string,
    ) => void;
    readonly onExtensionFailure?: (
        failure: ExtensionRegistryFailure,
    ) => void;
}

export interface SessionRestoreFailure {
    readonly sessionPath: string;
    readonly error: unknown;
}

export interface ResidentHost {
    readonly registry: AgentRegistry;
    readonly extensions: ExtensionRegistry;
    readonly server: HostServer;
    close(): Promise<void>;
}

export async function startResidentHost(
    options: StartResidentHostOptions,
): Promise<ResidentHost> {
    const modelFallback = configuredModelFallback(options.config);
    const reviewer = configuredReviewer(options.config);
    const reviewers = configuredReviewers(options.config);
    const sessionDirectory = options.sessionDirectory
        ?? defaultSessionDirectory();
    const eventLogDirectory = options.eventLogDirectory;
    const models = options.createAdapter === undefined
        ? await discoverAvailableModels(options.config)
        : configuredCatalog(options.config);
    const registry = new AgentRegistry({
        createAdapter: options.createAdapter
            ?? ((provider) => createConfiguredModelAdapter({
                ...options.config,
                provider: (provider ?? options.config.provider) as VeraConfig["provider"],
            })),
        provider: options.config.provider,
        model: options.config.model,
        approvalMode: options.config.approval_mode,
        availableModels: models,
        updateModelDefaults: (settings) => {
            updateVeraConfigDefaults({
                provider: settings.provider as VeraConfig["provider"],
                model: settings.model,
                ...(settings.reasoningEffort === undefined
                    ? {}
                    : { reasoning_effort: settings.reasoningEffort }),
            });
        },
        updateApprovalDefault: (mode) => {
            updateVeraConfigDefaults({ approval_mode: mode });
        },
        ...(options.config.reasoning_effort === undefined
            ? {}
            : { reasoningEffort: options.config.reasoning_effort }),
        ...(modelFallback === undefined ? {} : { modelFallback }),
        ...(reviewer === undefined ? {} : { reviewer }),
        ...(Object.keys(reviewers).length === 0 ? {} : { reviewers }),
        ...(options.config.permission_modes === undefined
            ? {}
            : { permissionModes: options.config.permission_modes }),
        sessionPathForId: (agentId) =>
            join(sessionDirectory, `${agentId}.jsonl`),
        ...(eventLogDirectory === undefined
            ? {}
            : {
                eventLogPathForId: (agentId: string) =>
                    join(eventLogDirectory, `${agentId}.jsonl`),
            }),
    });

    let server: HostServer;
    let extensions: ExtensionRegistry | undefined;
    try {
        await restoreStoredAgents(
            registry,
            sessionDirectory,
            options.onRestoreFailure ?? reportRestoreFailure,
        );
        extensions = await startExtensionRegistry({
            extensions: options.config.extensions ?? [],
            ...(options.onExtensionDiagnostic === undefined
                ? {}
                : { onDiagnostic: options.onExtensionDiagnostic }),
            ...(options.onExtensionFailure === undefined
                ? {}
                : { onFailure: options.onExtensionFailure }),
        });
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
            branchAgent: (options) => registry.branch(options),
            trashSession: (targetId) => registry.trashSession(targetId),
            listExtensionCommands: () => extensions!.commands(),
            runExtensionCommand: (
                name,
                argumentsText,
                workspace,
                signal,
            ) => extensions!.invokeCommand(
                name,
                argumentsText,
                workspace,
                signal,
            ),
            canShutdown: () => registry.idleForShutdown(),
            onShutdownAccepted: () =>
                closeResidentHost(server, registry, extensions!),
        });
    } catch (error) {
        try {
            await extensions?.close();
        } catch {
            // Preserve the host startup failure.
        }
        await registry.close();
        throw error;
    }

    let closing: Promise<void> | undefined;
    return {
        registry,
        extensions,
        server,
        close(): Promise<void> {
            closing ??= closeResidentHost(server, registry, extensions);
            return closing;
        },
    };
}

async function discoverAvailableModels(
    config: VeraConfig,
): Promise<readonly SuggestedModel[]> {
    const catalog = catalogModels(config);
    try {
        const configuredHost = process.env.OLLAMA_HOST
            ?? "http://127.0.0.1:11434";
        const host = (/^https?:\/\//.test(configuredHost)
            ? configuredHost
            : `http://${configuredHost}`).replace(/\/+$/, "");
        const response = await fetch(`${host}/v1/models`, {
            signal: AbortSignal.timeout(750),
        });
        if (response.ok) {
            const body = await response.json() as {
                data?: readonly { id?: unknown }[];
            };
            for (const item of body.data ?? []) {
                if (typeof item.id !== "string" || item.id.length === 0) {
                    continue;
                }
                catalog.push({
                    provider: "ollama",
                    model: item.id,
                    label: item.id,
                    description: "installed locally",
                });
            }
        }
        if (config.provider === "ollama") {
            const contextWindow = await discoverOllamaContextWindow(
                host,
                config.model,
            );
            const configured = catalog.find((item) =>
                item.provider === "ollama" && item.model === config.model
            );
            if (configured !== undefined && contextWindow !== undefined) {
                const index = catalog.indexOf(configured);
                catalog[index] = { ...configured, contextWindow };
            }
        }
    } catch {
        // Ollama is optional; an offline local server must not block Vera startup.
    }
    if (!catalog.some((item) =>
        item.provider === config.provider && item.model === config.model
    )) {
        catalog.unshift({
            provider: config.provider,
            model: config.model,
            label: config.model,
            description: "configured model",
        });
    }
    return catalog;
}

async function discoverOllamaContextWindow(
    host: string,
    model: string,
): Promise<number | undefined> {
    const response = await fetch(`${host}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return undefined;
    return ollamaContextWindow(await response.json());
}

export function ollamaContextWindow(value: unknown): number | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const body = value as { model_info?: unknown };
    if (
        typeof body.model_info !== "object"
        || body.model_info === null
        || Array.isArray(body.model_info)
    ) {
        return undefined;
    }
    const lengths = Object.entries(body.model_info)
        .filter(([key]) => key.endsWith(".context_length"))
        .map(([, value]) => value)
        .filter((value): value is number =>
            Number.isSafeInteger(value) && (value as number) > 0
        );
    return lengths[0];
}

function configuredCatalog(config: VeraConfig): readonly SuggestedModel[] {
    const catalog = catalogModels(config);
    return catalog.some((item) =>
        item.provider === config.provider && item.model === config.model
    )
        ? catalog
        : [{
            provider: config.provider,
            model: config.model,
            label: config.model,
            description: "configured model",
        }, ...catalog];
}

function catalogModels(config: VeraConfig): SuggestedModel[] {
    return [...availableModels()].filter((model) =>
        model.provider !== "openrouter"
        || config.provider === "openrouter"
        || Boolean(process.env.OPENROUTER_API_KEY)
    );
}

async function restoreStoredAgents(
    registry: AgentRegistry,
    sessionDirectory: string,
    onFailure: (failure: SessionRestoreFailure) => void,
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
        const sessionPath = join(sessionDirectory, name);
        try {
            await registry.resume({ sessionPath });
        } catch (error) {
            try {
                onFailure({ sessionPath, error });
            } catch {
                // Diagnostics must not let one bad session block healthy restores.
            }
        }
    }
}

function reportRestoreFailure(failure: SessionRestoreFailure): void {
    const detail = failure.error instanceof Error
        ? failure.error.message
        : String(failure.error);
    console.error(`Vera skipped corrupt session ${failure.sessionPath}: ${detail}`);
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
    extensions: ExtensionRegistry,
): Promise<void> {
    try {
        await server.close();
    } finally {
        try {
            await extensions.close();
        } finally {
            await registry.close();
        }
    }
}

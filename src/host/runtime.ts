import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
    configuredModelFallback,
    configuredReviewer,
    configuredCompaction,
    configuredReviewers,
    updateVeraConfigDefaults,
    type VeraConfig,
} from "../config.ts";
import type { ModelAdapter } from "../model/types.ts";
import { availableModels } from "../engine/model-settings.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import { pinnedModels } from "../model/catalog-view.ts";
import { addPin, removePin } from "../model/pin-store.ts";
import {
    refreshCodexCatalog,
    type CodexCatalogRefreshOptions,
} from "../model/codex-catalog.ts";
import {
    refreshOpenRouterCatalog,
    type OpenRouterCatalogRefreshOptions,
} from "../model/openrouter-catalog.ts";
import {
    createAuthStorage,
    credentialFingerprint,
    type AuthStorage,
} from "../providers/auth-storage.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";
import { PermissionPreferenceStore } from "../engine/permission-preferences.ts";
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
    /** Overrides `~/.vera/preferences.json`, so tests do not read the
     * developer's real preferences. */
    readonly permissionPreferencesPath?: string;
    /** Overrides `~/.vera/auth.json`, so tests never read real credentials. */
    readonly authStorage?: AuthStorage;
    readonly eventLogDirectory?: string;
    readonly onRestoreFailure?: (failure: SessionRestoreFailure) => void;
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
    const compaction = configuredCompaction(options.config);
    const sessionDirectory = options.sessionDirectory
        ?? defaultSessionDirectory();
    const eventLogDirectory = options.eventLogDirectory;
    const models = options.createAdapter === undefined
        ? await discoverAvailableModels(options.config)
        : configuredCatalog(options.config);
    // Opened once per host, not per agent: the file is per-user. A malformed
    // or missing file reads as no preferences rather than failing startup, so
    // this cannot block the host from coming up.
    const permissionPreferences = await PermissionPreferenceStore.open(
        options.permissionPreferencesPath,
    );
    // One store for the host, so a sign-in from anywhere is the same fact to
    // every agent it is running.
    const authStorage = options.authStorage ?? createAuthStorage();
    const registry = new AgentRegistry({
        credentialFingerprint: (provider) =>
            credentialFingerprint(authStorage, provider),
        createAdapter: options.createAdapter
            ?? ((provider) => createConfiguredModelAdapter({
                ...options.config,
                provider: (provider ?? options.config.provider) as VeraConfig["provider"],
            }, { authStorage })),
        provider: options.config.provider,
        model: options.config.model,
        approvalMode: options.config.approval_mode,
        availableModels: models,
        readPins: () => pinnedModels(models),
        updatePin: (action, entry) => {
            if (action === "add") {
                addPin(entry);
            } else {
                removePin(entry);
            }
        },
        updateModelDefaults: (settings) => {
            updateVeraConfigDefaults({
                provider: settings.provider as VeraConfig["provider"],
                model: settings.model,
                // Explicitly null rather than omitted: settings that carry no
                // effort mean the accepted model has none, so a stored default
                // from an earlier model must not survive into the next session.
                reasoning_effort: settings.reasoningEffort ?? null,
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
        ...(compaction === undefined ? {} : { compaction }),
        ...(options.config.permission_modes === undefined
            ? {}
            : { permissionModes: options.config.permission_modes }),
        permissionPreferences,
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
            renameSession: (targetId, name) =>
                registry.renameSession(targetId, name),
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
    const openrouter = await discoveredOpenRouterModels(config);
    if (openrouter.length > 0) {
        // The fetched list supersedes the shipped entries, which name the same
        // models with staler facts. Nothing is dropped when the fetch comes back
        // empty: no credential, no network and no snapshot leaves the shipped
        // handful in place rather than an empty picker.
        for (let index = catalog.length - 1; index >= 0; index -= 1) {
            if (catalog[index]!.provider === "openrouter") {
                catalog.splice(index, 1);
            }
        }
        catalog.push(...openrouter);
    }
    catalog.push(...discoveredCodexModels(config));
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

/**
 * Codex models, republished from the Codex CLI's own cache. Gated on a stored
 * credential for the same reason the OpenRouter entries are gated on a key:
 * the catalog can describe a model the user has no way to run, and offering it
 * in the picker is offering a dead end. The configured provider passes the
 * gate regardless, so a misconfigured credential shows up as a failed turn
 * rather than as a model that vanished.
 */
export interface CodexDiscoveryOptions extends CodexCatalogRefreshOptions {
    /** Overrides `~/.vera/auth.json`, so tests never read real credentials. */
    readonly authStorage?: AuthStorage;
}

export function discoveredCodexModels(
    config: VeraConfig,
    options: CodexDiscoveryOptions = {},
): readonly SuggestedModel[] {
    if (
        config.provider !== "openai-codex"
        && !hasCodexCredential(options.authStorage)
    ) {
        return [];
    }

    const catalog = refreshCodexCatalog(options);
    return catalog?.models.map((model) => ({
        provider: "openai-codex",
        model: model.id,
        label: model.label,
        description: model.description ?? "",
        ...(model.context_window === undefined
            ? {}
            : { contextWindow: model.context_window }),
    })) ?? [];
}

function hasCodexCredential(authStorage?: AuthStorage): boolean {
    try {
        return (authStorage ?? createAuthStorage())
            .getCredential("openai-codex") !== undefined;
    } catch {
        return false;
    }
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
        || hasOpenRouterCredential(config)
    );
}

function hasOpenRouterCredential(config: VeraConfig): boolean {
    return config.provider === "openrouter"
        || Boolean(process.env.OPENROUTER_API_KEY);
}

/**
 * OpenRouter's own catalog, which is what "every model I could run" actually
 * means for that provider. It replaces the handful of entries Vera ships rather
 * than joining them: they name the same models, and the fetched list is the one
 * that stays current.
 *
 * Gated on a credential for the same reason the Codex list is: describing a
 * model the user cannot run is offering a dead end.
 */
export interface OpenRouterDiscoveryOptions
    extends OpenRouterCatalogRefreshOptions {}

export async function discoveredOpenRouterModels(
    config: VeraConfig,
    options: OpenRouterDiscoveryOptions = {},
): Promise<readonly SuggestedModel[]> {
    if (!hasOpenRouterCredential(config)) {
        return [];
    }
    const catalog = await refreshOpenRouterCatalog(options);
    return catalog?.models.map((model) => ({
        provider: "openrouter",
        model: model.id,
        label: model.label,
        description: model.description ?? "",
        ...(model.context_window === undefined
            ? {}
            : { contextWindow: model.context_window }),
    })) ?? [];
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

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
import { openInboxIfEnabled } from "../store/inbox.ts";
import { createConsumerRegistry } from "./consumers.ts";
import { InboxDeliveryCoordinator } from "./inbox-delivery.ts";
import {
    startWatchRuntimeIfEnabled,
    type WatchRuntime,
} from "../watch/runtime.ts";
import type { WatchSecretResolver } from "../watch/arc-connector.ts";
import type { WatchConnector } from "../watch/source.ts";
import {
    InboxSpawnController,
    SpawnConsentStore,
    type SpawnSessionFn,
} from "./inbox-spawn.ts";
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
    /** Overrides `~/.vera/inbox.db`. Unused while the inbox flag is off. */
    readonly inboxPath?: string;
    /** Replaces the built-in connector set, so tests never reach a real arc. */
    readonly watchConnectors?: readonly WatchConnector[];
    /** Supplies a watch its bearer token. Definitions never carry one. */
    readonly watchSecret?: WatchSecretResolver;
    /** Overrides `~/.vera/spawn-consent.json`, so tests never read the real one. */
    readonly spawnConsentPath?: string;
    /**
     * Starts a session for an inbox entry addressed to a consumer with no live
     * session. Absent means the host has no way to pick a target and spawning
     * stays off whatever the two gates say.
     */
    readonly spawnSession?: SpawnSessionFn;
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
    // The experimental gate is checked here and nowhere downstream: with the
    // flag off there is no inbox, no consumer registry and no delivery path.
    const inbox = options.inboxPath === undefined
        ? openInboxIfEnabled(options.config)
        : openInboxIfEnabled(options.config, options.inboxPath);
    const consumers = createConsumerRegistry(inbox);
    const inboxDelivery = consumers === null
        ? undefined
        : new InboxDeliveryCoordinator(consumers);
    // Watches are started after the extension registry, because their
    // definitions are extension contributions. The runtime holds the reference
    // so shutdown stops the connector tasks before the log they write to closes.
    let watches: WatchRuntime | null = null;
    let spawn: InboxSpawnController | undefined;
    const closeInbox = async (): Promise<void> => {
        await watches?.close();
        spawn?.release();
        inboxDelivery?.close();
        inbox?.close();
    };
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
        ...(options.config.permission_modes === undefined
            ? {}
            : { permissionModes: options.config.permission_modes }),
        permissionPreferences,
        ...(inboxDelivery === undefined ? {} : { inboxDelivery }),
        sessionPathForId: (agentId) =>
            join(sessionDirectory, `${agentId}.jsonl`),
        ...(eventLogDirectory === undefined
            ? {}
            : {
                eventLogPathForId: (agentId: string) =>
                    join(eventLogDirectory, `${agentId}.jsonl`),
            }),
    });

    // Second gate. It is read here rather than from `options.config` because
    // no config key can turn spawning on; only an explicit confirmation does.
    if (
        inbox !== null
        && consumers !== null
        && options.spawnSession !== undefined
    ) {
        const spawnSession = options.spawnSession;
        spawn = new InboxSpawnController({
            inbox,
            consumers,
            spawnSession,
            consent: SpawnConsentStore.open(options.spawnConsentPath),
            inheritedApprovalMode: (address) =>
                registry.approvalModeOf(address),
            causedByKnownSession: (entry) =>
                entry.session !== null
                && registry.find(entry.session) !== undefined,
        });
        inboxDelivery?.setSpawnScan(() => spawn!.scan());
    }

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
        watches = startWatchRuntimeIfEnabled(inbox, {
            watches: extensions.contributions().watches(),
            ...(options.watchConnectors === undefined
                ? {}
                : { connectors: options.watchConnectors }),
            ...(options.watchSecret === undefined
                ? {}
                : { secret: options.watchSecret }),
            onAppended: () => {
                void inboxDelivery?.pumpAll();
            },
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
                closeResidentHost(server, registry, extensions!, closeInbox),
        });
    } catch (error) {
        try {
            await extensions?.close();
        } catch {
            // Preserve the host startup failure.
        }
        await registry.close();
        closeInbox();
        throw error;
    }

    let closing: Promise<void> | undefined;
    return {
        registry,
        extensions,
        server,
        close(): Promise<void> {
            closing ??= closeResidentHost(
                server,
                registry,
                extensions,
                closeInbox,
            );
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
    closeInbox: () => void | Promise<void> = () => {},
): Promise<void> {
    try {
        await server.close();
    } finally {
        try {
            await extensions.close();
        } finally {
            try {
                await registry.close();
            } finally {
                await closeInbox();
            }
        }
    }
}

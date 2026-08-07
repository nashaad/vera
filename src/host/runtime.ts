import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
    configuredModelFallback,
    configuredReviewer,
    configuredSubagentModel,
    configuredCompaction,
    configuredReviewers,
    eventLogEnabled,
    updateVeraConfigDefaults,
    type VeraConfig,
} from "../config.ts";
import type { ModelAdapter } from "../model/types.ts";
import { availableModels } from "../engine/model-settings.ts";
import { defaultEventLogPath } from "../engine/events.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import { pooledModels } from "../model/catalog-view.ts";
import type {
    CatalogModel,
    ReasoningLevel,
} from "../model/catalog-shape.ts";
import { writeProviderCatalogSnapshot } from "../model/catalog-cache.ts";
import { createHostLogger, type HostLog } from "./host-log.ts";

const hostLog = createHostLogger();
import {
    addPoolModel,
    recordLearned,
    namePoolModel,
    removePoolModel,
    PoolFileWriteRefusedError,
} from "../model/pool-file-store.ts";
import { loadPoolFile } from "../model/pool-file-loader.ts";
import { poolNameRefusal } from "../model/pool-names.ts";
import { admitToPool } from "../model/pool-admission.ts";
import { migrateConfigPool } from "../model/pool-migration.ts";
import { createPoolEffortPool } from "../model/effort-pool.ts";
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
import type { FailedRequestCapture } from "../providers/failed-request-capture.ts";
import { PermissionPreferenceStore } from "../engine/permission-preferences.ts";
import { defaultSessionDirectory } from "../store/session-store.ts";
import { ToolHooks } from "../engine/hooks.ts";
import { inboxEnabled, openInboxIfEnabled } from "../store/inbox.ts";
import { createConsumerRegistry } from "./consumers.ts";
import { InboxDeliveryCoordinator } from "./inbox-delivery.ts";
import { readArcNodeId } from "./arc-identity.ts";
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
import { subagentPoolPolicy } from "./subagent-policy.ts";
import { createReminderHook } from "./reminder-rules.ts";
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
    /** Absolute path of the entrypoint this host was started from. */
    readonly entrypoint?: string;
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
    /** Overrides arc's per-user config path, so tests never read the real one. */
    readonly arcConfigPath?: string;
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
    // Before anything reads or writes the pool file: the old keys are only
    // findable while pool.json is still absent.
    const migration = migrateConfigPool();
    if (migration.notice !== undefined) {
        hostLog({ type: "pool_migrated", message: migration.notice });
    }
    const modelFallback = configuredModelFallback(options.config);
    const reviewer = configuredReviewer(options.config);
    const subagentModel = configuredSubagentModel(options.config);
    const reviewers = configuredReviewers(options.config);
    const compaction = configuredCompaction(options.config);
    const sessionDirectory = options.sessionDirectory
        ?? defaultSessionDirectory();
    const eventLogDirectory = options.eventLogDirectory;
    // One store for the host, so a sign-in from anywhere is the same fact to
    // every agent it is running.
    const authStorage = options.authStorage ?? createAuthStorage();
    const models = options.createAdapter === undefined
        ? await discoverAvailableModels(options.config, authStorage)
        : configuredCatalog(options.config);
    // Opened once per host, not per agent: the file is per-user. A malformed
    // or missing file reads as no preferences rather than failing startup, so
    // this cannot block the host from coming up.
    const permissionPreferences = await PermissionPreferenceStore.open(
        options.permissionPreferencesPath,
    );
    const extensions = await startExtensionRegistry({
        extensions: options.config.extensions ?? [],
        ...(options.onExtensionFailure === undefined
            ? {}
            : { onFailure: options.onExtensionFailure }),
    });
    const createAdapter = options.createAdapter
        ?? ((
            provider?: string,
            projectRoot?: string,
            captureFailedRequest?: FailedRequestCapture,
        ) =>
            createConfiguredModelAdapter({
                ...options.config,
                provider: (provider ?? options.config.provider) as
                    VeraConfig["provider"],
            }, {
                authStorage,
                log: hostLog,
                ...scoped(projectRoot),
                ...(captureFailedRequest === undefined
                    ? {}
                    : { captureFailedRequest }),
            }));
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
        createAdapter,
        provider: options.config.provider,
        model: options.config.model,
        approvalMode: options.config.approval_mode,
        availableModels: models,
        readPool: (projectRoot) => pooledModels(models, scoped(projectRoot)),
        // Built here because the pool lives in a file the host owns; the
        // engine receives only the interface. One per agent, because the
        // project overlay follows that agent's workspace.
        createEffortPool: (projectRoot) =>
            createPoolEffortPool({
                ...scoped(projectRoot),
                onWriteRefused: (error) =>
                    hostLog({ type: "pool_write_refused", message: error.message }),
            }),
        readPolicy: (projectRoot) => subagentPoolPolicy(scoped(projectRoot)),
        admitToPool: (entry, onStep, options) =>
            admitToPool(entry, onStep, {
                ...options,
                createAdapter,
                onWriteRefused: (error) =>
                    hostLog({ type: "pool_write_refused", message: error.message }),
            }),
        removeFromPool: (entry) => {
            refusedPoolWrite(() => {
                removePoolModel(`${entry.provider}/${entry.model}`);
            });
        },
        namePoolEntry: (entry, name, projectRoot) => {
            const id = `${entry.provider}/${entry.model}`;
            const merged = loadPoolFile({ projectRoot }).merged;
            if (
                name !== null
                && poolNameRefusal(merged, id, name) !== undefined
            ) {
                return false;
            }
            let named = false;
            const refused = refusedPoolWrite(() => {
                // Names land in the user file like every other write, so an
                // entry only the project overlay declares cannot take one.
                const file = namePoolModel(id, name ?? undefined);
                named = file.models[id] !== undefined
                    && file.models[id]?.name === (name ?? undefined);
            });
            return refused === undefined && named;
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
        ...(subagentModel === undefined ? {} : { subagentModel }),
        ...(Object.keys(reviewers).length === 0 ? {} : { reviewers }),
        ...(compaction === undefined ? {} : { compaction }),
        ...(options.config.permission_modes === undefined
            ? {}
            : { permissionModes: options.config.permission_modes }),
        permissionPreferences,
        extensionTools: extensions.tools(),
        createToolHooks: () => {
            const hooks = new ToolHooks();
            hooks.registerPostToolUse(createReminderHook());
            return hooks;
        },
        ...(options.config.disabled_prompt_contributions === undefined
            ? {}
            : {
                disabledPromptContributions:
                    options.config.disabled_prompt_contributions,
            }),
        ...(inboxDelivery === undefined ? {} : {
            inboxDelivery,
            // Read per attach, not once at startup, because `arc init` can
            // mint the node id while the host runs. arc stamps events with
            // (node id, ARC_SESSION); the attach pairs this actor with the
            // agent id, so a session posting under ARC_SESSION set to its
            // agent id is not woken by its own posts.
            inboxActorForSession: () => readArcNodeId(options.arcConfigPath),
        }),
        sessionPathForId: (agentId) =>
            join(sessionDirectory, `${agentId}.jsonl`),
        ...(eventLogEnabled(options.config)
            ? {
                eventLogPathForId: (agentId: string) =>
                    eventLogDirectory === undefined
                        ? defaultEventLogPath(agentId)
                        : join(eventLogDirectory, `${agentId}.jsonl`),
            }
            : {}),
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
            subsystemEnabled: inboxEnabled(options.config),
            causedByKnownSession: (entry) =>
                entry.session !== null
                && registry.find(entry.session) !== undefined,
        });
        inboxDelivery?.setSpawnScan(() => spawn!.scan());
    }

    let server: HostServer;
    try {
        await restoreStoredAgents(
            registry,
            sessionDirectory,
            options.onRestoreFailure ?? reportRestoreFailure,
        );
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
            ...(options.entrypoint === undefined
                ? {}
                : { entrypoint: options.entrypoint }),
            findAgent: (agentId) => registry.find(agentId),
            listAgents: () => registry.list(),
            onRosterChanged: (listener) => registry.onRosterChanged(listener),
            createAgent: (workspace) => registry.create({ workspace }),
            resumeAgent: (sessionPath) => resumeOrFind(registry, sessionPath),
            branchAgent: (options) => registry.branch(options),
            trashSession: (targetId) => registry.trashSession(targetId),
            renameSession: (targetId, name) =>
                registry.renameSession(targetId, name),
            runOnce: (runOptions) => registry.runOnce(runOptions),
            listExtensionCommands: () => extensions.commands(),
            runExtensionCommand: (
                name,
                argumentsText,
                workspace,
                signal,
            ) => extensions.invokeCommand(
                name,
                argumentsText,
                workspace,
                signal,
            ),
            canShutdown: () => registry.idleForShutdown(),
            onShutdownAccepted: () =>
                closeResidentHost(server, registry, extensions, closeInbox),
        });
    } catch (error) {
        try {
            await extensions.close();
        } catch {
            // Preserve the host startup failure.
        }
        await registry.close();
        await closeInbox();
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

/**
 * The pool overlay a workspace contributes. Absent workspace means user scope
 * only, which is what an embedded host with no checkout gets.
 */
function scoped(projectRoot?: string): { readonly projectRoot?: string } {
    return projectRoot === undefined ? {} : { projectRoot };
}

/**
 * Turns a refused pool write into a verdict the client can show. The file is
 * left exactly as the user wrote it, so the only thing to report is that the
 * change did not land and why. Its own verdict rather than `unavailable`: the
 * provider was never asked, and telling the user it was sends them to fix the
 * wrong thing.
 */
function refusedPoolWrite(
    write: () => void,
): {
    readonly verdict: "pool_write_refused";
    readonly reason: string;
} | undefined {
    try {
        write();
        return undefined;
    } catch (error) {
        if (!(error instanceof PoolFileWriteRefusedError)) {
            throw error;
        }
        hostLog({ type: "pool_write_refused", message: error.message });
        return { verdict: "pool_write_refused", reason: error.message };
    }
}

async function discoverAvailableModels(
    config: VeraConfig,
    authStorage: AuthStorage,
): Promise<readonly SuggestedModel[]> {
    const catalog = catalogModels(config);
    catalog.push(...await discoveredOllamaModels({ log: hostLog }));
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
    catalog.push(...await discoveredCerebrasModels(config, { authStorage }));
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

export interface CerebrasDiscoveryOptions {
    readonly authStorage?: Pick<AuthStorage, "getCredential">;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
}

export async function discoveredCerebrasModels(
    config: VeraConfig,
    options: CerebrasDiscoveryOptions = {},
): Promise<readonly SuggestedModel[]> {
    if (
        config.provider !== "cerebras"
        && !hasProviderCredential("cerebras", options.authStorage)
        && !process.env.CEREBRAS_API_KEY
    ) {
        return [];
    }
    try {
        const fetchImplementation = options.fetch ?? globalThis.fetch;
        const response = await fetchImplementation(
            "https://api.cerebras.ai/public/v1/models",
            { signal: AbortSignal.timeout(2_000) },
        );
        if (!response.ok) return [];
        return cerebrasModels(await response.json());
    } catch {
        // Discovery enriches the picker; it must never block host startup.
        return [];
    }
}

export function cerebrasModels(value: unknown): readonly SuggestedModel[] {
    const body = typeof value === "object" && value !== null
        ? value as { data?: unknown }
        : undefined;
    if (!Array.isArray(body?.data)) return [];
    return body.data.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const model = entry as {
            id?: unknown;
            name?: unknown;
            description?: unknown;
            limits?: { max_context_length?: unknown };
        };
        if (typeof model.id !== "string" || model.id.length === 0) return [];
        const contextWindow = model.limits?.max_context_length;
        return [{
            provider: "cerebras",
            model: model.id,
            label: typeof model.name === "string" ? model.name : model.id,
            description: typeof model.description === "string"
                ? model.description
                : "",
            ...(typeof contextWindow === "number"
                    && Number.isSafeInteger(contextWindow)
                    && contextWindow > 0
                ? { contextWindow }
                : {}),
        }];
    });
}

function hasProviderCredential(
    provider: string,
    authStorage?: Pick<AuthStorage, "getCredential">,
): boolean {
    try {
        return authStorage?.getCredential(provider) !== undefined;
    } catch {
        return false;
    }
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

export interface OllamaDiscoveryOptions {
    readonly host?: string;
    readonly cacheDir?: string;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly log?: HostLog;
}

const OLLAMA_REASONING_LEVELS: readonly ReasoningLevel[] = [
    { id: "high", label: "High" },
    { id: "medium", label: "Medium" },
    { id: "low", label: "Low" },
];

/**
 * `/v1/models` names the installed models and nothing else, so what each one
 * can actually be asked for comes from a per-model `/api/show`. Every call is
 * to a local daemon and every failure is survivable: an Ollama that is not
 * running must not delay startup or empty the picker.
 *
 * A model whose response carries no `capabilities` is left out of the snapshot
 * rather than written with no levels. Empty levels is the claim "this model has
 * no reasoning control"; an old daemon that never makes the claim should keep
 * falling through to the optimistic default instead.
 */
export async function discoveredOllamaModels(
    options: OllamaDiscoveryOptions = {},
): Promise<readonly SuggestedModel[]> {
    const configuredHost = options.host ?? process.env.OLLAMA_HOST
        ?? "http://127.0.0.1:11434";
    const host = (/^https?:\/\//.test(configuredHost)
        ? configuredHost
        : `http://${configuredHost}`).replace(/\/+$/, "");
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const log = options.log ?? (() => {});

    let ids: readonly string[];
    try {
        const response = await fetchImplementation(`${host}/v1/models`, {
            signal: AbortSignal.timeout(750),
        });
        if (!response.ok) {
            log({
                type: "ollama_discovery_unavailable",
                host,
                reason: `HTTP ${response.status}`,
            });
            return [];
        }
        const body = await response.json() as {
            data?: readonly { id?: unknown }[];
        };
        ids = (body.data ?? [])
            .map((item) => item.id)
            .filter((id): id is string => typeof id === "string" && id !== "");
    } catch (error) {
        log({
            type: "ollama_discovery_unavailable",
            host,
            reason: error instanceof Error ? error.message : String(error),
        });
        return [];
    }
    log({ type: "ollama_discovery_listed", host, models: ids });

    const described = await Promise.allSettled(ids.map(async (id) => {
        const response = await fetchImplementation(`${host}/api/show`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: id }),
            signal: AbortSignal.timeout(750),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body: unknown = await response.json();
        return {
            id,
            capabilities: ollamaCapabilities(body),
            contextWindow: ollamaContextWindow(body),
        };
    }));

    const models: SuggestedModel[] = [];
    const entries: CatalogModel[] = [];
    for (const [index, outcome] of described.entries()) {
        const id = ids[index]!;
        const detail = outcome.status === "fulfilled"
            ? outcome.value
            : { id, capabilities: undefined, contextWindow: undefined };
        const { capabilities, contextWindow } = detail;
        if (outcome.status === "rejected") {
            log({
                type: "ollama_model_probe_failed",
                model: id,
                reason: outcome.reason instanceof Error
                    ? outcome.reason.message
                    : String(outcome.reason),
            });
        } else {
            log({
                type: "ollama_model_described",
                model: id,
                ...(capabilities === undefined ? {} : { capabilities }),
                ...(contextWindow === undefined
                    ? {}
                    : { context_window: contextWindow }),
            });
        }
        if (capabilities !== undefined) {
            if (
                capabilities.includes("embedding")
                || !capabilities.includes("completion")
            ) {
                log({
                    type: "ollama_model_excluded",
                    model: id,
                    reason: capabilities.includes("embedding")
                        ? "embedding model"
                        : "no completion capability",
                });
                continue;
            }
        }
        models.push({
            provider: "ollama",
            model: id,
            label: id,
            description: "installed locally",
            ...(contextWindow === undefined ? {} : { contextWindow }),
        });
        if (capabilities === undefined) continue;
        entries.push({
            id,
            label: id,
            description: "installed locally",
            ...(contextWindow === undefined
                ? {}
                : { context_window: contextWindow }),
            ...(capabilities.includes("tools") ? { tool_support: true } : {}),
            levels: capabilities.includes("thinking")
                ? OLLAMA_REASONING_LEVELS
                : [],
        });
    }

    try {
        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "ollama",
            models: entries,
        }, options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir });
        log({
            type: "ollama_catalog_written",
            models: entries.map((entry) => entry.id),
        });
    } catch (error) {
        // The snapshot enriches the picker; failing to record it must not
        // block startup.
        log({
            type: "ollama_catalog_write_failed",
            reason: error instanceof Error ? error.message : String(error),
        });
    }
    return models;
}

export function ollamaCapabilities(
    value: unknown,
): readonly string[] | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const declared = (value as { capabilities?: unknown }).capabilities;
    return Array.isArray(declared)
        ? declared.filter((entry): entry is string => typeof entry === "string")
        : undefined;
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

import { forgetProviderConnection } from "../providers/forget-provider.ts";
import { connectedProviderCatalogs, modelsFromConnectedCatalogs } from "../providers/catalog-state.ts";
import { readModelCatalog } from "../providers/read-model-catalog.ts";
import { effectiveCatalog } from "../model/catalog.ts";
import { applyModelOperation } from "../model/model-operations.ts";
import { configuredModelAssignments as modelOperationAssignments } from "../config.ts";
import { readdir, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
    configuredModelFallback,
    configuredReviewer,
    configuredSubagentModel,
    configuredCompaction,
    configuredCompactionModels,
    configuredCompactionOverrides,
    configuredOverrides,
    overridePatchDefaults,
    configuredReviewers,
    configuredToolResults,
    createLiveVeraConfigReader,
    defaultVeraConfigPath,
    eventLogEnabled,
    loadVeraConfig,
    updateVeraConfigDefaults,
    type VeraProviderId,
    type VeraConfig,
} from "../config.ts";
import {
    adapterCacheFingerprint,
    applyModelRequestOptions,
    createRequestOptionsSnapshotAdapter,
    mergeModelRequestBody,
} from "../providers/routing.ts";
import { createWorkerAdapterOptions } from "./worker/adapter.ts";
import { defaultHostExtensionConfigs } from "../extensions/bundled-host.ts";
import {
    discoverProjectExtensionConfigs,
    mergeExtensionScopes,
} from "../extensions/discovery.ts";
import { reserveSessionIdentity } from "./session-identity-reservation.ts";
import {
    veraHomeDirectory,
    veraMachineDirectory,
    veraProfileDirectory,
} from "../profile-paths.ts";
import type { ModelAdapter } from "../model/types.ts";
import { isRefreshableProvider } from "../model/refreshable-providers.ts";
import { availableModels } from "../engine/model-settings.ts";
import { defaultEventLogPath } from "../engine/events.ts";
import {
    ModelFailureLedger,
    defaultModelFailureLedgerPath,
    readModelFailures,
} from "../store/model-failures.ts";
import {
    latestFailureBySession,
    readSessionFacts,
    type SessionFactName,
    type SessionFacts,
} from "../store/session-facts.ts";
import { contextWindowForModel } from "../engine/model-settings.ts";
import {
    cachedProviderModels,
    readCachedWindowIndex,
    withCachedWindows,
} from "../model/cached-windows.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import { pooledModels } from "../model/catalog-view.ts";
import { refreshWebDevArena } from "../model/webdev-arena.ts";
import type {
    CatalogModel,
} from "../model/catalog-shape.ts";
import {
    DEFAULT_CATALOG_MAX_AGE_MS,
    readFreshProviderCatalogSnapshot,
    readProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
} from "../model/catalog-cache.ts";
import { reduceModels } from "../model/catalog-reduction.ts";
import { createHostLogger, type HostLog } from "./host-log.ts";
import { createReviewLogger } from "../engine/review-log.ts";
import {
    HOST_CAPABILITIES,
} from "./capabilities.ts";
import { checkpointOpenStores } from "./store-checkpoint.ts";
import { readStampedRelease } from "../release/stamp.ts";

const hostLog = createHostLogger();
const reviewLog = createReviewLogger();
import {
    addPoolModel,
    recordLearned,
    movePoolModel,
    namePoolModel,
    readUserPoolFile,
    setPoolMembership,
    PoolFileWriteRefusedError,
} from "../model/pool-file-store.ts";
import { loadPoolFile } from "../model/pool-file-loader.ts";
import { poolReachability } from "../model/assignment-reachability.ts";
import { poolNameRefusal } from "../model/pool-names.ts";
import { admitToPool } from "../model/pool-admission.ts";
import { createFeedRowReader } from "../model/feed-cache.ts";
import { startCuratedRefresh } from "../model/curated-models.ts";
import {
    refreshDeepSeekCatalog,
} from "../model/deepseek-catalog.ts";
import { migrateConfigPool } from "../model/pool-migration.ts";
import { createPoolEffortPool } from "../model/effort-pool.ts";
import {
    refreshCodexCatalog,
    type CodexCatalogRefreshOptions,
} from "../model/codex-catalog.ts";
import {
    normalizeOpenRouterModels,
    refreshOpenRouterCatalog,
    type OpenRouterCatalogRefreshOptions,
} from "../model/openrouter-catalog.ts";
import {
    apiKey,
    createAuthStorage,
    credentialFingerprint,
    type AuthStorage,
} from "../providers/auth-storage.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";
import {
    configuredProviders,
    type ProviderDescriptor,
} from "../providers/registry.ts";
import {
    refreshOpenAIProviderCatalog,
    type ProviderCatalogFailure,
    type ProviderCatalogRefreshResult,
} from "../model/openai-discovery.ts";
import { OpenRouterAllowanceGuard } from "../providers/openrouter-allowance-guard.ts";
import { providerEndpointUrl } from "../providers/endpoint-url.ts";
import type { FailedRequestCapture } from "../providers/failed-request-capture.ts";
import { normalizeOllamaHost } from "../providers/ollama-openai.ts";
import { PermissionPreferenceStore } from "../engine/permission-preferences.ts";
import {
    defaultSessionDirectory,
    readSessionIndexMetadata,
} from "../store/session-store.ts";
import { ToolHooks } from "../engine/hooks.ts";
import { loadSkillContribution } from "../skills/contribution.ts";
import {
    loadStandingNudges,
    type StandingNudgeCadence,
    standingNudgeContribution,
} from "../standing-nudges.ts";
import {
    literalSecretDetail,
    StartupFindings,
} from "./startup-findings.ts";
import { skillScriptTool } from "../skills/script.ts";
import { inboxEnabled, openInboxIfEnabled } from "../store/inbox.ts";
import { createConsumerRegistry } from "./consumers.ts";
import { InboxDeliveryCoordinator } from "./inbox-delivery.ts";
import { InboxAdmissionPolicy } from "./inbox-admission.ts";
import { readArcNodeId, readArcToken } from "./arc-identity.ts";
import {
    startWatchRuntimeIfEnabled,
    type WatchRuntime,
} from "../watch/runtime.ts";
import type { WatchSecretResolver } from "../watch/arc-connector.ts";
import {
    startSidecarRuntimeIfNeeded,
    type SidecarRuntime,
} from "./sidecar-runtime.ts";
import { createWorkspaceSidecarSupervisor } from "./workspace-sidecars.ts";
import { veraRuntimeDirectory } from "../profile-paths.ts";
import type { WatchConnector } from "../watch/source.ts";
import type { SpawnSessionFn } from "./inbox-spawn.ts";
import {
    AgentRegistry,
    renameStoredSession,
    type RegisteredAgentSummary,
} from "./agent-registry.ts";
import type { SessionArtifacts } from "./session-trash.ts";
import { subagentPoolPolicy } from "./subagent-policy.ts";
import { createCommandHook } from "../extensions/command-hook.ts";
import type {
    PostToolUseHook,
    PreToolUseHook,
    SessionStartHook,
} from "../sdk/hooks.ts";
import type { ResidentAgent } from "./resident-agent.ts";
import { startHostServer, type HostServer } from "./server.ts";
import type { CatalogRefreshOutcome } from "./protocol.ts";
import { startAnnexProcess, type AnnexProcess } from "./annex-process.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistry,
    type ExtensionRegistryFailure,
} from "../extensions/registry.ts";
import { buildWorkIndex, type WorkIndexSnapshot } from "./work-index.ts";
import {
    NO_SEARCH_RESULTS,
    searchSessions,
} from "../store/session-search.ts";
import { ScheduleStore } from "../scheduler/store.ts";
import {
    startSchedulerRuntime,
    type SchedulerRuntime,
} from "../scheduler/runtime.ts";
import {
    SCHEDULER_SOURCE,
    type EmittedScheduleRun,
} from "../scheduler/types.ts";

const MAX_SCHEDULE_WORK_ROWS = 50;

export interface StartResidentHostOptions {
    readonly config: VeraConfig;
    readonly configPath?: string;
    readonly createAdapter?: () => ModelAdapter;
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    readonly buildId?: string;
    readonly projectRoot?: string;
    readonly sessionDirectory?: string;
    readonly permissionPreferencesPath?: string;
    readonly authStorage?: AuthStorage;
    readonly eventLogDirectory?: string;
    readonly trashSessionArtifacts?: (
        artifacts: SessionArtifacts,
    ) => Promise<void>;
    readonly modelFailureLedgerPath?: string;
    readonly inboxPath?: string;
    readonly inboxUserConfigPath?: string;
    readonly schedulePath?: string;
    readonly watchConnectors?: readonly WatchConnector[];
    readonly arcConfigPath?: string;
    readonly watchSecret?: WatchSecretResolver;
    readonly sidecarLogDirectory?: string;
    readonly spawnConsentPath?: string;
    readonly spawnSession?: SpawnSessionFn;
    readonly onExtensionFailure?: (
        failure: ExtensionRegistryFailure,
    ) => void;
    readonly startupLog?: HostLog;
    readonly startupFindings?: StartupFindings;
    readonly webRoot?: string;
}

export interface HostHealth {
    readonly annex: "ok" | "failed";
    readonly annexReason?: string;
}

export interface ResidentHost {
    readonly registry: AgentRegistry;
    readonly extensions: ExtensionRegistry;
    readonly server: HostServer;
    readonly shutdownRequested: Promise<void>;
    readonly health: HostHealth;
    readonly annexPid?: number;
    readonly buildId: string;
    close(): Promise<void>;
}

export async function startResidentHost(
    options: StartResidentHostOptions,
): Promise<ResidentHost> {
    const startupStarted = performance.now();
    const startupLog = options.startupLog ?? hostLog;
    const timed = async <T>(
        phase: string,
        run: () => T | Promise<T>,
    ): Promise<T> => {
        const started = performance.now();
        try {
            const result = await run();
            startupLog({
                type: "host_startup_phase",
                phase,
                outcome: "completed",
                duration_ms: performance.now() - started,
            });
            return result;
        } catch (error) {
            startupLog({
                type: "host_startup_phase",
                phase,
                outcome: "failed",
                duration_ms: performance.now() - started,
            });
            throw error;
        }
    };
    const migration = migrateConfigPool();
    if (migration.notice !== undefined) {
        hostLog({ type: "pool_migrated", message: migration.notice });
    }
    // The config as it stands on disk, not as it stood when the host came up. Every setting below is read through this, so changing one in the settings pane reaches a session.
    const configPath = options.configPath ?? defaultVeraConfigPath();
    const currentConfig = createLiveVeraConfigReader(options.config, {
        path: configPath,
        ...(options.projectRoot === undefined
            ? {}
            : { projectRoot: options.projectRoot }),
    });
    const currentReachability = () => poolReachability(loadPoolFile({}).merged);
    const sessionDirectory = options.sessionDirectory
        ?? defaultSessionDirectory();
    const sessionIdentityReservationRoot = options.sessionDirectory === undefined
        ? veraMachineDirectory()
        : sessionDirectory;
    const eventLogDirectory = options.eventLogDirectory;
    const authStorage = options.authStorage ?? createAuthStorage();
    let models = await timed("model_discovery", () =>
        options.createAdapter === undefined
            ? discoverAvailableModels(options.config, authStorage)
            : configuredCatalog(options.config)
    );
    let catalogRefreshes: Promise<void> = Promise.resolve();
    const permissionPreferences = await timed("permission_preferences", () =>
        PermissionPreferenceStore.open(options.permissionPreferencesPath)
    );
    const startupFindings = options.startupFindings ?? new StartupFindings();
    const extensions = await timed(
        "extension_registry",
        () => startExtensionRegistry({
            extensions: mergeExtensionScopes(
                defaultHostExtensionConfigs(
                    options.config.disabled_builtin_extensions ?? [],
                ),
                options.config.extensions ?? [],
            ),
            onFailure: (failure) => {
                startupLog({
                    type: "host_startup_extension_failed",
                    extension_id: failure.extensionId ?? failure.path,
                    message: failure.message,
                });
                startupFindings.record({
                    extensionId: failure.extensionId ?? failure.path,
                    detail: `did not load: ${failure.message}`,
                });
                options.onExtensionFailure?.(failure);
            },
            onLiteralSecret: (finding) => {
                startupFindings.record({
                    extensionId: finding.extensionId,
                    detail: literalSecretDetail(
                        finding.configPath,
                        finding.prefix,
                    ),
                });
            },
            onActivationTiming: (timing) => startupLog({
                type: "host_startup_extension",
                extension_id: timing.extensionId,
                outcome: timing.outcome,
                duration_ms: timing.durationMs,
            }),
        }),
    );
    const sessionIdentity = extensions.sessionIdentity();
    if (sessionIdentity === undefined) {
        await extensions.close();
        throw new Error(
            "Resident host requires one sessions.identity provider",
        );
    }
    const hasModelRequestHooks = extensions.modelRequestHooks().length > 0;
    const openRouterAllowanceGuard = new OpenRouterAllowanceGuard();
    const standingNudgeCadenceBySession = new Map<
        string,
        StandingNudgeCadence
    >();
    const createAdapter = options.createAdapter
        ?? ((
            provider?: string,
            projectRoot?: string,
            captureFailedRequest?: FailedRequestCapture,
        ) => {
            const config = currentConfig();
            return createConfiguredModelAdapter({
                ...config,
                provider: (provider ?? config.provider) as
                    VeraConfig["provider"],
            }, {
                authStorage,
                log: hostLog,
                openRouterAllowanceGuard,
                ...scoped(projectRoot),
                ...(captureFailedRequest === undefined
                    ? {}
                    : { captureFailedRequest }),
            });
        });
    const inbox = options.inboxPath === undefined
        ? openInboxIfEnabled(options.config)
        : openInboxIfEnabled(options.config, options.inboxPath);
    const consumers = createConsumerRegistry(inbox);
    const inboxDelivery = consumers === null
        ? undefined
        : new InboxDeliveryCoordinator(consumers, {
            admissionFor: (projectRoot) => projectRoot === undefined
                ? undefined
                : InboxAdmissionPolicy.fromConfig(
                    options.config,
                    projectRoot,
                    options.inboxUserConfigPath,
                ),
        });
    let workIndexThisTurn: WorkIndexSnapshot | undefined;
    const workChangeListeners = new Set<() => void>();
    const notifyWorkChanged = (): void => {
        for (const listener of [...workChangeListeners]) {
            try {
                listener();
            } catch {
            }
        }
    };
    const scheduleStore = inbox === null
        ? null
        : ScheduleStore.open(options.schedulePath);
    let watches: WatchRuntime | null = null;
    let scheduler: SchedulerRuntime | null = null;
    let sidecars: SidecarRuntime | null = null;
    let publishedSocketPath = options.socketPath ?? "";
    const workspaceSidecars = createWorkspaceSidecarSupervisor({
        socketPath: () => publishedSocketPath,
        logDirectory: options.sidecarLogDirectory
            ?? join(veraRuntimeDirectory(), "logs", "sidecars"),
        onStateChange: (status) => hostLog({
            type: "sidecar_state",
            sidecar: status.sidecarId,
            state: status.state,
            ...(status.pid === null ? {} : { pid: status.pid }),
            ...(status.lastError === null
                ? {}
                : { message: status.lastError }),
        }),
    });
    const closeSidecars = async (): Promise<void> => {
        curatedRefresh.close();
        await workspaceSidecars.close();
        await sidecars?.close();
        sidecars = null;
    };
    const closeInbox = async (): Promise<void> => {
        await watches?.close();
        await scheduler?.close();
        scheduleStore?.close();
        inboxDelivery?.close();
        inbox?.close();
    };
    const curatedRefresh = startCuratedRefresh(
        options.config.curated_models_url === undefined
            ? {}
            : { url: options.config.curated_models_url },
    );
    const readFeedRow = createFeedRowReader(
        options.config.model_feed_url === undefined
            ? {}
            : { url: options.config.model_feed_url },
    );
    const eventLogPathForId = eventLogEnabled(currentConfig())
        ? (agentId: string, cwd: string) =>
            eventLogDirectory === undefined
                ? defaultEventLogPath(agentId, cwd)
                : join(eventLogDirectory, `${agentId}.jsonl`)
        : undefined;
    const registry = new AgentRegistry({
        credentialFingerprint: (provider) => adapterCacheFingerprint(
            currentConfig(),
            credentialFingerprint(authStorage, provider),
            provider,
        ),
        createAdapter,
        modelMiddleware: extensions.modelMiddleware(),
        ...(options.createAdapter !== undefined || hasModelRequestHooks
                || extensions.modelMiddleware().length > 0
            ? {}
            : {
                workerAdapterSpec: (context: {
                    readonly provider: string;
                    readonly projectRoot: string;
                    readonly sessionId: string;
                }) => ({
                    module: WORKER_ADAPTER_MODULE,
                    export: "createWorkerAdapter",
                    options: createWorkerAdapterOptions(
                        currentConfig(),
                        configPath,
                        context,
                    ),
                }),
            }),
        provider: options.config.provider,
        customProviderIds: () => Object.keys(currentConfig().providers ?? {}),
        model: options.config.model,
        approvalMode: options.config.approval_mode,
        availableModels: models,
        refreshAvailableModels: options.createAdapter === undefined
            ? () => {
                models = withProviderRefreshability(modelsFromConnectedCatalogs(currentConfig(), models, { authStorage }), currentConfig());
                return models;
            }
            : undefined,
        providerCatalogs: () => connectedProviderCatalogs(currentConfig(), { authStorage }),
        refreshableProviders: () => {
            const config = currentConfig();
            return connectedProviderCatalogs(config, { authStorage })
                .filter((provider) => isRefreshableProvider(provider.id, config)
                    || configuredProviders(config).find((row) => row.id === provider.id)?.protocol === "anthropic-messages")
                .map((provider) => provider.id);
        },
        refreshCatalog: (provider) => {
            const refreshed = catalogRefreshes.then(async () => {
                const config = currentConfig();
                const webdev = refreshWebDevArena({ maxAgeMs: 0 });
                try {

                    const descriptor = configuredProviders(config)
                        .find((entry) => entry.id === provider);
                    if (descriptor !== undefined && descriptor.baseUrl !== undefined && descriptor.protocol !== undefined
                        && (descriptor.protocol === "anthropic-messages" || descriptor.behaviorId === "openrouter")) {
                        const stored = authStorage.getCredential(provider);
                        const key = stored?.type === "api_key" ? stored.key : descriptor.envVar === undefined ? undefined : process.env[descriptor.envVar];
                        const catalog = await readModelCatalog({ provider, baseUrl: descriptor.baseUrl, protocol: descriptor.protocol, apiKey: key,
                            ...(descriptor.behaviorId === "openrouter" ? { normalize: normalizeOpenRouterModels } : {}) })
                            .catch(() => undefined);
                        if (catalog === undefined) return undefined;
                        writeProviderCatalogSnapshot(catalog);
                        models = modelsFromConnectedCatalogs(config, models, { authStorage });
                        return models;
                    }
                    if (!isRefreshableProvider(provider, config)) return undefined;
                    if (descriptor?.behaviorId === "ollama") {
                        const discovered = await discoverOllamaModelCatalog({
                            log: hostLog,
                            ...(config.provider_endpoints?.ollama === undefined
                                ? {}
                                : { host: config.provider_endpoints.ollama }),
                        });
                        if (!discovered.available) {
                            return undefined;
                        }
                        models = replaceProviderRows(
                            models,
                            provider,
                            discovered.models,
                            config.provider === provider
                                ? {
                                    provider,
                                    model: config.model,
                                    label: config.model,
                                    description: "configured model",
                                }
                                : undefined,
                        );
                        return models;
                    }
                    const before = readProviderCatalogSnapshot(provider).fetched_at;
                    const standard = descriptor?.behaviorId === "openrouter"
                        ? undefined
                        : await standardProviderModels(
                            descriptor,
                            config,
                            authStorage,
                            { maxAgeMs: 0 },
                        );
                    const rows = standard === undefined
                        ? await discoveredOpenRouterModels(config, { maxAgeMs: 0 })
                        : standard.models;
                    if (
                        standard?.failure !== undefined
                        ||
                        readProviderCatalogSnapshot(provider).fetched_at === before
                    ) {
                        return undefined;
                    }
                    models = withProviderRefreshability(
                        descriptor?.behaviorId === "openrouter"
                            ? withProviderRows(models, provider, rows)
                            : replaceProviderRows(
                                models,
                                provider,
                                rows,
                                config.provider === provider
                                    ? {
                                        provider,
                                        model: config.model,
                                        label: config.model,
                                        description: "configured model",
                                    }
                                    : undefined,
                            ),
                        config,
                    );
                    return models;
                } finally {
                    await webdev.catch(() => undefined);
                }
            });
            // The queue carries the turn, not its failure: one refresh that throws must not leave every later one rejected.
            catalogRefreshes = refreshed.then(() => undefined, () => undefined);
            return refreshed;
        },
        readPool: (projectRoot) => pooledModels(models, scoped(projectRoot)),
        createEffortPool: (projectRoot) =>
            createPoolEffortPool({
                ...scoped(projectRoot),
                onWriteRefused: (error) =>
                    hostLog({ type: "pool_write_refused", message: error.message }),
            }),
        readPolicy: (projectRoot) => ({ ...subagentPoolPolicy(scoped(projectRoot)),
            candidates: pooledModels(models, { ...scoped(projectRoot), includeUncurated: true }) }),
        admitToPool: (entry, onStep, admissionOptions) => {
            const config = currentConfig();
            return admitToPool(entry, onStep, {
                ...admissionOptions,
                createAdapter: (provider) => createRequestOptionsSnapshotAdapter(
                    (selected) => createAdapter(selected),
                    provider,
                    config,
                ),
                readFeedRow,
                onWriteRefused: (error) =>
                    hostLog({ type: "pool_write_refused", message: error.message }),
            });
        },
        removeFromPool: (entry) => {
            refusedPoolWrite(() => {
                setPoolMembership([`${entry.provider}/${entry.model}`], false);
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
                const file = namePoolModel(id, name ?? undefined);
                named = file.models[id] !== undefined
                    && file.models[id]?.name === (name ?? undefined);
            });
            return refused === undefined && named;
        },
        movePoolEntry: (entry, delta) => {
            const id = `${entry.provider}/${entry.model}`;
            let held = false;
            const refused = refusedPoolWrite(() => {
                held = Object.hasOwn(readUserPoolFile().models, id);
                if (held) movePoolModel(id, delta);
            });
            return refused === undefined && held;
        },
        updateModelDefaults: (settings) => {
            updateVeraConfigDefaults({
                provider: settings.provider as VeraConfig["provider"],
                model: settings.model,
                // Explicitly null rather than omitted: settings that carry no effort mean the accepted model has none, so a stored default from an earlier model must not survive into the next.
                reasoning_effort: settings.reasoningEffort ?? null,
            });
        },
        contextLimit: () => currentConfig().context_limit,
        updateContextLimit: (limit) => {
            updateVeraConfigDefaults({ context_limit: limit });
        },
        updateApprovalDefault: (mode) => {
            updateVeraConfigDefaults({ approval_mode: mode });
        },
        ...(options.config.reasoning_effort === undefined
            ? {}
            : { reasoningEffort: options.config.reasoning_effort }),
        get modelFallback() {
            return configuredModelFallback(currentConfig());
        },
        readReviewer: () => configuredReviewer(
            currentConfig(),
            currentReachability(),
        ),
        get subagentModel() {
            return configuredSubagentModel(currentConfig());
        },
        get reviewers() {
            return configuredReviewers(currentConfig(), currentReachability());
        },
        reviewLog,
        writeReviewer: (settings) => {
            if (settings === null || settings.models.length === 0) {
                updateVeraConfigDefaults({ reviewer: null });
                return;
            }
            const [primary, fallback] = settings.models;
            updateVeraConfigDefaults({
                reviewer: {
                    model: primary!.model,
                    ...(primary!.provider === undefined
                        ? {}
                        : { provider: primary!.provider as VeraProviderId }),
                    ...(primary!.reasoningEffort === undefined
                        ? {}
                        : { reasoning_effort: primary!.reasoningEffort }),
                    ...(fallback === undefined ? {} : {
                        fallback_model: fallback.model,
                        ...(fallback.provider === undefined
                            ? {}
                            : {
                                fallback_provider:
                                    fallback.provider as VeraProviderId,
                            }),
                        ...(fallback.reasoningEffort === undefined
                            ? {}
                            : {
                                fallback_reasoning_effort:
                                    fallback.reasoningEffort,
                            }),
                    }),
                    ...(settings.timeoutMs === undefined
                        ? {}
                        : { timeout_ms: settings.timeoutMs }),
                    ...(settings.twoTier === undefined
                        ? {}
                        : { two_tier: settings.twoTier }),
                },
            });
        },
        get compaction() {
            return configuredCompaction(currentConfig());
        },
        configuredOverrides: () => configuredOverrides(currentConfig()),
        updateOverrides: (patch) => {
            updateVeraConfigDefaults(overridePatchDefaults(patch));
        },
        get compactionOverrides() {
            return configuredCompactionOverrides(currentConfig());
        },
        get toolResults() {
            return configuredToolResults(currentConfig());
        },
        get compactionModels() {
            return configuredCompactionModels(
                currentConfig(),
                currentReachability(),
            );
        },
        get permissionModes() {
            return currentConfig().permission_modes;
        },
        permissionPreferences,
        extensionTools: [...extensions.tools(), skillScriptTool],
        workerExtensions: (workspace) => {
            const config = currentConfig();
            return mergeExtensionScopes(
                config.extensions ?? [],
                discoverProjectExtensionConfigs(workspace),
            );
        },
        acquireWorkspaceSidecars: (workspace) =>
            workspaceSidecars.acquire(workspace),
        releaseWorkspaceSidecars: (workspace) =>
            workspaceSidecars.release(workspace),
        registeredAgents: extensions.agents(),
        sessionIdentity,
        reserveSessionIdentity: (sessionId, key) =>
            reserveSessionIdentity(sessionIdentityReservationRoot, sessionId, key),
        loadContextualContributions: async (
            instructionRoot,
            allowedSkills,
            context,
        ) => {
            let cadence: StandingNudgeCadence | undefined;
            if (context?.sessionId !== undefined) {
                cadence = standingNudgeCadenceBySession.get(context.sessionId);
                if (cadence === undefined) {
                    cadence = { matchingTurns: new Map<string, number>() };
                    standingNudgeCadenceBySession.set(
                        context.sessionId,
                        cadence,
                    );
                }
            }
            const standing = context === undefined || context.turn === "delivery"
                ? undefined
                : standingNudgeContribution(
                    loadStandingNudges(veraProfileDirectory()),
                    context,
                    cadence,
                );
            return [
                ...await loadSkillContribution(instructionRoot, allowedSkills),
                ...startupFindings.contributions(),
                ...(standing === undefined ? [] : [standing]),
            ];
        },
        createToolHooks: () => {
            const hooks = new ToolHooks((failure) => hostLog({
                type: "session_start_hook_failed",
                level: "warn",
                ...failure,
            }));
            registerConfiguredHooks(hooks, currentConfig());
            for (const hook of extensions.preToolUseHooks()) {
                hooks.registerPreToolUse(hook);
            }
            for (const hook of extensions.postToolUseHooks()) {
                hooks.registerPostToolUse(hook);
            }
            for (const hook of extensions.sessionStartHooks()) {
                hooks.registerSessionStart(hook);
            }
            for (const hook of extensions.preTurnHooks()) {
                hooks.registerPreTurn(hook);
            }
            return hooks;
        },
        prepareModelRequest: ({ sessionId, workspace }) => async (request, provider) => {
            const body: Record<string, import("../sdk/hooks.ts").JsonValue> = {};
            for (const hook of extensions.modelRequestHooks()) {
                const value = await hook.run({
                    type: "model_request",
                    provider,
                    model: request.model,
                    sessionId,
                    workspace,
                    ...(request.signal === undefined
                        ? {}
                        : { signal: request.signal }),
                });
                if (value === undefined) continue;
                const cloned = structuredClone(value);
                const serialized = JSON.stringify(cloned);
                if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
                    throw new Error(
                        `Model request contribution ${hook.namespace} exceeded 65536 bytes`,
                    );
                }
                body[hook.namespace] = cloned;
            }
            const contributed = Object.keys(body).length === 0
                ? request
                : mergeModelRequestBody(
                    request,
                    body,
                    "model request hooks",
                );
            return applyModelRequestOptions(
                contributed,
                currentConfig(),
                provider,
            );
        },
        get disabledPromptContributions() {
            return currentConfig().disabled_prompt_contributions;
        },
        ...(inboxDelivery === undefined ? {} : {
            inboxDelivery,
            inboxActorForSession: () => readArcNodeId(options.arcConfigPath),
        }),
        sessionPathForId: (agentId) =>
            join(sessionDirectory, `${agentId}.jsonl`),
        modelFailureLedger: new ModelFailureLedger(
            options.modelFailureLedgerPath ?? defaultModelFailureLedgerPath(),
        ),
        ...(eventLogPathForId === undefined ? {} : { eventLogPathForId }),
        ...(options.trashSessionArtifacts === undefined
            ? {}
            : { trashSessionArtifacts: options.trashSessionArtifacts }),
    });

    let server: HostServer;
    let annex: AnnexProcess | undefined;
    let annexUrl: string | undefined;
    let annexUnavailable: string | undefined;
    const annexHealth: { annex: "ok" | "failed"; annexReason?: string } = {
        annex: "failed",
    };
    const markAnnexFailed = (reason: string): void => {
        annexUrl = undefined;
        annexUnavailable =
            `${reason} Restart the host to bring the annex back.`;
        annexHealth.annex = "failed";
        annexHealth.annexReason = reason;
    };
    const markAnnexOk = (url: string): void => {
        annexUrl = url;
        annexUnavailable = undefined;
        annexHealth.annex = "ok";
        delete annexHealth.annexReason;
    };
    const restoringSessions = new Map<string, Promise<ResidentAgent>>();
    let publishStoredSessions: (
        sessions: ReadonlyMap<string, RegisteredAgentSummary>,
    ) => void = () => {};
    const storedSessionIndex = new Map<string, RegisteredAgentSummary>();
    const storedSessions = new Promise<
        ReadonlyMap<string, RegisteredAgentSummary>
    >(
        (resolve) => publishStoredSessions = resolve,
    );
    const resumeSession = (sessionPath: string) =>
        resumeOrFind(registry, sessionPath, restoringSessions);
    let closing: Promise<void> | undefined;
    let announceShutdown: () => void = () => {};
    const shutdownRequested = new Promise<void>((resolve) => {
        announceShutdown = resolve;
    });
    const closeHost = (): Promise<void> => {
        if (closing === undefined) {
            announceShutdown();
            closing = (async () => {
                try {
                    await annex?.close();
                } finally {
                    await closeResidentHost(
                        server,
                        registry,
                        extensions,
                        closeInbox,
                        closeSidecars,
                    );
                }
            })();
        }
        return closing;
    };
    try {
        watches = startWatchRuntimeIfEnabled(inbox, {
            watches: extensions.contributions().watches(),
            ...(options.watchConnectors === undefined
                ? {}
                : { connectors: options.watchConnectors }),
            secret: options.watchSecret
                ?? (() => readArcToken(options.arcConfigPath)),
            onAppended: () => {
                void inboxDelivery?.pumpAll();
            },
        });
        scheduler = await timed("scheduler", () =>
            scheduleStore === null || inboxDelivery === undefined
                ? null
                : startSchedulerRuntime({
                store: scheduleStore,
                emit: (key, entry) =>
                    inboxDelivery.appendOnce(SCHEDULER_SOURCE, key, entry),
                onRunEmitted: notifyWorkChanged,
                onError: (error) => hostLog({
                    type: "scheduler_failed",
                    message: error instanceof Error
                        ? error.message
                        : String(error),
                }),
                })
        );
        const recentScheduleRuns = (): readonly EmittedScheduleRun[] => {
            try {
                return scheduleStore?.recentlyEmitted(MAX_SCHEDULE_WORK_ROWS)
                    ?? [];
            } catch {
                return [];
            }
        };
        const providerGenerations = new Map<string, number>();
        server = await timed(
            "server_listen_and_lockfile",
            () => startHostServer({
                capabilities: HOST_CAPABILITIES,
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
            ...(options.buildId === undefined
                ? {}
                : { buildId: options.buildId }),
            ...(options.projectRoot === undefined
                ? {}
                : { projectRoot: options.projectRoot }),
            findAgent: (agentId) => findOrRestoreAgent(
                registry,
                agentId,
                sessionDirectory,
                storedSessions,
                resumeSession,
            ),
            readAgentTree: (agentId) => registry.ownedTreeIds(agentId),
            forgetProvider: async (provider, workspace) => {
                forgetProviderConnection(provider, authStorage);
                providerGenerations.set(provider, (providerGenerations.get(provider) ?? 0) + 1);
                for (const entry of registry.agents.values()) {
                    if (entry.modelSettings.provider !== provider) continue;
                    const settings = { ...entry.modelSettings, selectionCleared: true };
                    await entry.store.appendModelSettings(settings, registry.originFor(entry, settings));
                    entry.modelSettings = settings;
                    registry.pushWorkerState(entry.agent.id);
                }
                return registry.readHostModelSettings(workspace);
            },
            operateModels: async (request, onResult) => {
                const generations = new Map(request.models.map(({ provider }) =>
                    [provider, providerGenerations.get(provider) ?? 0]));
                await applyModelOperation(request, {
                    isCurrent: ({ provider }) => generations.get(provider) === (providerGenerations.get(provider) ?? 0),
                    discovered: registry.modelsForClient(),
                    assignments: modelOperationAssignments(currentConfig()).map((slot) => ({ label: slot.label, models: slot.declared })),
                    createAdapter: (provider) => createAdapter(provider),
                    catalog: (provider, model) => effectiveCatalog(provider).models.find((row) => row.id === model),
                    onResult,
                });
                return registry.readHostModelSettings(request.workspace);
            },
            readModelSettings: (workspace) =>
                registry.readHostModelSettings(workspace),
            refreshCatalog: async (provider, workspace) => {
                const refreshed = await registry.refreshHostCatalog(provider);
                if (refreshed === undefined) return undefined;
                return registry.readHostModelSettings(workspace);
            },
            refreshCatalogs: () => {
                const refreshed = catalogRefreshes.then(async () => {
                    const config = currentConfig();
                    const outcomes = await refreshProviderCatalogs(config, {
                        authStorage,
                    });
                    models = await discoverAvailableModels(config, authStorage);
                    registry.availableModels = models;
                    return outcomes;
                });
                catalogRefreshes = refreshed.then(() => undefined, () => undefined);
                return refreshed;
            },
            readAnnex: () => annexUrl === undefined
                ? {
                    unavailable: annexUnavailable
                        ?? "The annex is not running. Restart the host to bring it back.",
                }
                : { url: annexUrl },
            listAgents: async () => mergeStoredAndResidentAgents(
                await storedSessions,
                registry.list(),
            ),
            readSessionFacts: (sessions, include) =>
                enrichSessionsWithFacts(
                    sessions,
                    include,
                    options.modelFailureLedgerPath
                        ?? defaultModelFailureLedgerPath(),
                ),
            listBackgroundAgents: () => registry.list(),
            readWorkIndex: () => {
                if (workIndexThisTurn !== undefined) {
                    return workIndexThisTurn;
                }
                const agents = registry.workFacts();
                workIndexThisTurn = buildWorkIndex(
                    agents,
                    registry.scheduleWorkFacts(recentScheduleRuns(), agents),
                );
                queueMicrotask(() => {
                    workIndexThisTurn = undefined;
                });
                return workIndexThisTurn;
            },
            searchSessions: async (query) => {
                if (query.session_id === undefined) {
                    return searchSessions(sessionDirectory, query);
                }
                const resident = registry.list().find(
                    (session) => session.id === query.session_id,
                );
                const stored = resident === undefined
                    ? (await storedSessions).get(query.session_id)
                    : undefined;
                const sessionPath = resident?.session_path ?? stored?.session_path;
                return sessionPath === undefined
                    ? NO_SEARCH_RESULTS
                    : searchSessions(sessionDirectory, query, { sessionPath });
            },
            ...(scheduler === null ? {} : {
                runScheduleOperation: (operation) => scheduler!.execute(operation),
            }),
            onRosterChanged: (listener) => {
                const stopRoster = registry.onRosterChanged(listener);
                workChangeListeners.add(listener);
                return (): void => {
                    stopRoster();
                    workChangeListeners.delete(listener);
                };
            },
            createAgent: (createOptions) => registry.create(createOptions),
            resumeAgent: resumeSession,
            branchAgent: (options) => registry.branch(options),
            discardBranch: async (agentId) => {
                await registry.trashSession(agentId);
            },
            commitBranch: (agentId) => registry.commitBranch(agentId),
            syncAgentContext: (agentId) => registry.syncBranchContext(agentId),
            trashSession: async (targetId) => {
                const resident = await registry.trashSession(targetId);
                if (resident === "trashed") {
                    storedSessionIndex.delete(targetId);
                    return resident;
                }
                if (resident !== "not_found") return resident;
                const sessionPath = await storedSessionPath(
                    targetId,
                    sessionDirectory,
                    await storedSessions,
                );
                if (sessionPath === undefined) return "not_found";
                const workspace = storedSessionIndex.get(targetId)?.workspace;
                try {
                    await registry.trashArtifacts({
                        sessionPath,
                        attachmentsPath: `${sessionPath}.attachments`,
                        ...(eventLogPathForId === undefined
                                || workspace === undefined
                            ? {}
                            : {
                                eventLogPath: eventLogPathForId(
                                    targetId,
                                    workspace,
                                ),
                            }),
                    });
                } catch {
                    return "failed";
                }
                storedSessionIndex.delete(targetId);
                return "trashed";
            },
            closeAgent: async (targetId) => {
                const treeIds = registry.ownedTreeIds(targetId);
                const outcome = await registry.closeAgentTree(targetId);
                if (outcome.status === "closed" && outcome.sessionRetained) {
                    for (const id of treeIds.length > 0 ? treeIds : [targetId]) {
                        await indexStoredSession(
                            join(sessionDirectory, `${id}.jsonl`),
                            storedSessionIndex,
                        );
                    }
                }
                if (outcome.status === "closed") {
                    return {
                        status: "closed",
                        sessionRetained: outcome.sessionRetained,
                    };
                }
                return await storedSessionExists(
                    targetId,
                    sessionDirectory,
                    storedSessionIndex,
                )
                    ? { status: "closed", sessionRetained: true }
                    : { status: "not_found" };
            },
            renameSession: async (targetId, name) => {
                const resident = await registry.renameSession(targetId, name);
                if (resident.status !== "not_found") return resident;
                const sessionPath = await storedSessionPath(
                    targetId,
                    sessionDirectory,
                    await storedSessions,
                );
                if (sessionPath === undefined) {
                    return { status: "not_found" };
                }
                const renamed = await renameStoredSession(sessionPath, name);
                if (renamed.status === "renamed") {
                    await indexStoredSession(sessionPath, storedSessionIndex);
                }
                return renamed;
            },
            readExtensionState: (sessionId) => extensions.sessionState(sessionId),
            listExtensionCommands: () => extensions.commands(),
            runExtensionCommand: (
                name,
                argumentsText,
                workspace,
                signal,
                sessionId,
            ) => extensions.invokeCommand(
                name,
                argumentsText,
                workspace,
                signal,
                sessionId,
                sessionId === undefined ? undefined : join(sessionDirectory, `${sessionId}.jsonl`),
            ),
            checkpointStores: async (destination) => checkpointOpenStores({
                destination,
                inbox,
                schedules: scheduleStore,
            }),
            canShutdown: () => registry.idleForShutdown(),
            canReplace: () => registry.idleForReplacement(),
            onShutdownAccepted: closeHost,
            onAgentStartFailure: (operation, error) => hostLog({
                type: "agent_start_failed",
                operation,
                ...hostErrorFields(error),
            }),
            }),
        );
        try {
            annex = await startAnnexProcess({
                home: veraHomeDirectory(),
                ...(options.webRoot === undefined
                    ? {}
                    : { assets: options.webRoot }),
                onExit: (reason) => {
                    markAnnexFailed(reason);
                    hostLog({
                        type: "annex_exited",
                        health: "annex: failed",
                        message: reason,
                    });
                },
            });
            markAnnexOk(annex.url);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            markAnnexFailed(reason);
            const entry = {
                type: "annex_failed",
                health: "annex: failed",
                ...hostErrorFields(error),
            };
            hostLog(entry);
            if (startupLog !== hostLog) startupLog(entry);
        }
        publishedSocketPath = server.socketPath;
        sidecars = startSidecarRuntimeIfNeeded({
            sidecars: extensions.contributions().sidecars(),
            socketPath: server.socketPath,
            logDirectory: options.sidecarLogDirectory
                ?? join(veraRuntimeDirectory(), "logs", "sidecars"),
            onStateChange: (status) => hostLog({
                type: "sidecar_state",
                sidecar: status.sidecarId,
                state: status.state,
                ...(status.pid === null ? {} : { pid: status.pid }),
                ...(status.lastError === null
                    ? {}
                    : { message: status.lastError }),
            }),
        });
        void indexStoredSessions(sessionDirectory, storedSessionIndex).then(
            publishStoredSessions,
        );
    } catch (error) {
        try {
            await closeSidecars();
        } catch {
        }
        try {
            await extensions.close();
        } catch {
        }
        await registry.close();
        await closeInbox();
        throw error;
    }

    const buildId = readStampedRelease().build_id;
    startupLog({
        type: "host_startup_complete",
        duration_ms: performance.now() - startupStarted,
        build_id: buildId,
    });
    return {
        registry,
        extensions,
        server,
        shutdownRequested,
        health: annexHealth,
        ...(annex === undefined ? {} : { annexPid: annex.pid }),
        buildId,
        close: closeHost,
    };
}

function scoped(projectRoot?: string): { readonly projectRoot?: string } {
    return projectRoot === undefined ? {} : { projectRoot };
}

function hostErrorFields(error: unknown): Record<string, unknown> {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
        error_name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        ...(typeof code === "string" ? { code } : {}),
    };
}

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

export function catalogMaxAgeMs(config: VeraConfig): number {
    const days = config.model_catalog_max_age_days;
    return days === undefined
        ? DEFAULT_CATALOG_MAX_AGE_MS
        : days * 24 * 60 * 60 * 1000;
}

export type { CatalogRefreshOutcome };

export type CatalogRefreshFailure =
    | ProviderCatalogFailure
    | "missing_credential"
    | "persistence_failed"
    | "invalid";

export interface CatalogRefreshOptions {
    readonly authStorage?: AuthStorage;
    readonly cacheDir?: string;
}

export async function refreshProviderCatalogs(
    config: VeraConfig,
    options: CatalogRefreshOptions = {},
): Promise<readonly CatalogRefreshOutcome[]> {
    const cacheOptions = options.cacheDir === undefined
        ? {}
        : { cacheDir: options.cacheDir };
    const authStorage = options.authStorage ?? createAuthStorage();
    const [ollama, openrouter, standard] = await Promise.all([
        discoverOllamaModelCatalog({
            ...cacheOptions,
            ...(config.provider_endpoints?.ollama === undefined
                ? {}
                : { host: config.provider_endpoints.ollama }),
        }),
        hasOpenRouterCredential(config)
            ? discoveredOpenRouterModels(config, {
                ...cacheOptions,
                maxAgeMs: 0,
            })
            : undefined,
        Promise.all(standardProviderDescriptors(config).map((descriptor) =>
            standardProviderModels(descriptor, config, authStorage, {
                ...cacheOptions,
                maxAgeMs: 0,
            })
        )),
        refreshWebDevArena({ ...cacheOptions, maxAgeMs: 0 }).catch(() => undefined),
    ]);
    return [
        ollama.available
            ? { provider: "ollama", models: ollama.models.length }
            : { provider: "ollama", failure: "unavailable" as const },
        openrouter === undefined
            ? { provider: "openrouter", failure: "missing_credential" }
            : { provider: "openrouter", models: openrouter.length },
        ...standard.map((result, index) => standardRefreshOutcome(
            standardProviderDescriptors(config)[index]!.id,
            result,
        )),
    ];
}

export function replaceProviderRows(
    models: readonly SuggestedModel[],
    provider: string,
    rows: readonly SuggestedModel[],
    configured?: SuggestedModel,
): readonly SuggestedModel[] {
    const named = new Set(rows.map((row) => row.model));
    const replacement = named.has(configured?.model ?? "")
        ? [...rows]
        : configured === undefined
            ? [...rows]
            : [...rows, configured];
    return [
        ...models.filter((model) => model.provider !== provider),
        ...replacement,
    ];
}

function standardRefreshOutcome(
    provider: string,
    result: StandardProviderModelsResult,
): CatalogRefreshOutcome {
    return result.failure === undefined
        ? { provider, models: result.models.length }
        : {
            provider,
            failure: result.failure,
            ...(result.models.length === 0
                ? {}
                : { keptModels: result.models.length }),
        };
}

function standardProviderDescriptors(
    config: VeraConfig,
): readonly ProviderDescriptor[] {
    return configuredProviders(config).filter((provider) =>
        provider.protocol === "openai-chat"
        && provider.behaviorId === undefined
        && provider.discovery?.mode === "models"
    );
}

async function standardProviderModels(
    descriptor: ProviderDescriptor | undefined,
    config: VeraConfig,
    authStorage: Pick<AuthStorage, "getCredential">,
    options: { readonly cacheDir?: string; readonly maxAgeMs: number },
): Promise<StandardProviderModelsResult> {
    if (
        descriptor === undefined
        || descriptor.baseUrl === undefined
        || descriptor.discovery === undefined
    ) {
        return { models: [], failure: "invalid" };
    }
    const key = descriptor.discovery.credential === "none"
        ? undefined
        : apiKey(authStorage, descriptor.id)
            ?? (descriptor.envVar === undefined
                ? undefined
                : process.env[descriptor.envVar]);
    if (
        descriptor.discovery.credential === "required"
        && key === undefined
    ) {
        return { models: [], failure: "missing_credential" };
    }
    const catalog = await refreshOpenAIProviderCatalog({
        provider: descriptor.id,
        baseUrl: descriptor.baseUrl,
        ...(key === undefined ? {} : { apiKey: key }),
        ...(descriptor.discovery.credential === "required"
            ? {}
            : { preserveEmpty: true }),
        catalogLayers: descriptor.compatibility?.catalog ?? [],
        endpoint: standardProviderDiscoveryEndpoint(descriptor),
        ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
        maxAgeMs: options.maxAgeMs,
    });
    const models = providerCatalog(catalog)?.models.map((model) => ({
        provider: descriptor.id,
        model: model.id,
        label: model.label,
        description: model.description ?? "",
        ...(model.context_window === undefined ? {} : { contextWindow: model.context_window }),
    })) ?? [];
    return {
        models,
        ...standardProviderFailure(catalog),
    };
}

interface StandardProviderModelsResult {
    readonly models: readonly SuggestedModel[];
    readonly failure?: CatalogRefreshFailure;
}

function providerCatalog(
    result: ProviderCatalogRefreshResult,
) {
    return result.status === "failed" ? undefined : result.catalog;
}

function standardProviderFailure(
    result: ProviderCatalogRefreshResult,
): { readonly failure?: CatalogRefreshFailure } {
    if (result.status === "stale" || result.status === "failed") {
        return { failure: result.failure };
    }
    return result.status === "persistence_failed"
        ? { failure: "persistence_failed" }
        : {};
}

export function standardProviderDiscoveryEndpoint(
    descriptor: ProviderDescriptor,
): string {
    const discovery = descriptor.discovery!;
    const baseUrl = descriptor.endpointOverridden === true
        ? descriptor.baseUrl!
        : discovery.baseUrl ?? descriptor.baseUrl!;
    const path = descriptor.endpointOverridden === true
        ? discovery.endpointOverridePath ?? discovery.path
        : discovery.path;
    return providerEndpointUrl(baseUrl, path);
}

export function withProviderRows(
    models: readonly SuggestedModel[],
    provider: string,
    rows: readonly SuggestedModel[],
): readonly SuggestedModel[] {
    if (rows.length === 0) {
        return models;
    }
    const named = new Set(rows.map((row) => row.model));
    const others = models.filter((model) =>
        model.provider !== provider
        || (model.description === "configured model" && !named.has(model.model))
    );
    return [...others, ...rows];
}

async function discoverAvailableModels(
    config: VeraConfig,
    authStorage: AuthStorage,
    maxAgeMs = catalogMaxAgeMs(config),
): Promise<readonly SuggestedModel[]> {
    const catalog = catalogModels(config);
    const [ollama, openrouter, standard] = await Promise.all([
        discoveredOllamaModels({
            log: hostLog,
            ...(config.provider_endpoints?.ollama === undefined
                ? {}
                : { host: config.provider_endpoints.ollama }),
        }),
        discoveredOpenRouterModels(config, { maxAgeMs }),
        Promise.all(standardProviderDescriptors(config).map((descriptor) =>
            standardProviderModels(descriptor, config, authStorage, { maxAgeMs })
        )),
        refreshWebDevArena({ maxAgeMs }).catch(() => undefined),
    ]);
    catalog.push(...ollama);
    catalog.push(...standard.flatMap((result) => result.models));
    if (openrouter.length > 0) {
        for (let index = catalog.length - 1; index >= 0; index -= 1) {
            if (catalog[index]!.provider === "openrouter") {
                catalog.splice(index, 1);
            }
        }
        catalog.push(...openrouter);
    }
    catalog.push(...discoveredDeepSeekModels(config, { authStorage }));
    catalog.push(...discoveredCodexModels(config));
    catalog.push(...cachedProviderModels(
        configuredProviders(config).map((provider) => provider.id),
        catalog,
    ));
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
    return withProviderRefreshability(
        withCachedWindows(catalog, readCachedWindowIndex()),
        config,
    );
}

function withProviderRefreshability(
    models: readonly SuggestedModel[],
    config: VeraConfig,
): readonly SuggestedModel[] {
    return models.map((model) =>
        isRefreshableProvider(model.provider, config)
            ? { ...model, refreshable: true }
            : model.refreshable === undefined
                ? model
                : { ...model, refreshable: undefined }
    );
}

export interface CerebrasDiscoveryOptions {
    readonly authStorage?: Pick<AuthStorage, "getCredential">;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly cacheDir?: string;
    readonly maxAgeMs?: number;
}

function hasCerebrasCredential(
    config: VeraConfig,
    authStorage?: Pick<AuthStorage, "getCredential">,
): boolean {
    return config.provider === "cerebras"
        || hasProviderCredential("cerebras", authStorage)
        || Boolean(process.env.CEREBRAS_API_KEY);
}

export async function discoveredCerebrasModels(
    config: VeraConfig,
    options: CerebrasDiscoveryOptions = {},
): Promise<readonly SuggestedModel[]> {
    if (!hasCerebrasCredential(config, options.authStorage)) {
        return [];
    }
    const cacheOptions = options.cacheDir === undefined
        ? {}
        : { cacheDir: options.cacheDir };
    const remembered = readFreshProviderCatalogSnapshot(
        "cerebras",
        options.maxAgeMs ?? 0,
        cacheOptions,
    );
    if (remembered !== undefined) {
        return remembered.models.map(cerebrasSuggestion);
    }
    try {
        const fetchImplementation = options.fetch ?? globalThis.fetch;
        const moved = config.provider_endpoints?.cerebras;
        const response = await fetchImplementation(
            moved === undefined
                ? "https://api.cerebras.ai/public/v1/models"
                : providerEndpointUrl(moved, "/models"),
            { signal: AbortSignal.timeout(2_000) },
        );
        if (!response.ok) return staleCerebrasModels(cacheOptions);
        const models = cerebrasModels(await response.json());
        if (models.length === 0) return staleCerebrasModels(cacheOptions);
        rememberCerebrasModels(models, cacheOptions);
        return models;
    } catch {
        return staleCerebrasModels(cacheOptions);
    }
}

function staleCerebrasModels(
    cacheOptions: { readonly cacheDir?: string },
): readonly SuggestedModel[] {
    return readProviderCatalogSnapshot("cerebras", cacheOptions)
        .models
        .map(cerebrasSuggestion);
}

function rememberCerebrasModels(
    models: readonly SuggestedModel[],
    cacheOptions: { readonly cacheDir?: string },
): void {
    try {
        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "cerebras",
            fetched_at: new Date().toISOString(),
            models: models.map((model) => ({
                id: model.model,
                label: model.label,
                ...(model.description === ""
                    ? {}
                    : { description: model.description }),
                ...(model.contextWindow === undefined
                    ? {}
                    : { context_window: model.contextWindow }),
                levels: [],
            })),
        }, cacheOptions);
    } catch {
    }
}

function cerebrasSuggestion(model: CatalogModel): SuggestedModel {
    return {
        provider: "cerebras",
        model: model.id,
        label: model.label,
        description: model.description ?? "",
        ...(model.context_window === undefined
            ? {}
            : { contextWindow: model.context_window }),
    };
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

export interface CodexDiscoveryOptions extends CodexCatalogRefreshOptions {
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

export interface OllamaDiscoveryResult {
    readonly available: boolean;
    readonly models: readonly SuggestedModel[];
}

/** An Ollama that is not running must not delay startup or empty the picker. */
export async function discoveredOllamaModels(
    options: OllamaDiscoveryOptions = {},
): Promise<readonly SuggestedModel[]> {
    return (await discoverOllamaModelCatalog(options)).models;
}

export async function discoverOllamaModelCatalog(
    options: OllamaDiscoveryOptions = {},
): Promise<OllamaDiscoveryResult> {
    const host = normalizeOllamaHost(
        options.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    );
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
            return { available: false, models: [] };
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
        return { available: false, models: [] };
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
            ...(capabilities.includes("thinking") ? { thinking_support: true } : {}),
            levels: [],
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
        // The snapshot enriches the picker; failing to record it must not block startup.
        log({
            type: "ollama_catalog_write_failed",
            reason: error instanceof Error ? error.message : String(error),
        });
    }
    return { available: true, models };
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

export interface OmlxDiscoveryOptions {
    readonly baseUrl?: string;
    readonly apiKey?: string;
    readonly cacheDir?: string;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly log?: HostLog;
}

export interface OmlxDiscoveryResult {
    readonly available: boolean;
    readonly models: readonly SuggestedModel[];
}

const DEFAULT_OMLX_BASE_URL = "http://127.0.0.1:8000/v1";

function omlxDiscoveryAuth(
    authStorage: Pick<AuthStorage, "getCredential">,
): { apiKey?: string } {
    const stored = apiKey(authStorage, "omlx");
    const value = stored !== undefined && stored.length > 0
        ? stored
        : process.env.OMLX_API_KEY;
    return value === undefined ? {} : { apiKey: value };
}

export async function discoveredOmlxModels(
    options: OmlxDiscoveryOptions = {},
): Promise<readonly SuggestedModel[]> {
    return (await discoverOmlxModelCatalog(options)).models;
}

export async function discoverOmlxModelCatalog(
    options: OmlxDiscoveryOptions = {},
): Promise<OmlxDiscoveryResult> {
    const baseUrl = options.baseUrl ?? DEFAULT_OMLX_BASE_URL;
    const endpoint = providerEndpointUrl(baseUrl, "/models");
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const log = options.log ?? (() => {});
    let entries: readonly {
        readonly id?: unknown;
        readonly max_model_len?: unknown;
    }[];
    try {
        const response = await fetchImplementation(endpoint, {
            ...(options.apiKey === undefined
                ? {}
                : { headers: { authorization: `Bearer ${options.apiKey}` } }),
            signal: AbortSignal.timeout(750),
        });
        if (!response.ok) {
            log({
                type: "omlx_discovery_unavailable",
                endpoint,
                reason: `HTTP ${response.status}`,
            });
            return { available: false, models: [] };
        }
        const body = await response.json() as { data?: unknown };
        if (!Array.isArray(body.data)) {
            throw new Error("response did not contain a model list");
        }
        entries = body.data.filter(isOmlxModelEntry);
    } catch (error) {
        log({
            type: "omlx_discovery_unavailable",
            endpoint,
            reason: error instanceof Error ? error.message : String(error),
        });
        return { available: false, models: [] };
    }

    const models = entries.flatMap((entry) => {
        if (typeof entry.id !== "string" || entry.id.length === 0) {
            return [];
        }
        const contextWindow = positiveModelLength(entry.max_model_len);
        return [{
            provider: "omlx",
            model: entry.id,
            label: entry.id,
            description: "served locally",
            ...(contextWindow === undefined ? {} : { contextWindow }),
        }];
    });
    log({
        type: "omlx_discovery_listed",
        endpoint,
        models: models.map((model) => model.model),
    });
    try {
        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "omlx",
            fetched_at: new Date().toISOString(),
            models: models.map((model) => ({
                id: model.model,
                label: model.label,
                description: model.description,
                ...(model.contextWindow === undefined
                    ? {}
                    : { context_window: model.contextWindow }),
                levels: [],
            })),
        }, options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir });
        log({
            type: "omlx_catalog_written",
            models: models.map((model) => model.model),
        });
    } catch (error) {
        log({
            type: "omlx_catalog_write_failed",
            reason: error instanceof Error ? error.message : String(error),
        });
    }
    return { available: true, models };
}

function isOmlxModelEntry(value: unknown): value is {
    readonly id?: unknown;
    readonly max_model_len?: unknown;
} {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveModelLength(value: unknown): number | undefined {
    return Number.isSafeInteger(value) && (value as number) > 0
        ? value as number
        : undefined;
}

export function configuredCatalog(config: VeraConfig): readonly SuggestedModel[] {
    const catalog = catalogModels(config);
    const complete = catalog.some((item) =>
        item.provider === config.provider && item.model === config.model
    )
        ? catalog
        : [{
            provider: config.provider,
            model: config.model,
            label: config.model,
            description: "configured model",
        }, ...catalog];
    return withCachedWindows(complete, readCachedWindowIndex());
}

function catalogModels(config: VeraConfig): SuggestedModel[] {
    const models = [...availableModels()].filter((model) =>
        model.provider !== "openrouter"
        || hasOpenRouterCredential(config)
    );
    const seen = new Set(models.map((model) => `${model.provider}/${model.model}`));
    for (const configured of config.models ?? []) {
        const id = `${configured.provider}/${configured.model}`;
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({
            provider: configured.provider,
            model: configured.model,
            label: configured.name,
            description: "configured model",
        });
    }
    return models;
}

export interface DeepSeekDiscoveryOptions {
    readonly authStorage?: Pick<AuthStorage, "getCredential">;
    readonly cacheDir?: string;
}

export function discoveredDeepSeekModels(
    config: VeraConfig,
    options: DeepSeekDiscoveryOptions = {},
): readonly SuggestedModel[] {
    if (!hasDeepSeekCredential(config, options.authStorage)) {
        return [];
    }
    const catalog = refreshDeepSeekCatalog(options);
    return catalog.models.map((model) => ({
        provider: "deepseek",
        model: model.id,
        label: model.label,
        description: model.description ?? "",
        ...(model.context_window === undefined
            ? {}
            : { contextWindow: model.context_window }),
    }));
}

function hasDeepSeekCredential(
    config: VeraConfig,
    authStorage?: Pick<AuthStorage, "getCredential">,
): boolean {
    return config.provider === "deepseek"
        || hasProviderCredential("deepseek", authStorage)
        || Boolean(process.env.DEEPSEEK_API_KEY);
}

function refreshDynamicAvailableModels(
    models: readonly SuggestedModel[],
    config: VeraConfig,
    authStorage: AuthStorage,
): readonly SuggestedModel[] {
    const withoutDeepSeek = models.filter((model) => model.provider !== "deepseek");
    const deepSeek = discoveredDeepSeekModels(config, { authStorage });
    const refreshed = config.provider !== "deepseek"
            || deepSeek.some((model) => model.model === config.model)
        ? [...withoutDeepSeek, ...deepSeek]
        : [
            ...withoutDeepSeek,
            ...deepSeek,
            {
                provider: config.provider,
                model: config.model,
                label: config.model,
                description: "configured model",
            },
        ];
    return withProviderRefreshability(refreshed, config);
}

function hasOpenRouterCredential(config: VeraConfig): boolean {
    return config.provider === "openrouter"
        || Boolean(process.env.OPENROUTER_API_KEY);
}

export interface OpenRouterDiscoveryOptions
    extends OpenRouterCatalogRefreshOptions {}

export async function discoveredOpenRouterModels(
    config: VeraConfig,
    options: OpenRouterDiscoveryOptions = {},
): Promise<readonly SuggestedModel[]> {
    if (!hasOpenRouterCredential(config)) {
        return [];
    }
    const moved = config.provider_endpoints?.openrouter;
    const catalog = await refreshOpenRouterCatalog(
        moved === undefined || options.endpoint !== undefined
            ? options
            : { ...options, endpoint: providerEndpointUrl(moved, "/models") },
    );
    if (catalog === undefined) {
        return [];
    }
    const hidden = reduceModels(catalog.models, {
        now: Math.floor(Date.now() / 1000),
        ...(config.model_picker_collapse_versions === true
            ? { collapseVersions: true }
            : {}),
        ...(config.model_picker_max_age_months === undefined
            ? {}
            : { maxAgeMonths: config.model_picker_max_age_months }),
        keep: new Set(
            catalog.models
                .filter((model) => model.recommended === true)
                .map((model) => model.id),
        ),
    });
    return catalog.models.map((model) => ({
        provider: "openrouter",
        model: model.id,
        label: model.label,
        description: model.description ?? "",
        ...(model.context_window === undefined
            ? {}
            : { contextWindow: model.context_window }),
        ...(model.created === undefined ? {} : { created: model.created }),
        ...(hidden.has(model.id)
            ? { hiddenByDefault: hidden.get(model.id) }
            : {}),
    }));
}

async function resumeOrFind(
    registry: AgentRegistry,
    sessionPath: string,
    inFlight: Map<string, Promise<ResidentAgent>> = new Map(),
): Promise<ResidentAgent> {
    const canonicalPath = await realpath(sessionPath);
    for (const summary of registry.list()) {
        let existingPath = summary.session_path;
        if (existingPath !== canonicalPath) {
            existingPath = await realpath(existingPath).catch(() => existingPath);
        }
        if (existingPath === canonicalPath) {
            const agent = registry.find(summary.id);
            if (agent !== undefined) {
                return agent;
            }
        }
    }
    const restoring = inFlight.get(canonicalPath);
    if (restoring !== undefined) return restoring;
    const resumed = registry.resume({ sessionPath: canonicalPath });
    inFlight.set(canonicalPath, resumed);
    try {
        return await resumed;
    } finally {
        inFlight.delete(canonicalPath);
    }
}

async function findOrRestoreAgent(
    registry: AgentRegistry,
    agentId: string,
    sessionDirectory: string,
    storedSessions: Promise<ReadonlyMap<string, RegisteredAgentSummary>>,
    resume: (sessionPath: string) => Promise<ResidentAgent>,
): Promise<ResidentAgent | undefined> {
    const existing = registry.find(agentId);
    if (existing !== undefined) return existing;
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return undefined;
    const conventionalPath = join(sessionDirectory, `${agentId}.jsonl`);
    try {
        return await resume(conventionalPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const indexed = (await storedSessions).get(agentId);
    return indexed === undefined ? undefined : resume(indexed.session_path);
}

async function storedSessionExists(
    agentId: string,
    sessionDirectory: string,
    index: ReadonlyMap<string, RegisteredAgentSummary>,
): Promise<boolean> {
    return (await storedSessionPath(agentId, sessionDirectory, index))
        !== undefined;
}

async function storedSessionPath(
    agentId: string,
    sessionDirectory: string,
    index: ReadonlyMap<string, RegisteredAgentSummary>,
): Promise<string | undefined> {
    const indexed = index.get(agentId)?.session_path;
    if (indexed !== undefined) return indexed;
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
        return undefined;
    }
    const conventional = join(sessionDirectory, `${agentId}.jsonl`);
    try {
        return (await stat(conventional)).isFile() ? conventional : undefined;
    } catch {
        return undefined;
    }
}

async function indexStoredSessions(
    sessionDirectory: string,
    sessions = new Map<string, RegisteredAgentSummary>(),
): Promise<ReadonlyMap<string, RegisteredAgentSummary>> {
    let names: readonly string[];
    try {
        names = await readdir(sessionDirectory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            hostLog({
                type: "session_index_failed",
                message: error instanceof Error ? error.message : String(error),
            });
        }
        return sessions;
    }
    for (const name of names.filter((value) => value.endsWith(".jsonl")).sort()) {
        await indexStoredSession(join(sessionDirectory, name), sessions);
    }
    return sessions;
}

export async function indexStoredSession(
    path: string,
    sessions: Map<string, RegisteredAgentSummary>,
): Promise<void> {
    try {
        const metadata = await readSessionIndexMetadata(path);
        const header = metadata.header;
        const fileStat = await stat(path).catch(() => undefined);
        const size = fileStat?.size;
        sessions.set(header.id, {
            id: header.id,
            workspace: header.cwd,
            session_path: path,
            kind: header.delegation?.kind === "subagent"
                ? "background"
                : "interactive",
            status: "completed",
            live: false,
            updated_at: fileStat?.mtime.toISOString() ?? header.timestamp,
            created_at: header.timestamp,
            ...(metadata.title === undefined
                ? {}
                : { title: metadata.title.slice(0, 80) }),
            has_user_content: metadata.hasUserContent,
            ...(header.origin === undefined
                ? {}
                : { forked_from: header.origin.sessionId }),
            ...(header.delegation?.parentId === undefined
                    && header.parentId === undefined
                ? {}
                : {
                    parent_id: header.delegation?.parentId ?? header.parentId,
                }),
            ...(size === undefined ? {} : { size_bytes: size }),
        });
    } catch {
        // A corrupt unopened session cannot block healthy lazy resumes.
    }
}

async function enrichSessionsWithFacts(
    sessions: readonly RegisteredAgentSummary[],
    include: readonly SessionFactName[],
    ledgerPath: string,
): Promise<readonly RegisteredAgentSummary[]> {
    const failures = include.includes("failure")
        ? latestFailureBySession(readModelFailures(ledgerPath))
        : undefined;
    return await Promise.all(sessions.map(async (session) => {
        const facts = await readSessionFacts(session.session_path, {
            include,
            capacity: (provider, model) =>
                contextWindowForModel(provider, model),
        });
        const failure = failures?.get(session.id);
        const merged: SessionFacts = {
            ...facts,
            ...(failure === undefined ? {} : { failure }),
        };
        return Object.keys(merged).length === 0
            ? session
            : { ...session, facts: merged };
    }));
}

function mergeStoredAndResidentAgents(
    stored: ReadonlyMap<string, RegisteredAgentSummary>,
    resident: readonly RegisteredAgentSummary[],
): RegisteredAgentSummary[] {
    const merged = new Map(stored);
    for (const agent of resident) merged.set(agent.id, agent);
    return [...merged.values()].sort((left, right) =>
        left.id.localeCompare(right.id)
    );
}

async function closeResidentHost(
    server: HostServer,
    registry: AgentRegistry,
    extensions: ExtensionRegistry,
    closeInbox: () => void | Promise<void> = () => {},
    closeSidecars: () => void | Promise<void> = () => {},
): Promise<void> {
    try {
        await closeSidecars();
    } finally {
        await closeServerAndRest(server, registry, extensions, closeInbox);
    }
}

async function closeServerAndRest(
    server: HostServer,
    registry: AgentRegistry,
    extensions: ExtensionRegistry,
    closeInbox: () => void | Promise<void>,
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

function registerConfiguredHooks(hooks: ToolHooks, config: VeraConfig): void {
    for (const spec of config.hooks ?? []) {
        const hook = createCommandHook({
            phase: spec.phase,
            argv: spec.argv,
            ...(spec.protocol === undefined ? {} : { protocol: spec.protocol }),
            ...(spec.timeout_ms === undefined
                ? {}
                : { timeoutMs: spec.timeout_ms }),
        });
        if (spec.phase === "session_start") {
            hooks.registerSessionStart(hook as SessionStartHook);
        } else if (spec.phase === "pre_tool_use") {
            hooks.registerPreToolUse(hook as PreToolUseHook);
        } else {
            hooks.registerPostToolUse(hook as PostToolUseHook);
        }
    }
}

const WORKER_ADAPTER_MODULE = fileURLToPath(
    new URL("./worker/adapter.ts", import.meta.url),
);

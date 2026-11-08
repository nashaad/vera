import { join, resolve } from "node:path";
import { configuredModelAssignments as modelOperationAssignments } from "../config.ts";
import { derivedModelName } from "../config/model-catalog.ts";
import { effectiveCatalog } from "../model/catalog.ts";
import { applyModelOperation } from "../model/model-operations.ts";
import { connectedProviderCatalogs, modelsFromConnectedCatalogs } from "../providers/catalog-state.ts";
import { forgetProviderConnection } from "../providers/forget-provider.ts";
import { readModelCatalog } from "../providers/read-model-catalog.ts";

import {
    createLiveVeraConfigReader,
    defaultVeraConfigPath,
    overridePatchDefaults,
    updateVeraConfigDefaults,
    type VeraConfig,
    type VeraProviderId,
} from "../config.ts";
import { eventLogRoot } from "../engine/events.ts";
import { availableModels } from "../engine/model-settings.ts";
import {
    cachedProviderModels,
    readCachedWindowIndex,
    withCachedWindows,
} from "../model/cached-windows.ts";
import {
    DEFAULT_CATALOG_MAX_AGE_MS,
    providerCatalogCacheDir,
    readFreshProviderCatalogSnapshot,
    readProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
} from "../model/catalog-cache.ts";
import { reduceModels } from "../model/catalog-reduction.ts";
import type {
    CatalogModel,
} from "../model/catalog-shape.ts";
import { pooledModels } from "../model/catalog-view.ts";
import { isRefreshableProvider } from "../model/refreshable-providers.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import type { ModelAdapter } from "../model/types.ts";
import { readWebDevArenaSnapshot, refreshWebDevArena } from "../model/webdev-arena.ts";
import { selectedVeraHome, VERA_HOME_ENV, veraBlockedDirectory, veraMachineDirectoryIn } from "../profile-paths.ts";
import { createRequestOptionsSnapshotAdapter } from "../providers/routing.ts";
import { thisProcessBuildId } from "../release/stamp.ts";
import { defaultModelFailureLedgerPath } from "../store/model-failures.ts";
import {
    appendRestartRecord,
    clearRestartRecordsForSession,
    defaultRestartRecordPath,
    listRestartRecords,
    type RestartRecord,
} from "../store/restart-records.ts";
import {
    HOST_CAPABILITIES,
} from "./capabilities.ts";
import { createHostLogger, defaultHostLogPath, type HostLog } from "./host-log.ts";
import { defaultHostLockPath, defaultHostSocketPath } from "./lockfile.ts";
import {
    LOG_PRUNE_INTERVAL_MS,
    logMaxAgeMs,
    openSidecarLogPaths,
    pruneLogs,
} from "./log-retention.ts";
import { recoverCrashedTurns } from "./restart-scan.ts";
import { checkpointOpenStores } from "./store-checkpoint.ts";

import {
    type ExtensionRegistry,
    type ExtensionRegistryFailure,
} from "../extensions/registry.ts";
import { poolReachability } from "../model/assignment-reachability.ts";
import {
    CodexCatalogError,
    fetchCodexCatalog,
    readCodexCatalog,
} from "../model/codex-catalog.ts";
import { curatedCachePath, startCuratedRefresh } from "../model/curated-models.ts";
import {
    refreshDeepSeekCatalog,
} from "../model/deepseek-catalog.ts";
import { createPoolEffortPool } from "../model/effort-pool.ts";
import { createFeedRowReader } from "../model/feed-cache.ts";
import {
    refreshOpenAIProviderCatalog,
    type ProviderCatalogFailure,
    type ProviderCatalogRefreshResult,
} from "../model/openai-discovery.ts";
import {
    normalizeOpenRouterModels,
    refreshOpenRouterCatalog,
    type OpenRouterCatalogRefreshOptions,
} from "../model/openrouter-catalog.ts";
import { admitToPool } from "../model/pool-admission.ts";
import { loadPoolFile } from "../model/pool-file-loader.ts";
import {
    movePoolModel,
    namePoolModel,
    PoolFileWriteRefusedError,
    readUserPoolFile,
    setPoolMembership,
} from "../model/pool-file-store.ts";
import { migrateConfigPool } from "../model/pool-migration.ts";
import { poolNameRefusal } from "../model/pool-names.ts";
import {
    apiKey,
    createAuthStorage,
    defaultAuthStoragePath,
    type AuthStorage,
} from "../providers/auth-storage.ts";
import { providerEndpointUrl } from "../providers/endpoint-url.ts";
import { normalizeOllamaHost } from "../providers/ollama-openai.ts";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-codex-oauth.ts";
import {
    configuredProviders,
    type ProviderDescriptor,
} from "../providers/registry.ts";
import { prepareStopForTarget, updateTargetProblem } from "../release/handoff.ts";
import {
    startSchedulerRuntime,
    type SchedulerRuntime,
} from "../scheduler/runtime.ts";
import { defaultSchedulePath, ScheduleStore } from "../scheduler/store.ts";
import {
    SCHEDULER_SOURCE,
    type EmittedScheduleRun,
} from "../scheduler/types.ts";
import {
    type ImportRoots,
} from "../session-import/discover.ts";
import { rememberSkillSettings } from "../skills/sources.ts";
import { defaultInboxPath, Inbox } from "../store/inbox.ts";
import { defaultSessionDirectory } from "../store/session-store.ts";
import type { WatchSecretResolver } from "../watch/arc-connector.ts";
import {
    startWatchRuntimeIfConfigured,
    type WatchRuntime,
} from "../watch/runtime.ts";
import type { WatchConnector } from "../watch/source.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { startAnnexProcess, type AnnexProcess } from "./annex-process.ts";
import { readArcNodeId, readArcToken } from "./arc-identity.ts";
import { createConsumerRegistry } from "./consumers.ts";
import { InboxAdmissionPolicy } from "./inbox-admission.ts";
import { InboxDeliveryCoordinator } from "./inbox-delivery.ts";
import type { SpawnSessionFn } from "./inbox-spawn.ts";
import type { CatalogRefreshOutcome } from "./protocol.ts";
import { startHostServer, type HostServer } from "./server.ts";
import type { SessionArtifacts } from "./session-trash.ts";
import {
    startSidecarRuntimeIfNeeded,
    type SidecarRuntime,
} from "./sidecar-runtime.ts";
import { StartupFindings } from "./startup-findings.ts";
import { StopWhenIdle, type StopWaitTarget } from "./stop-when-idle.ts";
import { subagentPoolPolicy } from "./subagent-policy.ts";

import { startSessionHost, type SessionHost } from "./session-host.ts";
export { indexStoredSession } from "./session-host/storage.ts";

const MAX_SCHEDULE_WORK_ROWS = 50;

export interface StartResidentHostOptions {
    readonly config: VeraConfig;
    // The Vera home itself, not the user's home. Every unset path below stays under it.
    readonly home?: string;
    // Where Claude Code and Codex keep their sessions. Read, never written.
    readonly importRoots?: ImportRoots;
    readonly configPath?: string;
    readonly createAdapter?: () => ModelAdapter;
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    readonly buildId?: string;
    readonly projectRoot?: string;
    readonly sessionDirectory?: string;
    readonly blockedDirectory?: string;
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
    // Catalog requests only; model turns keep their own adapters.
    readonly catalogFetch?: typeof globalThis.fetch;
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
    const selectedHome = options.home
        ?? process.env[VERA_HOME_ENV]?.trim();
    if (
        (selectedHome === undefined || selectedHome.length === 0)
        && overridesHomeState(options)
    ) {
        throw new Error(
            "startResidentHost was given explicit paths but no home. Pass `home` or set VERA_HOME so every path comes from one home.",
        );
    }
    const home = selectedVeraHome(options.home);
    const logDirectory = eventLogRoot(home);
    const hostLog = createHostLogger({ path: defaultHostLogPath(home) });
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
    // The config as it stands on disk, not as it stood when the host came up. Every setting below is read through this, so changing one in the settings pane reaches a session.
    const configPath = options.configPath ?? defaultVeraConfigPath(home);
    const poolPath = options.home === undefined
        ? undefined
        : join(home, "pool.json");
    const migration = migrateConfigPool({
        configPath,
        ...(poolPath === undefined ? {} : { poolPath }),
    });
    if (migration.notice !== undefined) {
        hostLog({ type: "pool_migrated", message: migration.notice });
    }
    const currentConfig = createLiveVeraConfigReader(options.config, {
        path: configPath,
        ...(options.projectRoot === undefined
            ? {}
            : { projectRoot: options.projectRoot }),
    });
    rememberSkillSettings(options.projectRoot);
    const currentReachability = () => poolReachability(
        loadPoolFile(poolPath === undefined ? {} : { userPath: poolPath }).merged,
    );
    const cacheDirectory = providerCatalogCacheDir(home);
    const socketPath = options.socketPath
        ?? defaultHostSocketPath(home);
    const lockPath = options.lockPath ?? defaultHostLockPath(home);
    const restartRecordPath = defaultRestartRecordPath(home);
    const forgetRestartRecords = (sessionId: string): void => {
        try {
            clearRestartRecordsForSession(sessionId, restartRecordPath);
        } catch (error) {
            hostLog({
                type: "restart_records_clear_failed",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };
    const recordStopCut = (record: RestartRecord): void => {
        try {
            appendRestartRecord(record, restartRecordPath);
        } catch (error) {
            hostLog({
                type: "restart_record_write_failed",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };
    const modelFailureLedgerPath = options.modelFailureLedgerPath
        ?? defaultModelFailureLedgerPath(home);
    const sessionDirectory = options.sessionDirectory
        ?? defaultSessionDirectory(home);
    const sessionIdentityReservationRoot = options.sessionDirectory === undefined
        ? veraMachineDirectoryIn(home)
        : sessionDirectory;
    const eventLogDirectory = options.eventLogDirectory;
    const authStorage = options.authStorage
        ?? createAuthStorage({ path: defaultAuthStoragePath(home) });
    const discoversModelsAtStartup = options.createAdapter === undefined;
    let models = await timed("model_discovery", () =>
        discoversModelsAtStartup
            ? discoverAvailableModels(
                options.config,
                authStorage,
                hostLog,
                cacheDirectory,
            )
            : configuredCatalog(options.config, cacheDirectory)
    );
    let catalogRefreshes: Promise<void> = Promise.resolve();
    let webDevArenaRefresh: Promise<void> | undefined;
    // Arena scores are a nicety: the download runs on its own and tells sessions once it lands.
    const refreshWebDevArenaInBackground = (maxAgeMs: number): void => {
        if (webDevArenaRefresh !== undefined) return;
        const before = readWebDevArenaSnapshot(cacheDirectory)?.fetched_at;
        webDevArenaRefresh = refreshWebDevArena({
            maxAgeMs,
            cacheDir: cacheDirectory,
            ...(options.catalogFetch === undefined
                ? {}
                : { fetch: options.catalogFetch }),
        })
            .then((snapshot) => {
                if (snapshot === undefined || snapshot.fetched_at === before) {
                    return;
                }
                registry.notifyModelCatalogChanged();
            })
            .catch(() => undefined)
            .finally(() => {
                webDevArenaRefresh = undefined;
            });
    };
    const startupFindings = options.startupFindings ?? new StartupFindings();
    const blockedDirectory = options.blockedDirectory ?? veraBlockedDirectory(home);
    let inbox!: Inbox;
    let consumers: ReturnType<typeof createConsumerRegistry>;
    let inboxDelivery: InboxDeliveryCoordinator;
    let scheduleStore: ScheduleStore;
    let curatedRefresh: ReturnType<typeof startCuratedRefresh>;
    const workChangeListeners = new Set<() => void>();
    const notifyWorkChanged = (): void => {
        for (const listener of [...workChangeListeners]) {
            try {
                listener();
            } catch {
            }
        }
    };
    let watches: WatchRuntime | null = null;
    let scheduler: SchedulerRuntime | null = null;
    let sidecars: SidecarRuntime | null = null;
    let publishedSocketPath = socketPath;
    const closeSidecars = async (): Promise<void> => {
        curatedRefresh.close();
        await sidecars?.close();
        sidecars = null;
    };
    const closeInbox = async (): Promise<void> => {
        await watches?.close();
        await scheduler?.close();
        scheduleStore.close();
        inboxDelivery.close();
        inbox.close();
    };
    const stopWhenIdle: StopWhenIdle = new StopWhenIdle({
        waitingOn: (): readonly StopWaitTarget[] => registry.stopWaitTargets(),
        onStopped: () => closeHost(),
        targetProblem: updateTargetProblem,
        prepare: prepareStopForTarget,
        cutSession: (sessionId, reason) => registry.cutSessionForStop(sessionId, reason),
        recordCut: recordStopCut,
    });
    const recentScheduleRuns = (): readonly EmittedScheduleRun[] => {
        try {
            return scheduleStore.recentlyEmitted(MAX_SCHEDULE_WORK_ROWS);
        } catch {
            return [];
        }
    };
    const sessionHost = await startSessionHost({
        sessions: "all",
        config: options.config,
        home, configPath, cacheDirectory, currentConfig, currentReachability,
        sessionDirectory, sessionIdentityReservationRoot, blockedDirectory,
        modelFailureLedgerPath, authStorage, hostLog, startupLog, startupFindings, timed,
        permissionPreferencesPath: options.permissionPreferencesPath,
        eventLogDirectory,
        importRoots: options.importRoots,
        createAdapter: options.createAdapter,
        onExtensionFailure: options.onExtensionFailure,
        trashSessionArtifacts: options.trashSessionArtifacts,
        turnsHeld: () => stopWhenIdle.holdsTurns,
        inboxActorForSession: () => readArcNodeId(options.arcConfigPath),
        annexUrl: () => annexUrl,
        forgetRestartRecords,
        recentScheduleRuns,
        onWorkChanged: (listener) => {
            workChangeListeners.add(listener);
            return () => { workChangeListeners.delete(listener); };
        },
        createServices: (createAdapter) => {
            inbox = Inbox.open(
                options.inboxPath ?? defaultInboxPath(home),
            );
            consumers = createConsumerRegistry(inbox);
            inboxDelivery = new InboxDeliveryCoordinator(consumers, {
                admissionFor: (projectRoot) => projectRoot === undefined
                    ? undefined
                    : InboxAdmissionPolicy.fromConfig(
                        options.config,
                        projectRoot,
                        options.inboxUserConfigPath ?? configPath,
                    ),
            });
            scheduleStore = ScheduleStore.open(
                options.schedulePath ?? defaultSchedulePath(home),
            );
            curatedRefresh = startCuratedRefresh({
                path: curatedCachePath(home),
                ...(options.config.curated_models_url === undefined
                    ? {}
                    : { url: options.config.curated_models_url }),
            });
            const readFeedRow = createFeedRowReader(
                options.config.model_feed_url === undefined
                    ? {}
                    : { url: options.config.model_feed_url },
            );
            return {
                inboxDelivery,
                models: {
                    availableModels: models,
                    refreshAvailableModels: options.createAdapter === undefined
                        ? () => {
                            models = withProviderRefreshability(modelsFromConnectedCatalogs(currentConfig(), models, {
                                authStorage,
                                cacheDir: cacheDirectory,
                            }), currentConfig());
                            return models;
                        }
                        : undefined,
                    providerCatalogs: () => connectedProviderCatalogs(currentConfig(), { authStorage }),
                    refreshableProviders: () => {
                        const config = currentConfig();
                        return connectedProviderCatalogs(config, { authStorage })
                            .filter((provider) => isRefreshableProvider(provider.id, config)
                                || (provider.id === OPENAI_CODEX_PROVIDER_ID && hasCodexCredential(authStorage))
                                || configuredProviders(config).find((row) => row.id === provider.id)?.protocol === "anthropic-messages")
                            .map((provider) => provider.id);
                    },
                    refreshCatalog: (provider) => {
                        const refreshed = catalogRefreshes.then(async () => {
                            const config = currentConfig();
                            try {

                                const descriptor = configuredProviders(config)
                                    .find((entry) => entry.id === provider);
                                if (descriptor !== undefined && descriptor.baseUrl !== undefined && descriptor.protocol !== undefined
                                    && (descriptor.protocol === "anthropic-messages" || descriptor.behaviorId === "openrouter")) {
                                    const stored = authStorage.getCredential(provider);
                                    const key = stored?.type === "api_key" ? stored.key : descriptor.envVar === undefined ? undefined : process.env[descriptor.envVar];
                                    const catalog = await readModelCatalog({
                                        provider, baseUrl: descriptor.baseUrl, protocol: descriptor.protocol, apiKey: key,
                                        ...(descriptor.behaviorId === "openrouter" ? { normalize: normalizeOpenRouterModels } : {})
                                    })
                                        .catch(() => undefined);
                                    if (catalog === undefined) return undefined;
                                    writeProviderCatalogSnapshot(catalog, {
                                        cacheDir: cacheDirectory,
                                    });
                                    models = modelsFromConnectedCatalogs(config, models, {
                                        authStorage,
                                        cacheDir: cacheDirectory,
                                    });
                                    return models;
                                }
                                if (provider === OPENAI_CODEX_PROVIDER_ID) {
                                    if (!hasCodexCredential(authStorage)) return undefined;
                                    const outcome = await refreshCodexCatalog(authStorage, {
                                        log: hostLog,
                                        cacheDir: cacheDirectory,
                                        ...(options.catalogFetch === undefined ? {} : { fetch: options.catalogFetch }),
                                    });
                                    if (outcome?.failure !== undefined) return undefined;
                                    const rows = discoveredCodexModels(config, {
                                        authStorage,
                                        cacheDir: cacheDirectory,
                                    });
                                    models = withProviderRefreshability(
                                        replaceProviderRows(models, provider, rows),
                                        config,
                                    );
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
                                refreshWebDevArenaInBackground(0);
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
                    readPolicy: (projectRoot) => ({
                        ...subagentPoolPolicy({ ...scoped(projectRoot), config: currentConfig() }),
                        candidates: pooledModels(models, { ...scoped(projectRoot), includeUncurated: true }),
                    }),
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
                        }, hostLog);
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
                        }, hostLog);
                        return refused === undefined && named;
                    },
                    movePoolEntry: (entry, delta) => {
                        const id = `${entry.provider}/${entry.model}`;
                        let held = false;
                        const refused = refusedPoolWrite(() => {
                            held = Object.hasOwn(readUserPoolFile().models, id);
                            if (held) movePoolModel(id, delta);
                        }, hostLog);
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
                    writeReviewer: (settings) => {
                        if (settings === null || settings.models.length === 0) {
                            updateVeraConfigDefaults({
                                model_assignment: { assignment: "reviewer", binding: null },
                            });
                            return;
                        }
                        const defaultProvider = currentConfig().provider;
                        updateVeraConfigDefaults({
                            model_assignment: {
                                assignment: "reviewer",
                                binding: {
                                    models: settings.models.slice(0, 2).map((model) => {
                                        const provider = (model.provider ?? defaultProvider) as VeraProviderId;
                                        return {
                                            name: derivedModelName(provider, model.model),
                                            provider,
                                            model: model.model,
                                            ...(model.reasoningEffort === undefined
                                                ? {}
                                                : { reasoning_effort: model.reasoningEffort }),
                                        };
                                    }),
                                },
                            },
                        });
                    },
                    updateOverrides: (patch) => {
                        updateVeraConfigDefaults(overridePatchDefaults(patch));
                    },
                },
            };
        },
    });
    const { registry, extensions, createAdapter } = sessionHost;
    // Scores fill in after startup; discovery never waits for the arena download.
    if (discoversModelsAtStartup) {
        refreshWebDevArenaInBackground(catalogMaxAgeMs(options.config));
    }

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
    let closing: Promise<void> | undefined;
    let logPruneTimer: ReturnType<typeof setInterval> | undefined;
    let announceShutdown: () => void = () => {};
    const shutdownRequested = new Promise<void>((resolve) => {
        announceShutdown = resolve;
    });
    const closeHost = (): Promise<void> => {
        sessionHost.stopMaintenance();
        if (logPruneTimer !== undefined) {
            clearInterval(logPruneTimer);
            logPruneTimer = undefined;
        }
        if (closing === undefined) {
            announceShutdown();
            closing = (async () => {
                try {
                    await annex?.close();
                } finally {
                    await closeResidentHost(
                        server,
                        sessionHost,
                        closeInbox,
                        closeSidecars,
                    );
                }
            })();
        }
        return closing;
    };
    try {
        watches = startWatchRuntimeIfConfigured(inbox, {
            watches: extensions.contributions().watches(),
            ...(options.watchConnectors === undefined
                ? {}
                : { connectors: options.watchConnectors }),
            secret: options.watchSecret
                ?? (() => readArcToken(options.arcConfigPath)),
            onAppended: () => {
                void inboxDelivery.pumpAll();
            },
        });
        scheduler = await timed("scheduler", () =>
            startSchedulerRuntime({
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
        const providerGenerations = new Map<string, number>();
        server = await timed(
            "server_listen_and_lockfile",
            () => startHostServer({
                ...sessionHost.handlers,
                capabilities: HOST_CAPABILITIES,
                socketPath,
                lockPath,
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
                recoverPrevious: async () => {
                    try {
                        const scan = await recoverCrashedTurns({
                            lockPath,
                            sessionDirectory,
                            recordPath: restartRecordPath,
                        });
                        if (scan.recorded.length > 0) {
                            hostLog({
                                type: "restart_turns_recorded",
                                message: `${scan.recorded.length} session(s) had a turn open at the last exit`,
                            });
                        }
                    } catch (error) {
                        hostLog({
                            type: "restart_scan_failed",
                            message: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
                restartRecords: {
                    list: () => listRestartRecords(restartRecordPath),
                    dismiss: (sessionId) =>
                        clearRestartRecordsForSession(sessionId, restartRecordPath),
                },

                stopWhenIdle,
                forgetProvider: async (provider, workspace) => {
                    forgetProviderConnection(provider, authStorage);
                    providerGenerations.set(provider, (providerGenerations.get(provider) ?? 0) + 1);
                    await sessionHost.clearProviderSelection(provider);
                    return registry.readHostModelSettings(workspace);
                },
                operateModels: async (request, onResult, onStep) => {
                    const generations = new Map(request.models.map(({ provider }) =>
                        [provider, providerGenerations.get(provider) ?? 0]));
                    await applyModelOperation(request, {
                        isCurrent: ({ provider }) => generations.get(provider) === (providerGenerations.get(provider) ?? 0),
                        discovered: registry.modelsForClient(),
                        assignments: modelOperationAssignments(currentConfig()).map((slot) => ({ label: slot.label, models: slot.declared })),
                        createAdapter: (provider) => createAdapter(provider),
                        catalog: (provider, model) =>
                            effectiveCatalog(provider, { cacheDir: cacheDirectory })
                                .models.find((row) => row.id === model),
                        onResult,
                        onStep,
                    });
                    return registry.readHostModelSettings(request.workspace);
                },

                refreshCatalogs: () => {
                    const refreshed = catalogRefreshes.then(async () => {
                        const config = currentConfig();
                        refreshWebDevArenaInBackground(0);
                        const outcomes = await refreshProviderCatalogs(config, {
                            authStorage,
                            cacheDir: cacheDirectory,
                        });
                        models = await discoverAvailableModels(
                            config,
                            authStorage,
                            hostLog,
                            cacheDirectory,
                        );
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

                ...(scheduler === null ? {} : {
                    runScheduleOperation: (operation) => scheduler!.execute(operation),
                }),

                checkpointStores: async (destination) => checkpointOpenStores({
                    destination,
                    inbox,
                    schedules: scheduleStore,
                }),

                onShutdownAccepted: closeHost,

            }),
        );
        try {
            annex = await startAnnexProcess({
                home,
                hostSocketPath: server.socketPath,
                extensionDirectories: [
                    ...new Set(
                        extensions.contributions().pages().map(
                            (page) => page.extensionDirectory,
                        ),
                    ),
                ],
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
            if (annex.busyPort !== undefined) {
                hostLog({
                    type: "annex_port_busy",
                    wanted_port: annex.busyPort,
                    port: annex.port,
                });
            }
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
                ?? join(logDirectory, "sidecars"),
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
        sessionHost.startStorage();
    } catch (error) {
        try {
            await closeSidecars();
        } catch {
        }
        await sessionHost.closeAfterStartupFailure();
        await closeInbox();
        throw error;
    }

    const buildId = thisProcessBuildId();
    const pruneOldLogs = () => {
        void pruneLogs(logDirectory, {
            maxAgeMs: logMaxAgeMs(currentConfig()),
            keep: (path) => openSidecarLogPaths(sidecars?.statuses() ?? [])
                .has(resolve(path)),
        })
            .then((result) => {
                if (result.removedFiles === 0) return;
                hostLog({
                    type: "logs_pruned",
                    removed_files: result.removedFiles,
                    removed_bytes: result.removedBytes,
                });
            })
            .catch(() => {});
    };
    pruneOldLogs();
    logPruneTimer = setInterval(pruneOldLogs, LOG_PRUNE_INTERVAL_MS);
    logPruneTimer.unref();
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
    log: HostLog,
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
        log({ type: "pool_write_refused", message: error.message });
        return { verdict: "pool_write_refused", reason: error.message };
    }
}

// Explicit paths select parts of a home, so the rest needs the same home.
function overridesHomeState(options: StartResidentHostOptions): boolean {
    return options.configPath !== undefined
        || options.socketPath !== undefined
        || options.lockPath !== undefined
        || options.sessionDirectory !== undefined
        || options.permissionPreferencesPath !== undefined
        || options.eventLogDirectory !== undefined
        || options.modelFailureLedgerPath !== undefined
        || options.inboxPath !== undefined
        || options.schedulePath !== undefined
        || options.sidecarLogDirectory !== undefined
        || options.spawnConsentPath !== undefined;
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
    // Codex catalog requests only.
    readonly fetch?: typeof globalThis.fetch;
}

export async function refreshProviderCatalogs(
    config: VeraConfig,
    options: CatalogRefreshOptions = {},
): Promise<readonly CatalogRefreshOutcome[]> {
    const cacheOptions = options.cacheDir === undefined
        ? {}
        : { cacheDir: options.cacheDir };
    const authStorage = options.authStorage ?? createAuthStorage();
    const [ollama, openrouter, standard, codex] = await Promise.all([
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
        refreshCodexCatalog(authStorage, {
            ...cacheOptions,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
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
        ...(codex === undefined ? [] : [codex]),
    ];
}

// Signed out returns undefined: Codex is optional, unlike the configured providers.
export async function refreshCodexCatalog(
    authStorage: AuthStorage,
    options: {
        readonly cacheDir?: string;
        readonly fetch?: typeof globalThis.fetch;
        readonly log?: HostLog;
    },
): Promise<CatalogRefreshOutcome | undefined> {
    if (!hasCodexCredential(authStorage)) return undefined;
    const log = options.log ?? createHostLogger();
    try {
        const catalog = await fetchCodexCatalog({ authStorage, ...options });
        return { provider: OPENAI_CODEX_PROVIDER_ID, models: catalog.models.length };
    } catch (error) {
        const failure = error instanceof CodexCatalogError ? error.failure : "unavailable";
        log({
            type: "codex_catalog_refresh_failed",
            failure,
            message: error instanceof Error ? error.message : String(error),
        });
        const kept = readCodexCatalog(options.cacheDir).models.length;
        return { provider: OPENAI_CODEX_PROVIDER_ID, failure, ...(kept === 0 ? {} : { keptModels: kept }) };
    }
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
    log: HostLog,
    cacheDir?: string,
    maxAgeMs = catalogMaxAgeMs(config),
): Promise<readonly SuggestedModel[]> {
    const catalog = catalogModels(config);
    const cacheOptions = cacheDir === undefined ? {} : { cacheDir };
    const [ollama, openrouter, standard] = await Promise.all([
        discoveredOllamaModels({
            log,
            ...cacheOptions,
            ...(config.provider_endpoints?.ollama === undefined
                ? {}
                : { host: config.provider_endpoints.ollama }),
        }),
        discoveredOpenRouterModels(config, { ...cacheOptions, maxAgeMs }),
        Promise.all(standardProviderDescriptors(config).map((descriptor) =>
            standardProviderModels(descriptor, config, authStorage, {
                ...cacheOptions,
                maxAgeMs,
            })
        )),
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
    catalog.push(...discoveredDeepSeekModels(config, {
        authStorage,
        ...cacheOptions,
    }));
    catalog.push(...discoveredCodexModels(config, cacheOptions));
    catalog.push(...cachedProviderModels(
        configuredProviders(config).map((provider) => provider.id),
        catalog,
        cacheOptions,
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
        withCachedWindows(catalog, readCachedWindowIndex(cacheOptions)),
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

export interface CodexDiscoveryOptions {
    readonly authStorage?: AuthStorage;
    readonly cacheDir?: string;
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

    return readCodexCatalog(options.cacheDir).models.map((model) => ({
        provider: "openai-codex",
        model: model.id,
        label: model.label,
        description: model.description ?? "",
        ...(model.context_window === undefined
            ? {}
            : { contextWindow: model.context_window }),
    }));
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

export function configuredCatalog(
    config: VeraConfig,
    cacheDir?: string,
): readonly SuggestedModel[] {
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
    return withCachedWindows(
        complete,
        readCachedWindowIndex(cacheDir === undefined ? {} : { cacheDir }),
    );
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

async function closeResidentHost(
    server: HostServer,
    sessionHost: SessionHost,
    closeInbox: () => void | Promise<void> = () => {},
    closeSidecars: () => void | Promise<void> = () => {},
): Promise<void> {
    try {
        await closeSidecars();
    } finally {
        await closeServerAndRest(server, sessionHost, closeInbox);
    }
}

async function closeServerAndRest(
    server: HostServer,
    sessionHost: SessionHost,
    closeInbox: () => void | Promise<void>,
): Promise<void> {
    try {
        await server.close();
    } finally {
        try {
            await sessionHost.close();
        } finally {
            await closeInbox();
        }
    }
}

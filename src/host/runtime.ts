import { selectOnboardingModel } from "../providers/select-onboarding-model.ts";
import { createProviderSignInService } from "../providers/provider-sign-in.ts";
import { accessSync, constants, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { configuredModelAssignments as modelOperationAssignments } from "../config.ts";
import { derivedModelName } from "../config/model-catalog.ts";
import { effectiveCatalog } from "../model/catalog.ts";
import { applyModelOperation } from "../model/model-operations.ts";
import { connectedProviderCatalogs, modelsFromConnectedCatalogs } from "../providers/catalog-state.ts";
import { forgetProviderConnection } from "../providers/forget-provider.ts";
import { providerDisableRefusal } from "../providers/provider-disable-refusal.ts";
import { providerEnabled } from "../providers/provider-enabled.ts";
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
import { availableModels, type ModelTurnSettings, type OverrideSettingsPatch } from "../engine/model-settings.ts";
import type { ToolReviewerSettings } from "../engine/reviewer.ts";
import type { ApprovalMode } from "../sdk/permissions.ts";
import type { ManagedProcessObservationHandlers } from "../tools/process-runtime.ts";
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
import {
    modelAvailabilityRecordPath,
    selectedVeraHome,
    VERA_HOME_ENV,
    veraBlockedDirectory,
    veraMachineDirectoryIn,
} from "../profile-paths.ts";
import { sessionScratchRoot } from "../session-scratch.ts";
import { createRequestOptionsSnapshotAdapter } from "../providers/routing.ts";
import { thisProcessBuildId } from "../release/stamp.ts";
import { defaultModelFailureLedgerPath } from "../store/model-failures.ts";
import { fileReadStamp } from "../store/read-cache.ts";
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
import { createAsyncHostLogger, createHostLogger, defaultHostLogPath, type HostLog, type HostLogEntry } from "./host-log.ts";
import {
    CATALOG_SCAN_MIN_FIRST_DELAY_MS,
    startCatalogRefreshTimer,
    type CatalogRefreshTimer,
} from "./catalog-refresh-timer.ts";
import { fetchCodexCatalogAtStart } from "./codex-start-refresh.ts";
import { createHostLockfile, defaultHostLockPath, defaultHostSocketPath } from "./lockfile.ts";
import { startClientWatchdog, type ClientWatchdog } from "./client-watchdog.ts";
import { removeStoppedPoolLock } from "./pool/worker-records.ts";
import { hasInterruptedPoolScan } from "./pool/crash-scan.ts";
import { stopRecordedWorkers } from "./pool/stop-worker.ts";
import { RestartLedger } from "./pool/restart-ledger.ts";
import { acquireHostStartupClaim, type HostStartupClaim } from "./startup-claim.ts";
import { HostSocketHeldError } from "./server.ts";
import { inspectWorkerRecords, settleWorkerRecords, type WorkerRecordScan } from "./pool/worker-record.ts";
import { occupiedWorkerSockets, workerCountFromReconnect } from "./pool/worker-sockets.ts";
import {
    LOG_PRUNE_INTERVAL_MS,
    logMaxAgeMs,
    openSidecarLogPaths,
    pruneLogs,
} from "./log-retention.ts";
import {
    pruneScratch,
    SCRATCH_PRUNE_INTERVAL_MS,
    scratchMaxAgeMs,
} from "./scratch-retention.ts";
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
    type CodexCatalogAuthorization,
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
    refreshOpenRouterCatalogResult,
    type OpenRouterCatalogFailure,
    type OpenRouterCatalogRefreshOptions,
} from "../model/openrouter-catalog.ts";
import { admitToPool } from "../model/pool-admission.ts";
import {
    ModelAvailabilityStore,
    applyCatalogScan,
    trackedModels,
} from "../model/model-availability.ts";
import { loadPoolFile } from "../model/pool-file-loader.ts";
import type { PoolFile } from "../model/pool-file.ts";
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
    findConfiguredProvider,
    type ProviderDescriptor,
} from "../providers/registry.ts";
import { prepareStopForTarget, updateTargetProblem } from "../release/handoff.ts";
import {
    SchedulerRuntime,
    startSchedulerRuntime,
    type SchedulerRuntimeOptions,
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
import { defaultSessionDirectory, readSessionHeader } from "../store/session-store.ts";
import { withSessionReservation, type RestoringSessions } from "./session-host/storage.ts";
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
import { requestHostIdentity, type CatalogRefreshOutcome } from "./protocol.ts";
import { startHostServer, type HostServer } from "./server.ts";
import type { SessionArtifacts } from "./session-trash.ts";
import {
    startSidecarRuntimeIfNeeded,
    type SidecarRuntime,
} from "./sidecar-runtime.ts";
import { StartupFindings } from "./startup-findings.ts";
import { StopWhenIdle, type CompletedHostStop, type StopWaitTarget } from "./stop-when-idle.ts";
import { subagentPoolPolicy } from "./subagent-policy.ts";

import { startSessionHost, type SessionHost, type StartSessionHostOptions } from "./session-host.ts";
import type { SessionHostServices } from "./session-host/types.ts";
import { inProcessWorkerSocket, prepareInProcessWorker, type InProcessWorker } from "./pool/in-process.ts";
import type { SessionShard } from "./shard.ts";
import { prepareProcessWorker } from "./pool/process-worker.ts";
import { controlSocketPath } from "./pool/supervisor.ts";
import { cachedHostAuthStorage, createCredentialBroker } from "./pool/credentials.ts";
import type { GlobalChange } from "./pool/global-services.ts";
import type { WorkerGlobals } from "./pool/worker-globals.ts";
import type { WorkerExtensionServices } from "./pool/extension-catalog.ts";

// CRITICAL: the default is one session worker. Our load research measured one worker behind the host
// serving 100 sessions on under one core, while a larger pool used more CPU for the same throughput.
export const DEFAULT_SESSION_WORKERS = 1;
export { indexStoredSession } from "./session-host/storage.ts";

const MAX_SCHEDULE_WORK_ROWS = 50;

export interface StartResidentHostOptions {
    readonly config: VeraConfig;
    readonly onHostClaimed?: () => void | Promise<void>;
    readonly inProcessWorker?: boolean;
    readonly processWorker?: boolean;
    readonly processWorkerCount?: number;
    readonly processWorkerHeartbeatDeadlineMs?: number;
    readonly processWorkerHostGraceMs?: number;
    readonly skipStartupDiscovery?: boolean;
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
    // Tests point the Codex catalog at a fake endpoint.
    readonly codexCatalogBaseUrl?: string;
    // Shortens or re-clocks the daily catalog scan for tests.
    readonly catalogScan?: {
        readonly now?: () => number;
        readonly minDelayMs?: number;
        readonly intervalMs?: number;
    };
    readonly credentialFetch?: typeof globalThis.fetch;
}

export interface HostHealth {
    readonly annex: "ok" | "failed";
    readonly annexReason?: string;
    readonly workers?: readonly import("./pool/in-process.ts").WorkerHealth[];
}

export interface ResidentHost {
    readonly registry: AgentRegistry;
    readonly extensions: ExtensionRegistry;
    readonly server: HostServer;
    readonly shutdownRequested: Promise<void>;
    readonly shutdownCause?: () => HostShutdownCause;
    readonly health: HostHealth;
    readonly annexPid?: number;
    readonly buildId: string;
    readonly workerStopPids?: () => readonly number[];
    close(): Promise<void>;
}

export interface HostShutdownCause {
    readonly reason: CompletedHostStop["reason"] | "shutdown_if_idle" | "shutdown_for_replacement" | "shutdown_requested";
    readonly target_build_id?: string;
    readonly requester?: CompletedHostStop["requester"];
    readonly forced_by?: CompletedHostStop["forced_by"];
}

const activeResidentHostSockets = new Set<string>();

interface ResidentHostStartup {
    readonly claim: HostStartupClaim;
    readonly recovery: WorkerRecordScan;
    readonly interruptedScan: boolean;
    readonly settleRecovery: () => Promise<WorkerRecordScan>;
    readonly onClosed: () => void;
}

function hasWorkerRecovery(scan: WorkerRecordScan): boolean {
    return scan.recoverable.length > 0 || scan.stopped.length > 0 || scan.pending.length > 0 || scan.unrecorded.length > 0;
}

export async function startResidentHost(
    options: StartResidentHostOptions,
): Promise<ResidentHost> {
    requireHomeForOverrides(options);
    const home = selectedVeraHome(options.home);
    const socketPath = options.socketPath ?? defaultHostSocketPath(home);
    const lockPath = options.lockPath ?? defaultHostLockPath(home);
    const activeSocket = resolve(socketPath);
    if (activeResidentHostSockets.has(activeSocket)) throw new HostSocketHeldError(process.pid, socketPath, true);
    activeResidentHostSockets.add(activeSocket);
    let claim: HostStartupClaim | undefined;
    let started = false;
    try {
        claim = await acquireHostStartupClaim({ path: `${socketPath}.starting`, pid: options.pid });
        const diagnosis = await createHostLockfile({ path: lockPath, socketPath }).diagnose!();
        if (diagnosis.record !== undefined && !(diagnosis.wedged === true && diagnosis.record.pid === process.pid)) {
            throw new HostSocketHeldError(diagnosis.record.pid, socketPath, diagnosis.wedged !== true);
        }
        const answering = await requestHostIdentity(socketPath);
        if (answering !== undefined) throw new HostSocketHeldError(answering.pid, socketPath, true);
        const heartbeatDeadline = options.processWorkerHeartbeatDeadlineMs ?? 10_000;
        if (!Number.isFinite(heartbeatDeadline) || heartbeatDeadline <= 0) throw new Error("Invalid worker heartbeat deadline");
        const startupLog = options.startupLog ?? createHostLogger({ path: defaultHostLogPath(home) });
        const buildId = options.buildId ?? thisProcessBuildId();
        await options.onHostClaimed?.();
        const workers = await inspectWorkerRecords(home, buildId);
        const configuredCount = options.processWorkerCount ?? DEFAULT_SESSION_WORKERS;
        if (!Number.isSafeInteger(configuredCount) || configuredCount < 1) throw new Error("Invalid session worker count");
        let sockets = await occupiedWorkerSockets(home, configuredCount);
        const recorded = new Set([...workers.recoverable.map((worker) => worker.record.socket_path),
            ...workers.pending.map((worker) => worker.record.socket_path)]);
        let recovery: WorkerRecordScan = { ...workers, unrecorded: sockets.filter((socket) => !recorded.has(socket.path)) };
        if (recovery.unrecorded.length > 0 && recovery.stopped.length === 0) {
            recovery = { ...recovery, stopped: recovery.stale };
        }
        let resolved = options;
        if (hasWorkerRecovery(recovery)) {
            const count = workers.count ?? await workerCountFromReconnect(home, sockets, buildId) ?? configuredCount;
            sockets = await occupiedWorkerSockets(home, count);
            recovery = { ...recovery, unrecorded: sockets.filter((socket) => !recorded.has(socket.path)) };
            const changeMode = options.processWorker === false
                || (options.processWorker === true && count !== configuredCount);
            if (changeMode) {
                await stopRecordedWorkers(home);
                const remaining = await inspectWorkerRecords(home, buildId);
                const occupied = await occupiedWorkerSockets(home, remaining.count ?? configuredCount);
                if (remaining.recoverable.length > 0 || remaining.pending.length > 0 || occupied.length > 0) {
                    throw new Error("A session process is still running; the requested host cannot start.");
                }
                recovery = remaining;
            } else {
                resolved = { ...options, inProcessWorker: false, processWorker: true, processWorkerCount: count };
            }
        }
        const interruptedScan = hasWorkerRecovery(recovery) && await hasInterruptedPoolScan(lockPath, recovery);
        const host = await startHostRuntime(resolved, undefined, undefined, undefined, undefined, undefined, {
            claim, recovery, interruptedScan,
            settleRecovery: () => settleWorkerRecords(recovery, buildId, heartbeatDeadline,
                (pid) => startupLog({ type: "session_process_unresponsive", message: `Session process PID ${pid} is not answering.` })),
            onClosed: () => { activeResidentHostSockets.delete(activeSocket); },
        }) as ResidentHost;
        started = true;
        return host;
    } finally {
        try { await claim?.release(); }
        finally { if (!started) activeResidentHostSockets.delete(activeSocket); }
    }
}

export interface SessionWorkerRuntime {
    readonly sessionHost: SessionHost;
    setAnnexUrl(url: string | undefined): void;
    close(): Promise<void>;
}

export async function startSessionWorkerRuntime(
    options: StartResidentHostOptions, restoringSessions: RestoringSessions, shard?: SessionShard,
    workerGlobals?: WorkerGlobals,
    remoteExtensions?: WorkerExtensionServices,
    externalTurnsHeld?: () => boolean,
    processObservations?: ManagedProcessObservationHandlers,
): Promise<SessionWorkerRuntime> {
    return await startHostRuntime(options, restoringSessions, shard, workerGlobals, remoteExtensions, externalTurnsHeld, undefined, processObservations) as SessionWorkerRuntime;
}

async function startHostRuntime(
    options: StartResidentHostOptions, workerReservations?: RestoringSessions, shard?: SessionShard,
    workerGlobals?: WorkerGlobals,
    remoteExtensions?: WorkerExtensionServices,
    externalTurnsHeld?: () => boolean,
    startup?: ResidentHostStartup,
    processObservations?: ManagedProcessObservationHandlers,
): Promise<ResidentHost | SessionWorkerRuntime> {
    const startupStarted = performance.now();
    requireHomeForOverrides(options);
    const home = selectedVeraHome(options.home);
    const logDirectory = eventLogRoot(home);
    const hostLog = createHostLogger({ path: defaultHostLogPath(home) });
    const asyncHostLog = options.processWorker === true ? createAsyncHostLogger({ path: defaultHostLogPath(home) }) : undefined;
    const logRestart = (entry: HostLogEntry): void | Promise<void> => {
        if (asyncHostLog === undefined) {
            hostLog(entry);
            return;
        }
        return asyncHostLog(entry);
    };
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
    if (workerReservations === undefined) {
        const migration = migrateConfigPool({
            configPath,
            ...(poolPath === undefined ? {} : { poolPath }),
        });
        if (migration.notice !== undefined) {
            hostLog({ type: "pool_migrated", message: migration.notice });
        }
    }
    let announceGlobalChange: (kind: GlobalChange) => void = () => {};
    const readConfig = createLiveVeraConfigReader(options.config, {
        path: configPath,
        ...(options.projectRoot === undefined
            ? {}
            : { projectRoot: options.projectRoot }),
    });
    const currentConfig = options.processWorker !== true ? readConfig : () => {
        const before = fileReadStamp(configPath);
        try {
            return readConfig();
        } finally {
            if (fileReadStamp(configPath) !== before) announceGlobalChange("config");
        }
    };
    if (options.processWorker === true) currentConfig();
    rememberSkillSettings(options.projectRoot);
    const currentReachability = () => poolReachability(
        loadPoolFile(poolPath === undefined ? {} : { userPath: poolPath }).merged,
    );
    const cacheDirectory = providerCatalogCacheDir(home);
    const socketPath = options.socketPath
        ?? defaultHostSocketPath(home);
    const lockPath = options.lockPath ?? defaultHostLockPath(home);
    if (options.inProcessWorker === true && options.processWorker === true) {
        throw new Error("Choose one session worker transport");
    }
    if (options.processWorker === true && (options.createAdapter !== undefined
        || options.trashSessionArtifacts !== undefined)) {
        throw new Error("Process workers require serializable host services");
    }
    const workerCount = options.processWorker === true
        ? options.processWorkerCount ?? DEFAULT_SESSION_WORKERS : 1;
    if (!Number.isSafeInteger(workerCount) || workerCount < 1
        || (options.processWorkerCount !== undefined && options.processWorker !== true)) {
        throw new Error("Invalid session worker count");
    }
    if (options.processWorker === true) {
        controlSocketPath(home);
        for (let index = 0; index < workerCount; index += 1) {
            const candidate = inProcessWorkerSocket(home, index);
            if (resolve(candidate) === resolve(socketPath)) throw new Error("The host and worker socket paths must differ");
        }
    }
    const workerSocket = options.inProcessWorker === true || options.processWorker === true
        ? inProcessWorkerSocket(home) : undefined;
    if (workerSocket !== undefined && resolve(workerSocket) === resolve(socketPath)) {
        throw new Error("The host and worker socket paths must differ");
    }
    let inProcessWorker: InProcessWorker | undefined;
    const restartRecordPath = defaultRestartRecordPath(home);
    const restartLedger = options.processWorker === true ? new RestartLedger(restartRecordPath) : undefined;
    const clearFailure = (error: unknown): void => {
        hostLog({
            type: "restart_records_clear_failed",
            message: error instanceof Error ? error.message : String(error),
        });
    };
    const forgetRestartRecords = (sessionId: string): void | Promise<void> => {
        if (workerGlobals !== undefined) return workerGlobals.request<void>("forgetRestartRecords", sessionId).catch(clearFailure);
        if (restartLedger !== undefined) return restartLedger.clear(sessionId).then(() => {}, clearFailure);
        try {
            clearRestartRecordsForSession(sessionId, restartRecordPath);
        } catch (error) {
            clearFailure(error);
        }
    };
    const recordWriteFailure = (error: unknown): void => {
        hostLog({
            type: "restart_record_write_failed",
            message: error instanceof Error ? error.message : String(error),
        });
    };
    const recordStopCut = (record: RestartRecord): void | Promise<void> => {
        if (restartLedger !== undefined) return restartLedger.append(record).catch(recordWriteFailure);
        try {
            appendRestartRecord(record, restartRecordPath);
        } catch (error) {
            recordWriteFailure(error);
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
    const diskAuthStorage = options.authStorage
        ?? createAuthStorage({ path: defaultAuthStoragePath(home) });
    const authStorage = workerGlobals !== undefined ? {
        getCredential: diskAuthStorage.getCredential.bind(diskAuthStorage),
        setCredential: () => { throw new Error("Worker credentials are read only"); },
        deleteCredential: () => { throw new Error("Worker credentials are read only"); },
    } : options.processWorker === true
        ? cachedHostAuthStorage(diskAuthStorage, defaultAuthStoragePath(home), () => announceGlobalChange("auth"))
        : diskAuthStorage;
    const credentials = options.processWorker === true ? createCredentialBroker({
        authStorage,
        config: currentConfig,
        ...(options.credentialFetch === undefined ? {} : { fetch: options.credentialFetch }),
    }) : undefined;
    const codexAuthorization: CodexCatalogAuthorization | undefined = credentials === undefined ? undefined : {
        async resolve() {
            const lease = await credentials.lease(OPENAI_CODEX_PROVIDER_ID);
            if (lease.kind !== "oauth") throw new Error("Provider authorization is unavailable");
            return lease.authorization;
        },
        async refreshRejected(token) {
            const lease = await credentials.lease(OPENAI_CODEX_PROVIDER_ID, token);
            if (lease.kind !== "oauth") throw new Error("Provider authorization is unavailable");
            return lease.authorization;
        },
    };
    const discoversModelsAtStartup = workerReservations === undefined
        && options.createAdapter === undefined && options.skipStartupDiscovery !== true;
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
                inProcessWorker?.notifyModelCatalogChanged();
                announceGlobalChange("catalog");
            })
            .catch(() => undefined)
            .finally(() => {
                webDevArenaRefresh = undefined;
            });
    };
    const startupFindings = options.startupFindings ?? new StartupFindings();
    // The record and the timer belong to the host that owns the catalogs.
    const modelAvailability = workerReservations === undefined
        ? new ModelAvailabilityStore(modelAvailabilityRecordPath(home), hostLog)
        : undefined;
    let catalogRefreshTimer: CatalogRefreshTimer | undefined;
    let catalogScanStopped = false;
    let lastManualFullRefreshAt: number | undefined;
    const trackedPoolPath = poolPath ?? join(home, "pool.json");

    const readTrackedPool = (): PoolFile | undefined => {
        try {
            accessSync(trackedPoolPath, constants.R_OK);
            if (!statSync(trackedPoolPath).isFile()) return undefined;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        }
        try {
            return loadPoolFile({ userPath: trackedPoolPath }).merged;
        } catch {
            return undefined;
        }
    };

    const runDailyCatalogScan = async (): Promise<void> => {
        if (modelAvailability === undefined) return;
        const startedAt = Date.now();
        if (lastManualFullRefreshAt !== undefined
            && startedAt - lastManualFullRefreshAt < CATALOG_SCAN_MIN_FIRST_DELAY_MS) {
            hostLog({ type: "model_catalog_scan_skipped", reason: "recent_manual_refresh" });
            return;
        }
        const config = currentConfig();
        const listings = await refreshProviderCatalogListings(config, {
            authStorage,
            cacheDir: cacheDirectory,
            ...(codexAuthorization === undefined ? {} : { authorization: codexAuthorization }),
        });
        models = await discoverAvailableModels(config, authStorage, hostLog, cacheDirectory);
        if (!catalogScanStopped) announceGlobalChange("catalog");

        let tracked = 0;
        let dropped = 0;
        try {
            const pool = readTrackedPool();
            if (pool === undefined) {
                hostLog({ type: "model_availability_pool_unreadable", path: trackedPoolPath });
            } else {
                const watched = trackedModels(config, pool);
                if (watched.droppedFavorites > 0) {
                    hostLog({ type: "model_availability_over_cap", dropped: watched.droppedFavorites });
                }
                const applied = applyCatalogScan(
                    modelAvailability.read(),
                    watched.models,
                    listings,
                    new Date(startedAt).toISOString(),
                    (notice) => hostLog({ type: "model_dropped", ...notice }),
                );
                tracked = watched.models.length;
                dropped = applied.dropped;
                modelAvailability.write(applied.next);
            }
        } catch (error) {
            hostLog({
                type: "model_availability_scan_failed",
                reason: error instanceof Error ? error.message : String(error),
            });
        }
        hostLog({
            type: "model_catalog_scan",
            source: "daily",
            tracked,
            dropped,
            outcomes: listings.map((entry) => entry.outcome),
        });
    };

    const scanCatalogsDaily = (): Promise<void> => {
        const scanned = catalogRefreshes.then(() => runDailyCatalogScan());
        catalogRefreshes = scanned.then(() => undefined, () => undefined);
        return scanned;
    };
    const blockedDirectory = options.blockedDirectory ?? veraBlockedDirectory(home);
    let inbox!: Inbox;
    let consumers: ReturnType<typeof createConsumerRegistry>;
    let inboxDelivery!: InboxDeliveryCoordinator;
    let scheduleStore!: ScheduleStore;
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
        catalogScanStopped = true;
        catalogRefreshTimer?.close();
        catalogRefreshTimer = undefined;
        curatedRefresh.close();
        await sidecars?.close();
        sidecars = null;
    };
    const closeInbox = async (): Promise<void> => {
        await watches?.close();
        await scheduler?.close();
        scheduleStore.close();
        inboxDelivery.close();
        await inboxDelivery.drainRemote();
        inbox.close();
    };
    let stopWaitNotifications = Promise.resolve();
    const hostStarted = Promise.withResolvers<boolean>();
    const stopWhenIdle: StopWhenIdle = new StopWhenIdle({
        waitingOn: (): readonly StopWaitTarget[] => registry.stopWaitTargets(),
        ...(options.processWorker === true ? {
            setTurnsHeld: (held: boolean) => inProcessWorker?.setTurnsHeld?.(held) ?? Promise.resolve(),
            replyBeforeWorkerCheck: true,
        } : {}),
        ...(workerSocket === undefined ? {} : {
            waitingOnAsync: () => inProcessWorker?.waitingOn() ?? Promise.resolve(registry.stopWaitTargets()),
        }),
        onStopped: async (cause) => {
            if (!await hostStarted.promise) return;
            if (options.processWorker === true) await stopWaitNotifications;
            await closeHost(cause);
        },
        targetProblem: updateTargetProblem,
        prepare: prepareStopForTarget,
        cutSession: (sessionId, reason, stopCause) => inProcessWorker === undefined
            ? registry.cutSessionForStop(sessionId, reason, stopCause)
            : inProcessWorker.cutSession(sessionId, reason, stopCause),
        ...(workerGlobals === undefined ? { recordCut: recordStopCut } : {}),
    });
    if (options.processWorker === true) {
        stopWhenIdle.observe((event) => {
            stopWaitNotifications = stopWaitNotifications.then(async () => {
                await inProcessWorker?.publishStopWait?.(event);
            }).catch(() => {});
        });
    }
    const recentScheduleRuns = (): readonly EmittedScheduleRun[] => {
        try {
            return scheduleStore.recentlyEmitted(MAX_SCHEDULE_WORK_ROWS);
        } catch {
            return [];
        }
    };
    let sharedServices: SessionHostServices | undefined;
    const restoringSessions: RestoringSessions = workerReservations ?? new Map();
    let annexUrl: string | undefined;
    const sessionOptions: StartSessionHostOptions = {
        sessions: "all",
        ...(workerReservations === undefined ? {} : { sessionWorker: true }),
        ...(options.processWorker === true ? { disableTurnWorker: true } : {}),
        ...(workerGlobals === undefined ? {} : { workerGlobals }),
        ...(processObservations === undefined ? {} : { processObservations }),
        ...(credentials === undefined ? {} : { hostCredentialLease: credentials.lease }),
        ...(options.processWorker === true ? { onPreferencesChanged: () => announceGlobalChange("preferences") } : {}),
        onToolDescriptionChanged: (extensionId, name, description) => {
            inProcessWorker?.notifyToolDescriptionChanged(extensionId, name, description);
        },
        ...(options.processWorker === true ? { poolHost: true } : {}),
        ...(remoteExtensions === undefined ? {} : { remoteExtensions }),
        config: options.config,
        home, configPath, cacheDirectory, currentConfig, currentReachability,
        sessionDirectory, sessionIdentityReservationRoot, blockedDirectory, restoringSessions,
        ...(shard === undefined ? {} : { shard }),
        modelFailureLedgerPath, authStorage, hostLog, startupLog, startupFindings, timed,
        permissionPreferencesPath: options.permissionPreferencesPath,
        eventLogDirectory,
        importRoots: options.importRoots,
        createAdapter: options.createAdapter,
        onExtensionFailure: options.onExtensionFailure,
        trashSessionArtifacts: options.trashSessionArtifacts,
        turnsHeld: () => stopWhenIdle.holdsTurns || externalTurnsHeld?.() === true,
        inboxActorForSession: () => readArcNodeId(options.arcConfigPath),
        annexUrl: () => annexUrl,
        forgetRestartRecords,
        recentScheduleRuns,
        onWorkChanged: (listener) => {
            workChangeListeners.add(listener);
            return () => { workChangeListeners.delete(listener); };
        },
        createServices: (createAdapter, sessionWorker) => {
            if (sharedServices !== undefined) {
                if (sessionWorker !== true) return sharedServices;
                return {
                    ...sharedServices,
                    inboxDelivery: new InboxDeliveryCoordinator(createConsumerRegistry(inbox, undefined, true), {
                        admissionFor: (projectRoot) => projectRoot === undefined
                            ? undefined
                            : InboxAdmissionPolicy.fromConfig(
                                options.config, projectRoot, options.inboxUserConfigPath ?? configPath,
                            ),
                    }),
                };
            }
            const inboxPath = options.inboxPath ?? defaultInboxPath(home);
            inbox = workerReservations === undefined ? Inbox.open(inboxPath) : Inbox.openReadOnly(inboxPath);
            consumers = createConsumerRegistry(inbox, undefined, workerReservations !== undefined);
            inboxDelivery = new InboxDeliveryCoordinator(consumers, {
                admissionFor: (projectRoot) => projectRoot === undefined
                    ? undefined
                    : InboxAdmissionPolicy.fromConfig(
                        options.config,
                        projectRoot,
                        options.inboxUserConfigPath ?? configPath,
                        workerGlobals === undefined ? undefined
                            : (family) => workerGlobals.request<void>("inboxRemember", family),
                        options.processWorker === true ? () => announceGlobalChange("config") : undefined,
                        workerGlobals === undefined ? undefined
                            : (family, projectRoot) => workerGlobals.request<void>("inboxRememberProject", family, projectRoot),
                    ),
            });
            const schedulePath = options.schedulePath ?? defaultSchedulePath(home);
            scheduleStore = workerReservations === undefined
                ? ScheduleStore.open(schedulePath) : ScheduleStore.openReadOnly(schedulePath);
            curatedRefresh = workerReservations === undefined
                ? startCuratedRefresh({
                    path: curatedCachePath(home),
                    ...(options.processWorker === true ? {
                        onResult: (result) => {
                            if (result.source === "fetched") announceGlobalChange("catalog");
                        },
                    } : {}),
                    ...(options.config.curated_models_url === undefined
                        ? {}
                        : { url: options.config.curated_models_url }),
                })
                : { close: () => {} };
            catalogRefreshTimer = modelAvailability === undefined
                ? undefined
                : startCatalogRefreshTimer({
                    readLastScanAt: () => modelAvailability.read()?.last_scan_at,
                    scan: scanCatalogsDaily,
                    log: hostLog,
                    ...(options.catalogScan ?? {}),
                });
            const readFeedRow = createFeedRowReader(
                options.config.model_feed_url === undefined
                    ? {}
                    : { url: options.config.model_feed_url },
            );
            const refreshProviderCatalogNow = async (
                provider: string,
            ): Promise<readonly SuggestedModel[] | undefined> => {
                const config = currentConfig();
                try {
                    if (!providerEnabled(config, provider)) return undefined;
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
                            ...(codexAuthorization === undefined ? {} : { authorization: codexAuthorization }),
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
                    announceGlobalChange("catalog");
                }
            };
            return sharedServices = {
                inboxDelivery,
                models: {
                    readAvailableModels: () => models,
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
                            .filter((provider) => providerEnabled(config, provider.id))
                            .filter((provider) => isRefreshableProvider(provider.id, config)
                                || (provider.id === OPENAI_CODEX_PROVIDER_ID && hasCodexCredential(authStorage))
                                || configuredProviders(config).find((row) => row.id === provider.id)?.protocol === "anthropic-messages")
                            .map((provider) => provider.id);
                    },
                    refreshCatalog: (provider) => {
                        const refreshed = catalogRefreshes.then(() => refreshProviderCatalogNow(provider));
                        // The queue carries the turn, not its failure: one refresh that throws must not leave every later one rejected.
                        catalogRefreshes = refreshed.then(() => undefined, () => undefined);
                        return refreshed;
                    },
                    readPool: (projectRoot) => {
                        const config = currentConfig();
                        return pooledModels(models, {
                            ...scoped(projectRoot), ...(options.processWorker === true ? { userPath: join(home, "pool.json") } : {}),
                        }).filter((entry) => providerEnabled(config, entry.provider));
                    },
                    createEffortPool: (projectRoot) => {
                        const pool = createPoolEffortPool({
                            ...scoped(projectRoot),
                            ...(options.processWorker === true ? { userPath: join(home, "pool.json"), path: join(home, "pool.json") } : {}),
                            onWriteRefused: (error) =>
                                hostLog({ type: "pool_write_refused", message: error.message }),
                        });
                        return options.processWorker === true ? {
                            ...pool,
                            recordLearned(ref, key, fact) {
                                pool.recordLearned(ref, key, fact);
                                announceGlobalChange("pool");
                            },
                        } : pool;
                    },
                    readPolicy: (projectRoot) => {
                        const config = currentConfig();
                        return {
                            ...subagentPoolPolicy({ ...scoped(projectRoot), config }),
                            candidates: pooledModels(models, { ...scoped(projectRoot), includeUncurated: true })
                                .filter((entry) => providerEnabled(config, entry.provider)),
                        };
                    },
                    admitToPool: (entry, onStep, admissionOptions) => {
                        const config = currentConfig();
                        return admitToPool(entry, onStep, {
                            ...admissionOptions,
                            ...(options.processWorker === true ? { path: join(home, "pool.json") } : {}),
                            createAdapter: (provider) => createRequestOptionsSnapshotAdapter(
                                (selected) => createAdapter(selected),
                                provider,
                                config,
                            ),
                            readFeedRow,
                            onWriteRefused: (error) =>
                                hostLog({ type: "pool_write_refused", message: error.message }),
                        }).then((outcome) => {
                            if (outcome.verdict === "added") announceGlobalChange("pool");
                            return outcome;
                        });
                    },
                    removeFromPool: (entry) => {
                        refusedPoolWrite(() => {
                            setPoolMembership([`${entry.provider}/${entry.model}`], false,
                                options.processWorker === true ? { path: join(home, "pool.json") } : {});
                        }, hostLog);
                        announceGlobalChange("pool");
                    },
                    namePoolEntry: (entry, name, projectRoot) => {
                        const id = `${entry.provider}/${entry.model}`;
                        const merged = loadPoolFile({ projectRoot,
                            ...(options.processWorker === true ? { userPath: join(home, "pool.json") } : {}) }).merged;
                        if (
                            name !== null
                            && poolNameRefusal(merged, id, name) !== undefined
                        ) {
                            return false;
                        }
                        let named = false;
                        const refused = refusedPoolWrite(() => {
                            const file = namePoolModel(id, name ?? undefined,
                                options.processWorker === true ? { path: join(home, "pool.json") } : {});
                            named = file.models[id] !== undefined
                                && file.models[id]?.name === (name ?? undefined);
                        }, hostLog);
                        if (refused === undefined && named) announceGlobalChange("pool");
                        return refused === undefined && named;
                    },
                    movePoolEntry: (entry, delta) => {
                        const id = `${entry.provider}/${entry.model}`;
                        let held = false;
                        const refused = refusedPoolWrite(() => {
                            const poolOptions = options.processWorker === true ? { path: join(home, "pool.json") } : {};
                            held = Object.hasOwn(readUserPoolFile(poolOptions).models, id);
                            if (held) movePoolModel(id, delta, poolOptions);
                        }, hostLog);
                        if (refused === undefined && held) announceGlobalChange("pool");
                        return refused === undefined && held;
                    },
                    updateModelDefaults: (settings) => {
                        updateVeraConfigDefaults({
                            provider: settings.provider as VeraConfig["provider"],
                            model: settings.model,
                            // Explicitly null rather than omitted: settings that carry no effort mean the accepted model has none, so a stored default from an earlier model must not survive into the next.
                            reasoning_effort: settings.reasoningEffort ?? null,
                        }, options.processWorker === true ? { path: configPath } : {});
                        announceGlobalChange("config");
                    },
                    contextLimit: () => currentConfig().context_limit,
                    updateContextLimit: (limit) => {
                        updateVeraConfigDefaults({ context_limit: limit }, options.processWorker === true ? { path: configPath } : {});
                        announceGlobalChange("config");
                    },
                    updateApprovalDefault: (mode) => {
                        updateVeraConfigDefaults({ approval_mode: mode }, options.processWorker === true ? { path: configPath } : {});
                        announceGlobalChange("config");
                    },
                    writeReviewer: (settings) => {
                        if (settings === null || settings.models.length === 0) {
                            updateVeraConfigDefaults({
                                model_assignment: { assignment: "reviewer", binding: null },
                            }, options.processWorker === true ? { path: configPath } : {});
                            announceGlobalChange("config");
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
                        }, options.processWorker === true ? { path: configPath } : {});
                        announceGlobalChange("config");
                    },
                    updateOverrides: (patch) => {
                        updateVeraConfigDefaults(overridePatchDefaults(patch), options.processWorker === true ? { path: configPath } : {});
                        announceGlobalChange("config");
                    },
                    ...(workerGlobals === undefined ? {} : {
                        readAvailableModels: () => workerGlobals.models(),
                        refreshAvailableModels: () => workerGlobals.models(),
                        providerCatalogs: () => workerGlobals.providerCatalogs(),
                        refreshableProviders: () => workerGlobals.refreshableProviders(),
                        refreshCatalog: (provider: string) => workerGlobals.refreshCatalog(provider),
                        readPool: (projectRoot?: string) => {
                            const config = currentConfig();
                            return pooledModels(workerGlobals.models(), {
                                ...scoped(projectRoot), userPath: join(home, "pool.json"),
                            }).filter((entry) => providerEnabled(config, entry.provider));
                        },
                        readPolicy: (projectRoot?: string) => {
                            const config = currentConfig();
                            return {
                                ...subagentPoolPolicy({ ...scoped(projectRoot), config, userPath: join(home, "pool.json") }),
                                candidates: pooledModels(workerGlobals.models(), {
                                    ...scoped(projectRoot), userPath: join(home, "pool.json"), includeUncurated: true,
                                }).filter((entry) => providerEnabled(config, entry.provider)),
                            };
                        },
                        createEffortPool: (projectRoot: string) => ({
                            ...createPoolEffortPool({ ...scoped(projectRoot), userPath: join(home, "pool.json") }),
                            recordLearned: () => {},
                        }),
                        admitToPool: (entry: { provider: string; model: string }, onStep: Parameters<typeof admitToPool>[1],
                            admissionOptions?: { verify?: boolean }) => admitToPool(entry, onStep, {
                            ...admissionOptions,
                            createAdapter: (provider) => createRequestOptionsSnapshotAdapter(
                                (selected) => createAdapter(selected), provider, currentConfig(),
                            ),
                            readFeedRow,
                            commit: (id, declared, learned) => workerGlobals.commitPool({
                                id, declared, ...(learned === undefined ? {} : { learned }),
                            }),
                            onWriteRefused: (error) => hostLog({ type: "pool_write_refused", message: error.message }),
                        }),
                        removeFromPool: (entry: { provider: string; model: string }) => workerGlobals.request<void>("poolRemove", entry),
                        namePoolEntry: (entry: { provider: string; model: string }, name: string | null, projectRoot: string) =>
                            workerGlobals.request<boolean>("poolName", entry, name, projectRoot),
                        movePoolEntry: (entry: { provider: string; model: string }, delta: number, projectRoot: string) =>
                            workerGlobals.request<boolean>("poolMove", entry, delta, projectRoot),
                        updateModelDefaults: (settings: ModelTurnSettings) => workerGlobals.request<void>("modelDefaults", settings),
                        updateContextLimit: (limit: number | null) => workerGlobals.request<void>("contextLimit", limit),
                        updateApprovalDefault: (mode: ApprovalMode) => workerGlobals.request<void>("approvalDefault", mode),
                        writeReviewer: (settings: ToolReviewerSettings | null) => workerGlobals.request<void>("reviewer", settings),
                        updateOverrides: (patch: OverrideSettingsPatch) => workerGlobals.request<void>("overrides", patch),
                    }),
                },
            };
        },
    };
    const sessionHost = await startSessionHost(sessionOptions);
    const { registry, extensions, createAdapter } = sessionHost;
    if (workerReservations !== undefined) {
        sessionHost.startStorage();
        sessionHost.setParkIdle(async () => {});
        return {
            sessionHost,
            setAnnexUrl(url) { annexUrl = url; },
            async close() {
                try {
                    await sessionHost.close();
                } finally {
                    await closeInbox();
                    await closeSidecars();
                }
            },
        };
    }
    // Scores fill in after startup; discovery never waits for the arena download.
    if (discoversModelsAtStartup) {
        refreshWebDevArenaInBackground(catalogMaxAgeMs(options.config));
    }

    // A cache from another build reads as empty, so the picker would lose every
    // Codex model until the daily scan. Fetch once here, after the host serves.
    const fetchCodexModelsAtStart = (): void => {
        if (!discoversModelsAtStartup) return;
        if (!providerEnabled(currentConfig(), OPENAI_CODEX_PROVIDER_ID)) return;
        const fetched = catalogRefreshes.then(async () => {
            if (catalogScanStopped) return;
            if (!providerEnabled(currentConfig(), OPENAI_CODEX_PROVIDER_ID)) return;
            try {
                const outcome = await fetchCodexCatalogAtStart({
                    authStorage,
                    cacheDir: cacheDirectory,
                    log: hostLog,
                    ...(codexAuthorization === undefined ? {} : { authorization: codexAuthorization }),
                    ...(options.catalogFetch === undefined ? {} : { fetch: options.catalogFetch }),
                    ...(options.codexCatalogBaseUrl === undefined ? {} : { baseUrl: options.codexCatalogBaseUrl }),
                });
                if (outcome.status !== "fetched" || catalogScanStopped) return;
                const rebuilt = await discoverAvailableModels(
                    currentConfig(),
                    authStorage,
                    hostLog,
                    cacheDirectory,
                );
                if (catalogScanStopped) return;
                models = rebuilt;
                registry.notifyModelCatalogChanged();
                announceGlobalChange("catalog");
            } catch (error) {
                hostLog({
                    type: "codex_catalog_start_refresh_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        });
        catalogRefreshes = fetched.then(() => undefined, () => undefined);
    };

    let server!: HostServer;
    let annex: AnnexProcess | undefined;
    let annexUnavailable: string | undefined;
    const annexHealth: { annex: "ok" | "failed"; annexReason?: string } = {
        annex: "failed",
    };
    const markAnnexFailed = (reason: string): void => {
        annexUrl = undefined;
        void inProcessWorker?.notifyAnnexChanged(undefined).catch(() => {});
        annexUnavailable =
            `${reason} Restart the host to bring the annex back.`;
        annexHealth.annex = "failed";
        annexHealth.annexReason = reason;
    };
    const markAnnexOk = async (url: string): Promise<void> => {
        annexUrl = url;
        await inProcessWorker?.notifyAnnexChanged(url);
        annexUnavailable = undefined;
        annexHealth.annex = "ok";
        delete annexHealth.annexReason;
    };
    let closing: Promise<void> | undefined;
    let shutdownCause: HostShutdownCause = { reason: "shutdown_requested" };
    let logPruneTimer: ReturnType<typeof setInterval> | undefined;
    let scratchPruneTimer: ReturnType<typeof setInterval> | undefined;
    let scratchPruneStopped = false;
    let scratchPruning: Promise<void> | undefined;
    let clientWatchdog: ClientWatchdog | undefined;
    let announceShutdown: () => void = () => {};
    const shutdownRequested = new Promise<void>((resolve) => {
        announceShutdown = resolve;
    });
    const closeHost = (cause?: HostShutdownCause): Promise<void> => {
        scratchPruneStopped = true;
        // A worker lost while the host closes must not be replaced.
        inProcessWorker?.stopSupervising?.();
        sessionHost.stopMaintenance();
        inProcessWorker?.stopMaintenance();
        clientWatchdog?.close();
        clientWatchdog = undefined;
        if (logPruneTimer !== undefined) {
            clearInterval(logPruneTimer);
            logPruneTimer = undefined;
        }
        if (scratchPruneTimer !== undefined) {
            clearInterval(scratchPruneTimer);
            scratchPruneTimer = undefined;
        }
        if (closing === undefined) {
            if (cause !== undefined) shutdownCause = cause;
            const restorationStopped = server?.stopLockRestoration();
            announceShutdown();
            closing = (async () => {
                try {
                    try {
                        await restorationStopped;
                        await annex?.close();
                    } finally {
                        try {
                            if (inProcessWorker !== undefined) {
                                try {
                                    await server.close();
                                } finally {
                                    await inProcessWorker.close();
                                }
                            }
                        } finally {
                            await closeResidentHost(server, sessionHost, closeInbox, closeSidecars);
                        }
                    }
                    await removeStoppedPoolLock(home, lockPath, server.identity);
                } finally {
                    startup?.onClosed();
                }
            })();
        }
        return closing;
    };
    try {
        sessionHost.startStorage(workerSocket === undefined ? undefined : { scan: false });
        if (workerSocket !== undefined) {
            const workerOptions = {
                host: sessionHost, sessionOptions, hostSocket: socketPath,
                workerSocket, lockPath, buildId: options.buildId ?? thisProcessBuildId(),
                capabilities: HOST_CAPABILITIES,
            };
            inProcessWorker = options.processWorker === true
                ? prepareProcessWorker({ ...workerOptions, hostOptions: options, workerCount, credentials: credentials!,
                    interruptedScan: startup?.interruptedScan === true,
                    restartLedger: restartLedger!,
                    recoverableWorkers: startup?.recovery.recoverable ?? [],
                    stoppedWorkers: startup?.recovery.stopped ?? [],
                    pendingWorkers: startup?.recovery.pending ?? [],
                    unrecordedWorkers: startup?.recovery.unrecorded ?? [],
                    ...(startup === undefined ? {} : { settleRecovery: startup.settleRecovery }),
                    onGlobalChangeReady: (notify) => { announceGlobalChange = notify; } })
                : await prepareInProcessWorker(workerOptions);
        }
        const prepareAddress = async (address: string | null | undefined): Promise<void> => {
            if (address === null || address === undefined || inProcessWorker === undefined) return;
            if (inbox.offsetOf({ nodeId: consumers.nodeId, label: address }) !== null) return;
            if (await inProcessWorker.knowsSession(address)) {
                inbox.registerConsumer({ nodeId: consumers.nodeId, label: address });
            }
        };
        if (inProcessWorker !== undefined) {
            inboxDelivery.setBeforeAppend((entry) => prepareAddress(entry.address));
        }
        watches = startWatchRuntimeIfConfigured(inbox, {
            watches: extensions.contributions().watches(),
            ...(options.watchConnectors === undefined
                ? {}
                : { connectors: options.watchConnectors }),
            secret: options.watchSecret
                ?? (() => readArcToken(options.arcConfigPath)),
            ...(inProcessWorker === undefined ? {} : { beforeAdmit: prepareAddress }),
            onAppended: () => {
                void inboxDelivery.pumpAll();
            },
        });
        const schedulerOptions: SchedulerRuntimeOptions = {
            store: scheduleStore,
            emit: (key, entry) =>
                inboxDelivery.appendOnce(SCHEDULER_SOURCE, key, entry),
            onRunEmitted: notifyWorkChanged,
            onError: (error) => hostLog({
                type: "scheduler_failed",
                message: error instanceof Error ? error.message : String(error),
            }),
        };
        scheduler = workerSocket === undefined
            ? await timed("scheduler", () => startSchedulerRuntime(schedulerOptions))
            : new SchedulerRuntime(schedulerOptions);
        const providerGenerations = new Map<string, number>();
        const providerSignIn = createProviderSignInService({ configPath, cacheDir: cacheDirectory, authStorage });
        server = await timed(
            "server_listen_and_lockfile",
            () => startHostServer({
                ...sessionHost.handlers,
                ...inProcessWorker?.hostHandlers,
                capabilities: HOST_CAPABILITIES,
                socketPath,
                lockPath,
                log: hostLog,
                ...(options.processWorker === true ? { poolWorkerCount: workerCount } : {}),
                ...(startup === undefined ? {} : { startupClaim: startup.claim }),
                ...(startup === undefined || !hasWorkerRecovery(startup.recovery) || startup.interruptedScan
                    ? {} : { publishBeforeWorkers: true }),
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
                ...(inProcessWorker === undefined ? {} : {
                    onListening: (identity) => inProcessWorker!.start(identity),
                }),
                recoverPrevious: async () => {
                    if (startup !== undefined && hasWorkerRecovery(startup.recovery) && !startup.interruptedScan) return;
                    try {
                        const scan = options.processWorker === true
                            ? await inProcessWorker!.recoverCrashedTurns!({ lockPath, sessionDirectory, recordPath: restartRecordPath })
                            : await recoverCrashedTurns({
                                lockPath,
                                sessionDirectory,
                                recordPath: restartRecordPath,
                                withSession: async (path, recover) => {
                                    await withSessionReservation(path, restoringSessions, async () => {
                                        const header = await readSessionHeader(path).catch(() => undefined);
                                        if (header === undefined) return;
                                        const { id } = header;
                                        if (
                                            registry.agents.has(id)
                                            || registry.startingIds.has(id)
                                            || registry.trashingIds.has(id)
                                            || await (inProcessWorker?.hasSession(id) ?? false)
                                        ) return;
                                        await recover();
                                    });
                                },
                            });
                        if ("failures" in scan && scan.failures.length > 0) {
                            const logged = logRestart({ type: "restart_scan_failed", message: [...new Set(scan.failures)].join(" ") });
                            if (logged !== undefined) await logged;
                        }
                        if (scan.recorded.length > 0) {
                            const logged = logRestart({
                                type: "restart_turns_recorded",
                                message: `${scan.recorded.length} session(s) had a turn open at the last exit`,
                            });
                            if (logged !== undefined) await logged;
                        }
                    } catch (error) {
                        const logged = logRestart({
                            type: "restart_scan_failed",
                            message: error instanceof Error ? error.message : String(error),
                        });
                        if (logged !== undefined) await logged;
                    }
                },
                restartRecords: {
                    list: () => restartLedger?.list() ?? listRestartRecords(restartRecordPath),
                    dismiss: (sessionId) =>
                        restartLedger?.clear(sessionId) ?? clearRestartRecordsForSession(sessionId, restartRecordPath),
                },

                stopWhenIdle,
                providerSignIn: {
                    ...providerSignIn,
                    save: async (input) => {
                        const saved = catalogRefreshes.then(async () => {
                            const result = await providerSignIn.save(input);
                            providerGenerations.set(input.id, (providerGenerations.get(input.id) ?? 0) + 1);
                            models = modelsFromConnectedCatalogs(currentConfig(), models, { authStorage, cacheDir: cacheDirectory });
                            announceGlobalChange("config");
                            announceGlobalChange("catalog");
                            return result;
                        });
                        catalogRefreshes = saved.then(() => undefined, () => undefined);
                        return await saved;
                    },
                },
                selectProviderModel: async (provider, model) => {
                    const generation = providerGenerations.get(provider) ?? 0;
                    await selectOnboardingModel({ provider, model, configPath, poolPath: join(home, "pool.json"),
                        verify: async () => {
                            const results = await applyModelOperation({ operation: "verify", models: [{ provider, model }] }, {
                                isCurrent: () => generation === (providerGenerations.get(provider) ?? 0),
                                discovered: registry.modelsForClient(),
                                assignments: modelOperationAssignments(currentConfig()).map((slot) => ({ label: slot.label, models: slot.declared })),
                                createAdapter: (id) => createAdapter(id),
                                catalog: (id, name) => effectiveCatalog(id, { cacheDir: cacheDirectory }).models.find((row) => row.id === name),
                                path: join(home, "pool.json"),
                            });
                            return results[0];
                        },
                    });
                    registry.defaultProvider = provider;
                    registry.defaultModel = model;
                    registry.defaultReasoningEffort = undefined;
                    announceGlobalChange("config");
                    announceGlobalChange("pool");
                },
                setProviderEnabled: async (provider, enabled, workspace) => {
                    let changed = false;
                    const change = async () => {
                        const config = currentConfig();
                        if (findConfiguredProvider(provider, config) === undefined) {
                            throw new Error("Provider is no longer configured");
                        }
                        if (providerEnabled(config, provider) === enabled) return;
                        if (!enabled) {
                            const refusal = providerDisableRefusal(config, provider, { authStorage });
                            if (refusal !== undefined) throw new Error(refusal);
                        }
                        const write = () => updateVeraConfigDefaults({
                            provider_enabled: { id: provider, enabled },
                        }, { path: configPath });
                        if (credentials === undefined) write();
                        else await credentials.withProviderMutation(provider, write);
                        changed = true;
                        providerGenerations.set(provider, (providerGenerations.get(provider) ?? 0) + 1);
                        if (enabled) {
                            // Restore the cached catalog now; the refresh below replaces it if the provider answers.
                            models = modelsFromConnectedCatalogs(currentConfig(), models, {
                                authStorage,
                                cacheDir: cacheDirectory,
                            });
                        }
                        announceGlobalChange("config");
                        if (!enabled) {
                            models = models.filter((model) => model.provider !== provider);
                            announceGlobalChange("catalog");
                        }
                    };
                    const queued = catalogRefreshes.then(change);
                    catalogRefreshes = queued.then(() => undefined, () => undefined);
                    await queued;
                    if (!enabled || !changed) return { settings: registry.readHostModelSettings(workspace) };
                    let warning: string | undefined;
                    // The queue is free now, so the normal per-provider refresh can run without waiting on itself.
                    if (sharedServices !== undefined) {
                        const refresh = sharedServices.models.refreshCatalog;
                        const refreshableProviders = sharedServices.models.refreshableProviders;
                        if (refresh !== undefined) {
                            let refreshable = false;
                            if (refreshableProviders !== undefined) {
                                try {
                                    refreshable = refreshableProviders().includes(provider);
                                } catch {
                                    refreshable = false;
                                }
                            }
                            const refreshed = await refresh(provider).catch(() => undefined);
                            if (refreshable && refreshed === undefined) {
                                const label = findConfiguredProvider(provider, currentConfig())?.label ?? provider;
                                warning = `${label} is on, but its model list could not be refreshed. The saved list stands.`;
                            }
                        }
                    }
                    return {
                        settings: registry.readHostModelSettings(workspace),
                        ...(warning === undefined ? {} : { warning }),
                    };
                },
                forgetProvider: async (provider, workspace) => {
                    const forget = async () => {
                        const write = () => forgetProviderConnection(provider, authStorage, options.processWorker === true ? {
                            configPath, poolPath: join(home, "pool.json"), cacheDir: cacheDirectory,
                        } : {});
                        if (credentials === undefined) write();
                        else await credentials.withProviderMutation(provider, write);
                        announceGlobalChange("config");
                        providerGenerations.set(provider, (providerGenerations.get(provider) ?? 0) + 1);
                        await sessionHost.clearProviderSelection(provider);
                        await inProcessWorker?.clearProviderSelection(provider);
                        return registry.readHostModelSettings(workspace);
                    };
                    if (credentials === undefined) return await forget();
                    const forgotten = catalogRefreshes.then(forget);
                    catalogRefreshes = forgotten.then(() => undefined, () => undefined);
                    return await forgotten;
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
                            ...(codexAuthorization === undefined ? {} : { authorization: codexAuthorization }),
                        });
                        models = await discoverAvailableModels(
                            config,
                            authStorage,
                            hostLog,
                            cacheDirectory,
                        );
                        announceGlobalChange("catalog");
                        lastManualFullRefreshAt = Date.now();
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

                checkpointStores: async (destination) => {
                    await inProcessWorker?.flushStores();
                    return checkpointOpenStores({ destination, inbox, schedules: scheduleStore });
                },

                onShutdownAccepted: async (reason, requester) => {
                    if (!await hostStarted.promise) return;
                    await inProcessWorker?.waitForForwardedShutdowns();
                    await closeHost(reason === undefined ? undefined : {
                        reason, ...(requester === undefined ? {} : { requester }),
                    });
                },

            }),
        );
        if (sessionHost.processObservations !== undefined && sessionHost.observationExecutorId !== undefined) {
            const recovery = await sessionHost.processObservations.recover(sessionHost.observationExecutorId);
            if (recovery.failed > 0) {
                throw new Error(`Process observation recovery failed for ${recovery.failed} item(s); they remain recorded for retry on host restart.`);
            }
        }
        if (workerSocket !== undefined) {
            await timed("scheduler", () => scheduler!.start());
        }
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
            await markAnnexOk(annex.url);
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
    } catch (error) {
        hostStarted.resolve(false);
        try {
            await closeSidecars();
        } catch {
        }
        if (workerSocket === undefined) {
            try { await server?.close(); } catch {}
            await sessionHost.closeAfterStartupFailure();
            await closeInbox();
            throw error;
        }
        try { await server?.close(); } catch {}
        try { await inProcessWorker?.close(); } catch {}
        try { await sessionHost.closeAfterStartupFailure(); } catch {}
        try { await closeInbox(); } catch {}
        throw error;
    }

    clientWatchdog = startClientWatchdog(home, { log: hostLog });
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
    const pruneOldScratch = (): void => {
        if (scratchPruneStopped || scratchPruning !== undefined) return;
        let scratchDirectory: string;
        try {
            scratchDirectory = sessionScratchRoot(home);
        } catch {
            return;
        }
        const pending = pruneScratch(scratchDirectory, sessionDirectory, {
            maxAgeMs: scratchMaxAgeMs(currentConfig()),
            isStopped: () => scratchPruneStopped,
            removeIfUnowned: (id, detach) => inProcessWorker?.removeScratchIfUnowned !== undefined
                ? inProcessWorker.removeScratchIfUnowned(id, detach)
                : (() => {
                    const unowned = () => !registry.agents.has(id) && !registry.startingIds.has(id)
                        && !registry.trashingIds.has(id);
                    return unowned() ? detach(unowned) : false;
                })(),
        }).then(() => {}, () => {});
        scratchPruning = pending;
        void pending.then(() => { scratchPruning = undefined; });
    };
    pruneOldScratch();
    scratchPruneTimer = setInterval(pruneOldScratch, SCRATCH_PRUNE_INTERVAL_MS);
    scratchPruneTimer.unref();
    startupLog({
        type: "host_startup_complete",
        duration_ms: performance.now() - startupStarted,
        build_id: buildId,
    });
    hostStarted.resolve(true);
    fetchCodexModelsAtStart();
    return {
        registry,
        extensions,
        server,
        shutdownRequested,
        shutdownCause: () => shutdownCause,
        health: options.processWorker === true ? {
            get annex() { return annexHealth.annex; },
            get annexReason() { return annexHealth.annexReason; },
            get workers() { return inProcessWorker?.workerHealth?.(); },
        } : annexHealth,
        ...(annex === undefined ? {} : { annexPid: annex.pid }),
        ...(options.processWorker === true
            ? { workerStopPids: () => inProcessWorker?.stopPids?.() ?? [] }
            : {}),
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

function requireHomeForOverrides(options: StartResidentHostOptions): void {
    const selectedHome = options.home ?? process.env[VERA_HOME_ENV]?.trim();
    if ((selectedHome === undefined || selectedHome.length === 0) && overridesHomeState(options)) {
        throw new Error(
            "startResidentHost was given explicit paths but no home. Pass `home` or set VERA_HOME so every path comes from one home.",
        );
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
    readonly authorization?: CodexCatalogAuthorization;
}

/** A refresh outcome plus the provider's full list when the answer was authoritative. */
export interface CatalogRefreshListing {
    readonly provider: string;
    readonly outcome: CatalogRefreshOutcome;
    /** Present only for a full, parsed, non-empty answer with no failure. */
    readonly listed?: readonly string[];
}

export async function refreshProviderCatalogs(
    config: VeraConfig,
    options: CatalogRefreshOptions = {},
): Promise<readonly CatalogRefreshOutcome[]> {
    return (await refreshProviderCatalogListings(config, options)).map((entry) => entry.outcome);
}

export async function refreshProviderCatalogListings(
    config: VeraConfig,
    options: CatalogRefreshOptions = {},
): Promise<readonly CatalogRefreshListing[]> {
    const cacheOptions = options.cacheDir === undefined
        ? {}
        : { cacheDir: options.cacheDir };
    const authStorage = options.authStorage ?? createAuthStorage();
    const descriptors = standardProviderDescriptors(config);
    const ollamaEnabled = providerEnabled(config, "ollama");
    const openrouterEnabled = providerEnabled(config, "openrouter");
    const codexEnabled = providerEnabled(config, OPENAI_CODEX_PROVIDER_ID);
    const [ollama, openrouter, standard, codex] = await Promise.all([
        ollamaEnabled
            ? discoverOllamaModelCatalog({
                ...cacheOptions,
                ...(config.provider_endpoints?.ollama === undefined
                    ? {}
                    : { host: config.provider_endpoints.ollama }),
            })
            : undefined,
        openrouterEnabled && hasOpenRouterCredential(config)
            ? discoveredOpenRouterModelsResult(config, {
                ...cacheOptions,
                maxAgeMs: 0,
            })
            : undefined,
        Promise.all(descriptors.map((descriptor) =>
            standardProviderModels(descriptor, config, authStorage, {
                ...cacheOptions,
                maxAgeMs: 0,
            })
        )),
        codexEnabled
            ? refreshCodexCatalog(authStorage, {
                ...cacheOptions,
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
            })
            : undefined,
    ]);
    const listings: CatalogRefreshListing[] = [];
    if (ollama !== undefined && ollama.available) {
        const models = ollama.models.map((model) => model.model);
        listings.push({
            provider: "ollama",
            outcome: { provider: "ollama", models: models.length },
            ...(models.length === 0 ? {} : { listed: models }),
        });
    } else if (ollama !== undefined) {
        listings.push({
            provider: "ollama",
            outcome: { provider: "ollama", failure: "unavailable" },
        });
    }
    if (!openrouterEnabled) {
        // Off providers get no listing, so the daily scan records no miss for them.
    } else if (openrouter === undefined) {
        listings.push({
            provider: "openrouter",
            outcome: { provider: "openrouter", failure: "missing_credential" },
        });
    } else if (openrouter.failure !== undefined) {
        listings.push({
            provider: "openrouter",
            outcome: {
                provider: "openrouter",
                failure: openrouter.failure,
                ...(openrouter.keptModels === 0
                    ? {}
                    : { keptModels: openrouter.keptModels }),
            },
        });
    } else {
        const models = openrouter.models.map((model) => model.model);
        listings.push({
            provider: "openrouter",
            outcome: { provider: "openrouter", models: models.length },
            ...(models.length === 0 ? {} : { listed: models }),
        });
    }
    for (const [index, result] of standard.entries()) {
        const descriptor = descriptors[index]!;
        listings.push({
            provider: descriptor.id,
            outcome: standardRefreshOutcome(descriptor.id, result),
            ...(result.failure === undefined && result.models.length > 0
                ? { listed: result.models.map((model) => model.model) }
                : {}),
        });
    }
    if (codex !== undefined) {
        listings.push(codexListing(codex, options.cacheDir));
    }
    return listings;
}

function codexListing(
    outcome: CatalogRefreshOutcome,
    cacheDir: string | undefined,
): CatalogRefreshListing {
    if (outcome.failure !== undefined) {
        return { provider: outcome.provider, outcome };
    }
    const saved = readCodexCatalog(cacheDir).models.map((model) => model.id);
    return {
        provider: outcome.provider,
        outcome,
        ...(saved.length === 0 || saved.length !== outcome.models ? {} : { listed: saved }),
    };
}

// Signed out returns undefined: Codex is optional, unlike the configured providers.
export async function refreshCodexCatalog(
    authStorage: AuthStorage,
    options: {
        readonly cacheDir?: string;
        readonly fetch?: typeof globalThis.fetch;
        readonly log?: HostLog;
        readonly authorization?: CodexCatalogAuthorization;
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
        providerEnabled(config, provider.id) &&
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
        providerEnabled(config, "ollama")
            ? discoveredOllamaModels({
                log,
                ...cacheOptions,
                ...(config.provider_endpoints?.ollama === undefined
                    ? {}
                    : { host: config.provider_endpoints.ollama }),
            })
            : Promise.resolve([] as readonly SuggestedModel[]),
        providerEnabled(config, "openrouter")
            ? discoveredOpenRouterModels(config, { ...cacheOptions, maxAgeMs })
            : Promise.resolve([] as readonly SuggestedModel[]),
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
        configuredProviders(config)
            .filter((provider) => providerEnabled(config, provider.id))
            .map((provider) => provider.id),
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
        withCachedWindows(
            catalog.filter((model) => providerEnabled(config, model.provider)),
            readCachedWindowIndex(cacheOptions),
        ),
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
    if (!providerEnabled(config, "cerebras")) return [];
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
    if (!providerEnabled(config, OPENAI_CODEX_PROVIDER_ID)) return [];
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
        complete.filter((model) => providerEnabled(config, model.provider)),
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
    if (!providerEnabled(config, "deepseek")) return [];
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
    return (await discoveredOpenRouterModelsResult(config, options)).models;
}

export interface OpenRouterDiscoveryResult {
    readonly models: readonly SuggestedModel[];
    readonly failure?: OpenRouterCatalogFailure;
    /** Models already on disk when the fetch failed or returned nothing usable. */
    readonly keptModels: number;
}

export async function discoveredOpenRouterModelsResult(
    config: VeraConfig,
    options: OpenRouterDiscoveryOptions = {},
): Promise<OpenRouterDiscoveryResult> {
    if (!providerEnabled(config, "openrouter")) {
        return { models: [], keptModels: 0 };
    }
    if (!hasOpenRouterCredential(config)) {
        return { models: [], keptModels: 0 };
    }
    const moved = config.provider_endpoints?.openrouter;
    const refreshed = await refreshOpenRouterCatalogResult(
        moved === undefined || options.endpoint !== undefined
            ? options
            : { ...options, endpoint: providerEndpointUrl(moved, "/models") },
    );
    const catalog = refreshed.catalog;
    if (catalog === undefined) {
        return {
            models: [],
            keptModels: 0,
            ...(refreshed.failure === undefined
                ? {}
                : { failure: refreshed.failure }),
        };
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
    return {
        models: catalog.models.map((model) => ({
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
        })),
        ...(refreshed.failure === undefined
            ? {}
            : { failure: refreshed.failure }),
        keptModels: refreshed.keptModels,
    };
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

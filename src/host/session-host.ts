import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configuredTurnPolicy } from "../turn-policy.ts";
import { defaultTrustNoticePath, TrustNoticeStore } from "./trust-notice.ts";

import {
    configuredCompaction,
    configuredCompactionModels,
    configuredCompactionOverrides,
    configuredModelFallback,
    configuredOverrides,
    configuredReviewer,
    configuredReviewers,
    configuredSubagentModel,
    configuredToolResults,
    eventLogEnabled,
    type VeraConfig,
} from "../config.ts";
import { defaultEventLogPath, eventLogRoot } from "../engine/events.ts";
import { createReviewLogger, defaultReviewLogPath } from "../engine/review-log.ts";
import { workerExtensionConfigs } from "../extensions/host-set.ts";
import { adapterCacheFingerprint } from "../providers/routing.ts";
import { ModelFailureLedger } from "../store/model-failures.ts";
import { reserveSessionIdentity } from "./session-identity-reservation.ts";
import { createWorkerAdapterOptions } from "./worker/adapter.ts";

import {
    defaultPermissionPreferencesPath,
    PermissionPreferenceStore,
} from "../engine/permission-preferences.ts";
import { credentialFingerprint } from "../providers/auth-storage.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";
import type { FailedRequestCapture } from "../providers/failed-request-capture.ts";
import { OpenRouterAllowanceGuard } from "../providers/openrouter-allowance-guard.ts";
import { skillScriptTool } from "../skills/script.ts";
import {
    AgentRegistry,
    type RegisteredAgentSummary,
} from "./agent-registry.ts";
import { workerExtensionsEnabled } from "./agent-registry/helpers.ts";
import { createExtensionHostServices } from "./extension-host-services.ts";
import { SessionImportNotes } from "./session-import-note.ts";

import { startSessionExtensions } from "./session-host/extensions.ts";
import { createSessionHandlers } from "./session-host/handlers.ts";
import { createSessionHooks } from "./session-host/hooks.ts";
import { indexClosedMembers, indexStoredSessions } from "./session-host/storage.ts";
import type { ExtensionSessionServices, SessionHost, StartSessionHostOptions } from "./session-host/types.ts";

export type { SessionHost, StartSessionHostOptions } from "./session-host/types.ts";

export async function startSessionHost(options: StartSessionHostOptions): Promise<SessionHost> {
    const {
        home, configPath, cacheDirectory, sessionDirectory, sessionIdentityReservationRoot,
        blockedDirectory, modelFailureLedgerPath, authStorage, currentConfig, currentReachability,
        hostLog, startupFindings, timed, eventLogDirectory,
    } = options;
    const logDirectory = eventLogRoot(home);
    const reviewLog = createReviewLogger({ path: defaultReviewLogPath(home) });
    const permissionPreferences = await timed("permission_preferences", () =>
        PermissionPreferenceStore.open(
            options.permissionPreferencesPath
            ?? defaultPermissionPreferencesPath(home),
        )
    );
    const { extensions, sessionIdentity, extensionLoadFailures } = await startSessionExtensions(options);
    const hasModelRequestHooks = extensions.modelRequestHooks().length > 0;
    const openRouterAllowanceGuard = new OpenRouterAllowanceGuard();
    const sessionImportNotes = new SessionImportNotes((sessionId) => join(sessionDirectory, `${sessionId}.jsonl`));
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
    const services = options.createServices(createAdapter, options.sessionWorker);
    const eventLogPathForId = eventLogEnabled(currentConfig())
        ? (agentId: string, cwd: string) =>
            eventLogDirectory === undefined
                ? defaultEventLogPath(agentId, cwd, logDirectory)
                : join(eventLogDirectory, `${agentId}.jsonl`)
        : undefined;
    const storedSessionIndex = new Map<string, RegisteredAgentSummary>();
    const registry: AgentRegistry = new AgentRegistry({
        ...services.models,
        ...createSessionHooks({ currentConfig, extensions, hostLog, home, startupFindings, sessionImportNotes }),
        sessionBlockDirectory: blockedDirectory,
        turnsHeld: (): boolean => options.turnsHeld(),
        credentialFingerprint: (provider) => adapterCacheFingerprint(
            currentConfig(),
            credentialFingerprint(authStorage, provider),
            provider,
        ),
        createAdapter,
        modelMiddleware: extensions.modelMiddleware(),
        ...(options.sessionWorker === true || options.createAdapter !== undefined || hasModelRequestHooks
            || (!workerExtensionsEnabled()
                && extensions.modelMiddleware().length > 0)
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
        cacheDir: cacheDirectory,
        home,
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
        get compaction() {
            return configuredCompaction(currentConfig());
        },
        configuredOverrides: () => configuredOverrides(currentConfig()),
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
        trustNotices: {
            tools: extensions.installedUnreviewedTools(),
            store: new TrustNoticeStore(defaultTrustNoticePath(home)),
        },
        workerExtensions: () => workerExtensionConfigs(currentConfig()),
        registeredAgents: extensions.agents(),
        sessionIdentity,
        reserveSessionIdentity: (sessionId, key) =>
            reserveSessionIdentity(sessionIdentityReservationRoot, sessionId, key),

        get disabledPromptContributions() {
            return currentConfig().disabled_prompt_contributions;
        },
        get promptContributionOrder() {
            return currentConfig().prompt_contribution_order;
        },
        readConfiguredTurnPolicy: () => configuredTurnPolicy(currentConfig()),
        inboxDelivery: services.inboxDelivery,
        inboxActorForSession: () => options.inboxActorForSession(),
        sessionPathForId: (agentId) =>
            join(sessionDirectory, `${agentId}.jsonl`),
        modelFailureLedger: new ModelFailureLedger(
            modelFailureLedgerPath,
        ),
        ...(eventLogPathForId === undefined ? {} : { eventLogPathForId }),
        ...(options.trashSessionArtifacts === undefined
            ? {}
            : { trashSessionArtifacts: options.trashSessionArtifacts }),
        onSessionsClosed: (members): Promise<void> =>
            indexClosedMembers(registry, members, storedSessionIndex),
    });
    const localExtensionSessions = createExtensionHostServices({
        registry,
        currentConfig,
        reachability: currentReachability,
        createAdapter: () => createAdapter(),
        annexUrl: options.annexUrl,
        availableModels: () => registry.availableModels,
    });
    let extensionSessions: ExtensionSessionServices = localExtensionSessions;
    extensions.bindHost({
        ...localExtensionSessions,
        setSessionTitle: (id, title) => extensionSessions.setSessionTitle(id, title),
        sendToSession: (extensionId, id, text) => extensionSessions.sendToSession(extensionId, id, text),
        askSession: (call, signal) => extensionSessions.askSession(call, signal),
        investigate: (call, signal) => extensionSessions.investigate(call, signal),
    });

    let publishStoredSessions: (sessions: ReadonlyMap<string, RegisteredAgentSummary>) => void = () => { };
    const storedSessions = new Promise<ReadonlyMap<string, RegisteredAgentSummary>>((resolve) => {
        publishStoredSessions = resolve;
    });
    const handlers = createSessionHandlers({
        registry, extensions, extensionLoadFailures, sessionDirectory, blockedDirectory,
        modelFailureLedgerPath, storedSessionIndex, storedSessions, eventLogPathForId,
        importRoots: options.importRoots,
        restoringSessions: options.restoringSessions,
        ...(options.shard === undefined ? {} : { shard: options.shard }),
        forgetRestartRecords: options.forgetRestartRecords,
        recentScheduleRuns: options.recentScheduleRuns,
        onWorkChanged: options.onWorkChanged,
        hostLog,
    });
    let parkIdleTimer: ReturnType<typeof setInterval> | undefined;
    let parkIdle = async (): Promise<void> => {
        const closed = await registry.parkExpiredIdle();
        await indexClosedMembers(registry, closed, storedSessionIndex);
    };
    let storageStarted = false;
    const stopMaintenance = (): void => {
        if (parkIdleTimer !== undefined) {
            clearInterval(parkIdleTimer);
            parkIdleTimer = undefined;
        }
    };
    return {
        registry, extensions, handlers, createAdapter, localExtensionSessions, inboxDelivery: services.inboxDelivery,
        setExtensionSessions(services) {
            extensionSessions = services;
        },
        setParkIdle(park) {
            parkIdle = park;
        },
        startStorage(storageOptions) {
            if (storageStarted) return;
            storageStarted = true;
            if (storageOptions?.scan === false) publishStoredSessions(storedSessionIndex);
            else void indexStoredSessions(sessionDirectory, storedSessionIndex, hostLog, options.shard).then(publishStoredSessions);
            parkIdleTimer = setInterval(() => {
                void parkIdle().catch(() => { });
            }, 30_000);
        },
        stopMaintenance,
        async clearProviderSelection(provider) {
            for (const entry of registry.agents.values()) {
                if (entry.modelSettings.provider !== provider) continue;
                const settings = { ...entry.modelSettings, selectionCleared: true };
                await entry.store.appendModelSettings(settings, registry.originFor(entry, settings));
                entry.modelSettings = settings;
                registry.pushWorkerState(entry.agent.id);
                registry.announceSessionUpdated(entry);
            }
        },
        async closeAfterStartupFailure() {
            stopMaintenance();
            try {
                await extensions.close();
            } catch {
            }
            await registry.close();
        },
        async close() {
            stopMaintenance();
            // Sessions close first so their session_end hooks still have extensions to reach.
            try {
                await registry.close();
            } finally {
                await extensions.close();
            }
        },
    };
}

function scoped(projectRoot?: string): { readonly projectRoot?: string } {
    return projectRoot === undefined ? {} : { projectRoot };
}

const WORKER_ADAPTER_MODULE = fileURLToPath(
    new URL("./worker/adapter.ts", import.meta.url),
);

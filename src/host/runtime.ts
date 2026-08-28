import { readdir, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { join } from "node:path";

import {
    configuredModelFallback,
    configuredReviewer,
    configuredSubagentModel,
    configuredCompaction,
    configuredCompactionModels,
    configuredReviewers,
    defaultVeraConfigPath,
    developerOverrides,
    eventLogEnabled,
    loadVeraConfig,
    updateVeraConfigDefaults,
    type VeraProviderId,
    type VeraConfig,
} from "../config.ts";
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
import type { SuggestedModel } from "../model/supported-models.ts";
import { pooledModels } from "../model/catalog-view.ts";
import type {
    CatalogModel,
    ReasoningLevel,
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

const hostLog = createHostLogger();
const reviewLog = createReviewLogger();
import {
    addPoolModel,
    recordLearned,
    movePoolModel,
    namePoolModel,
    readUserPoolFile,
    removePoolModel,
    PoolFileWriteRefusedError,
} from "../model/pool-file-store.ts";
import { loadPoolFile } from "../model/pool-file-loader.ts";
import { poolReachability } from "../model/assignment-reachability.ts";
import { poolNameRefusal } from "../model/pool-names.ts";
import { admitToPool } from "../model/pool-admission.ts";
import { createFeedRowReader } from "../model/feed-cache.ts";
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
import { veraRuntimeDirectory } from "../profile-paths.ts";
import type { WatchConnector } from "../watch/source.ts";
import type { SpawnSessionFn } from "./inbox-spawn.ts";
import {
    AgentRegistry,
    type RegisteredAgentSummary,
} from "./agent-registry.ts";
import { subagentPoolPolicy } from "./subagent-policy.ts";
import { createCommandHook } from "../extensions/command-hook.ts";
import type {
    PostToolUseHook,
    PreToolUseHook,
} from "../sdk/hooks.ts";
import type { ResidentAgent } from "./resident-agent.ts";
import { startHostServer, type HostServer } from "./server.ts";
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

/** Schedule runs read per index build. The recent window trims them further. */
const MAX_SCHEDULE_WORK_ROWS = 50;

export interface StartResidentHostOptions {
    readonly config: VeraConfig;
    readonly createAdapter?: () => ModelAdapter;
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    /** Absolute path of the entrypoint this host was started from. */
    readonly entrypoint?: string;
    /** Project whose project-scoped extensions this host loaded. */
    readonly projectRoot?: string;
    readonly sessionDirectory?: string;
    /** Overrides `~/.vera/preferences.json`, so tests do not read the
     * developer's real preferences. */
    readonly permissionPreferencesPath?: string;
    /** Overrides `~/.vera/auth.json`, so tests never read real credentials. */
    readonly authStorage?: AuthStorage;
    readonly eventLogDirectory?: string;
    /** Overrides the profile's model-failure ledger, so tests never write it. */
    readonly modelFailureLedgerPath?: string;
    /** Overrides `~/.vera/inbox.db`. Unused while the inbox flag is off. */
    readonly inboxPath?: string;
    /** Overrides the user config path used by an always inbox admission. */
    readonly inboxUserConfigPath?: string;
    /** Overrides `~/.vera/schedules.db`. Unused while the inbox flag is off. */
    readonly schedulePath?: string;
    /** Replaces the built-in connector set, so tests never reach a real arc. */
    readonly watchConnectors?: readonly WatchConnector[];
    /** Overrides arc's per-user config path, so tests never read the real one. */
    readonly arcConfigPath?: string;
    /** Supplies a watch its bearer token. Definitions never carry one. */
    readonly watchSecret?: WatchSecretResolver;
    /** Overrides `~/.vera/.../logs/sidecars`, so tests write under a tmp dir. */
    readonly sidecarLogDirectory?: string;
    /** @deprecated Inbox arrivals no longer cold-spawn sessions. */
    readonly spawnConsentPath?: string;
    /** @deprecated Inbox arrivals no longer cold-spawn sessions. */
    readonly spawnSession?: SpawnSessionFn;
    readonly onExtensionFailure?: (
        failure: ExtensionRegistryFailure,
    ) => void;
    /** Receives startup diagnostics. Defaults to the resident host log. */
    readonly startupLog?: HostLog;
    /** Collects what extension startup found; tests read it back. */
    readonly startupFindings?: StartupFindings;
}

export interface ResidentHost {
    readonly registry: AgentRegistry;
    readonly extensions: ExtensionRegistry;
    readonly server: HostServer;
    /** Resolves as soon as any caller starts closing this resident host. */
    readonly shutdownRequested: Promise<void>;
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
    // Before anything reads or writes the pool file: the old keys are only
    // findable while pool.json is still absent.
    const migration = migrateConfigPool();
    if (migration.notice !== undefined) {
        hostLog({ type: "pool_migrated", message: migration.notice });
    }
    const reviewer = configuredReviewer(options.config);
    // The config as it stands on disk, not as it stood when the host came up.
    // Every setting below is read through this, so changing one in the
    // settings pane reaches the next session that starts and nothing has to be
    // restarted under the user.
    //
    // Re-read only when the file has moved on, because some of these are asked
    // on every subagent spawn. A file that is mid-edit or unreadable keeps the
    // last good answer: a bad save must not take a session's settings with it.
    let lastConfig = options.config;
    let lastStamp = "";
    const currentConfig = (): VeraConfig => {
        const path = defaultVeraConfigPath();
        try {
            const stat = statSync(path);
            const stamp = `${stat.mtimeMs}:${stat.size}`;
            if (stamp === lastStamp) {
                return lastConfig;
            }
            const loaded = loadVeraConfig({ path });
            lastStamp = stamp;
            lastConfig = loaded;
        } catch {
            // Absent, mid-write, or malformed: keep what last parsed.
        }
        return lastConfig;
    };
    // The pool is what says a model can be used, so assignment bindings are
    // judged against it rather than against the catalog alone. User scope
    // only: these bindings are read before any project is known.
    const currentReachability = () => poolReachability(loadPoolFile({}).merged);
    const sessionDirectory = options.sessionDirectory
        ?? defaultSessionDirectory();
    const eventLogDirectory = options.eventLogDirectory;
    // One store for the host, so a sign-in from anywhere is the same fact to
    // every agent it is running.
    const authStorage = options.authStorage ?? createAuthStorage();
    let models = await timed("model_discovery", () =>
        options.createAdapter === undefined
            ? discoverAvailableModels(options.config, authStorage)
            : configuredCatalog(options.config)
    );
    let catalogRefreshes: Promise<void> = Promise.resolve();
    // Opened once per host, not per agent: the file is per-user. A malformed
    // or missing file reads as no preferences rather than failing startup, so
    // this cannot block the host from coming up.
    const permissionPreferences = await timed("permission_preferences", () =>
        PermissionPreferenceStore.open(options.permissionPreferencesPath)
    );
    // Startup runs before any session exists, so what it finds waits here
    // until a session's first turn can carry it into the agent's context.
    const startupFindings = options.startupFindings ?? new StartupFindings();
    const extensions = await timed(
        "extension_registry",
        () => startExtensionRegistry({
            extensions: options.config.extensions ?? [],
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
    const hasModelRequestHooks = extensions.modelRequestHooks().length > 0;
    const openRouterAllowanceGuard = new OpenRouterAllowanceGuard();
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
                openRouterAllowanceGuard,
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
        : new InboxDeliveryCoordinator(consumers, {
            admissionFor: (projectRoot) => projectRoot === undefined
                ? undefined
                : InboxAdmissionPolicy.fromConfig(
                    options.config,
                    projectRoot,
                    options.inboxUserConfigPath,
                ),
        });
    /**
     * The index derived for the fan-out currently running, held only until the
     * event loop turns.
     *
     * Every client asks for the index on the same transition and the answer is
     * the same for all of them, but deriving it stats each session and scans
     * its stash, so the unshared version cost that once per client. Dropping
     * it on the next microtask keeps it from outliving the fan-out that built
     * it, so nothing can read a roster that has since changed.
     */
    let workIndexThisTurn: WorkIndexSnapshot | undefined;
    const workChangeListeners = new Set<() => void>();
    const notifyWorkChanged = (): void => {
        for (const listener of [...workChangeListeners]) {
            try {
                listener();
            } catch {
                // One client's bookkeeping cannot break the firing that
                // triggered it, or a schedule would stop running.
            }
        }
    };
    const scheduleStore = inbox === null
        ? null
        : ScheduleStore.open(options.schedulePath);
    // Watches are started after the extension registry, because their
    // definitions are extension contributions. The runtime holds the reference
    // so shutdown stops the connector tasks before the log they write to closes.
    let watches: WatchRuntime | null = null;
    let scheduler: SchedulerRuntime | null = null;
    // Sidecars are started after the server, because the socket path they
    // receive is the started server's. They stop first on shutdown, so a
    // child never outlives the socket it talks to.
    let sidecars: SidecarRuntime | null = null;
    const closeSidecars = async (): Promise<void> => {
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
    // One reader for the whole runtime: the feed is loaded on the first
    // verify and every later admission reads the same copy.
    const readFeedRow = createFeedRowReader(
        options.config.model_feed_url === undefined
            ? {}
            : { url: options.config.model_feed_url },
    );
    const registry = new AgentRegistry({
        credentialFingerprint: (provider) =>
            credentialFingerprint(authStorage, provider),
        createAdapter,
        // Offered only when this host's adapter is the configured one and
        // nothing live wraps it. An injected factory and a model-request hook
        // are both functions, and a function does not cross to a worker.
        ...(options.createAdapter !== undefined || hasModelRequestHooks
            ? {}
            : {
                workerAdapterSpec: (context: {
                    readonly provider: string;
                    readonly projectRoot: string;
                    readonly sessionId: string;
                }) => ({
                    module: WORKER_ADAPTER_MODULE,
                    export: "createWorkerAdapter",
                    options: { ...context, config: currentConfig() },
                }),
            }),
        provider: options.config.provider,
        customProviderIds: () => Object.keys(currentConfig().providers ?? {}),
        model: options.config.model,
        approvalMode: options.config.approval_mode,
        availableModels: models,
        refreshAvailableModels: options.createAdapter === undefined
            ? () => {
                models = refreshDynamicAvailableModels(
                    models,
                    currentConfig(),
                    authStorage,
                );
                return models;
            }
            : undefined,
        refreshableProviders: () => {
            const config = currentConfig();
            return configuredProviders(config)
                .filter((provider) =>
                    isRefreshableProvider(provider.id, config)
                )
                .map((provider) => provider.id);
        },
        refreshCatalog: (provider) => {
            // One at a time. A refresh reads the discovered list, replaces one
            // provider's rows in it and writes it back, so two overlapping
            // refreshes would each build on the list the other started from
            // and whichever finished second would undo the first.
            const refreshed = catalogRefreshes.then(async () => {
                const config = currentConfig();
                if (!isRefreshableProvider(provider, config)) return undefined;
                const descriptor = configuredProviders(config)
                    .find((entry) => entry.id === provider);
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
                // A provider that cannot be reached answers from its snapshot,
                // which is the right list to keep and the wrong thing to call
                // a refresh: the user pressed the key to find out whether they
                // are current. The snapshot's own timestamp is what says a
                // request actually landed, so it is read either side of the
                // call.
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
            });
            // The queue carries the turn, not its failure: one refresh that
            // throws must not leave every later one rejected.
            catalogRefreshes = refreshed.then(() => undefined, () => undefined);
            return refreshed;
        },
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
                readFeedRow,
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
        movePoolEntry: (entry, delta) => {
            const id = `${entry.provider}/${entry.model}`;
            let held = false;
            const refused = refusedPoolWrite(() => {
                // Order lives in the user file, so an entry only the project
                // overlay declares cannot be reordered from here.
                held = Object.hasOwn(readUserPoolFile().models, id);
                if (held) movePoolModel(id, delta);
            });
            // Success is "the pool holds this and the order now reads the way
            // the move asked for", not "the order changed". A move off either
            // end clamps, and clamping is the answer, not a failure.
            return refused === undefined && held;
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
        contextLimit: () => {
            const config = currentConfig();
            // The developer value wins outright rather than clamping against
            // the normal one: it exists to reach windows the normal setting
            // will not offer, so a minimum taken with it would be it anyway.
            return developerOverrides(config)?.context_limit
                ?? config.context_limit;
        },
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
        ...(reviewer === undefined ? {} : { reviewer }),
        get subagentModel() {
            return configuredSubagentModel(currentConfig());
        },
        // Read on every session start rather than captured here, so binding a
        // reviewer takes effect on the next session and not the next launch.
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
        developerSettings: () => {
            const developer = currentConfig().developer;
            return {
                enabled: developer?.enabled === true,
                ...(developer?.context_limit === undefined
                    ? {}
                    : { contextLimit: developer.context_limit }),
                ...(developer?.compaction_trigger_fraction === undefined
                    ? {}
                    : {
                        compactionTriggerFraction:
                            developer.compaction_trigger_fraction,
                    }),
                ...(developer?.post_compaction_target_fraction === undefined
                    ? {}
                    : {
                        postCompactionTargetFraction:
                            developer.post_compaction_target_fraction,
                    }),
                ...(developer?.summary_word_cap === undefined
                    ? {}
                    : { summaryWordCap: developer.summary_word_cap }),
            };
        },
        updateDeveloperSettings: (patch) => {
            updateVeraConfigDefaults({
                developer: {
                    ...(patch.enabled === undefined
                        ? {}
                        : { enabled: patch.enabled }),
                    ...(patch.contextLimit === undefined
                        ? {}
                        : { context_limit: patch.contextLimit }),
                    ...(patch.compactionTriggerFraction === undefined
                        ? {}
                        : {
                            compaction_trigger_fraction:
                                patch.compactionTriggerFraction,
                        }),
                    ...(patch.postCompactionTargetFraction === undefined
                        ? {}
                        : {
                            post_compaction_target_fraction:
                                patch.postCompactionTargetFraction,
                        }),
                    ...(patch.summaryWordCap === undefined
                        ? {}
                        : { summary_word_cap: patch.summaryWordCap }),
                },
            });
        },
        get compactionOverrides() {
            const developer = developerOverrides(currentConfig());
            if (developer === undefined) {
                return undefined;
            }
            return {
                ...(developer.compaction_trigger_fraction === undefined
                    ? {}
                    : { triggerFraction: developer.compaction_trigger_fraction }),
                ...(developer.post_compaction_target_fraction === undefined
                    ? {}
                    : {
                        postCompactionTargetFraction:
                            developer.post_compaction_target_fraction,
                    }),
                ...(developer.summary_word_cap === undefined
                    ? {}
                    : { summaryWordCap: developer.summary_word_cap }),
            };
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
        workerExtensions: () => {
            const config = currentConfig();
            return config.extensions ?? [];
        },
        registeredAgents: extensions.agents(),
        loadContextualContributions: async (instructionRoot, allowedSkills) => [
            ...await loadSkillContribution(instructionRoot, allowedSkills),
            ...startupFindings.contributions(),
        ],
        createToolHooks: () => {
            const hooks = new ToolHooks();
            registerConfiguredHooks(hooks, currentConfig());
            for (const hook of extensions.preToolUseHooks()) {
                hooks.registerPreToolUse(hook);
            }
            for (const hook of extensions.postToolUseHooks()) {
                hooks.registerPostToolUse(hook);
            }
            return hooks;
        },
        ...(!hasModelRequestHooks ? {} : {
            prepareModelRequest: ({ sessionId, workspace }) => async (request) => {
                const body: Record<string, import("../sdk/hooks.ts").JsonValue> = {};
                for (const hook of extensions.modelRequestHooks()) {
                    const value = await hook.run({
                        type: "model_request",
                        provider: request.provider ?? currentConfig().provider,
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
                return Object.keys(body).length === 0
                    ? request
                    : {
                        ...request,
                        bodyExtensions: { ...request.bodyExtensions, ...body },
                    };
            },
        }),
        get disabledPromptContributions() {
            return currentConfig().disabled_prompt_contributions;
        },
        ...(inboxDelivery === undefined ? {} : {
            inboxDelivery,
            // Read per attach, not once at startup, because `arc init` can
            // mint the node id while the host runs. arc stamps events with
            // (node id, ARC_SESSION); the attach pairs this actor with the
            // session's minted identity name, so a session posting under
            // ARC_SESSION set to its name is not woken by its own posts.
            inboxActorForSession: () => readArcNodeId(options.arcConfigPath),
        }),
        sessionPathForId: (agentId) =>
            join(sessionDirectory, `${agentId}.jsonl`),
        // Always on, unlike the event log: this is the record that tells
        // someone their model keeps failing, and it is a few hundred lines.
        modelFailureLedger: new ModelFailureLedger(
            options.modelFailureLedgerPath ?? defaultModelFailureLedgerPath(),
        ),
        ...(eventLogEnabled(currentConfig())
            ? {
                eventLogPathForId: (agentId: string, cwd: string) =>
                    eventLogDirectory === undefined
                        ? defaultEventLogPath(agentId, cwd)
                        : join(eventLogDirectory, `${agentId}.jsonl`),
            }
            : {}),
    });

    let server: HostServer;
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
            closing = closeResidentHost(
                server,
                registry,
                extensions,
                closeInbox,
                closeSidecars,
            );
        }
        return closing;
    };
    try {
        watches = startWatchRuntimeIfEnabled(inbox, {
            watches: extensions.contributions().watches(),
            ...(options.watchConnectors === undefined
                ? {}
                : { connectors: options.watchConnectors }),
            // The host holds credentials; a watch definition is committed
            // data and never carries one. Absent an injected resolver, every
            // watch authenticates with this machine's arc token.
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
                // A firing changes the work inbox without touching the roster,
                // so without this the run is recorded and no attached client
                // is ever told about it.
                onRunEmitted: notifyWorkChanged,
                onError: (error) => hostLog({
                    type: "scheduler_failed",
                    message: error instanceof Error
                        ? error.message
                        : String(error),
                }),
                })
        );
        // Bounded at the query and best effort: the index is rebuilt on every
        // roster change, and a schedule database that cannot be read is no
        // reason to lose the sessions beside it.
        const recentScheduleRuns = (): readonly EmittedScheduleRun[] => {
            try {
                return scheduleStore?.recentlyEmitted(MAX_SCHEDULE_WORK_ROWS)
                    ?? [];
            } catch {
                return [];
            }
        };
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
            ...(options.entrypoint === undefined
                ? {}
                : { entrypoint: options.entrypoint }),
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
            listAgents: async () => mergeStoredAndResidentAgents(
                await storedSessions,
                registry.list(),
            ),
            // Facts are read for the page the server sliced, never for the
            // whole listing: a profile holds thousands of sessions and each
            // usage fold is a file scan.
            readSessionFacts: (sessions, include) =>
                enrichSessionsWithFacts(
                    sessions,
                    include,
                    options.modelFailureLedgerPath
                        ?? defaultModelFailureLedgerPath(),
                ),
            listBackgroundAgents: () => registry.list(),
            // Bounded and best effort: the work index is drawn on every
            // roster change, and a schedule database that cannot be read is
            // no reason to lose the sessions beside it.
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
            // Two sources, one subscription: what a client draws changes when
            // the roster changes and when a schedule fires, and a client that
            // subscribed to only the first would miss every scheduled run.
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
            trashSession: (targetId) => registry.trashSession(targetId),
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
                // Nothing live under that id. Closing something already closed
                // is the state the caller asked for, so a durable session on
                // disk is acknowledged; an id nobody has ever seen is not.
                return await storedSessionExists(
                    targetId,
                    sessionDirectory,
                    storedSessionIndex,
                )
                    ? { status: "closed", sessionRetained: true }
                    : { status: "not_found" };
            },
            renameSession: (targetId, name) =>
                registry.renameSession(targetId, name),
            runOnce: async (runOptions) => {
                const result = await registry.runOnce(runOptions);
                // The agent is already closed and off the roster, so the
                // stored index is the only place the listing can learn of it.
                if (result.sessionPath !== "") {
                    await indexStoredSession(
                        result.sessionPath,
                        storedSessionIndex,
                    );
                }
                return result;
            },
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
            canReplace: () => registry.idleForReplacement(),
            onShutdownAccepted: closeHost,
            onAgentStartFailure: (operation, error) => hostLog({
                type: "agent_start_failed",
                operation,
                ...hostErrorFields(error),
            }),
            }),
        );
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
            // Preserve the host startup failure.
        }
        try {
            await extensions.close();
        } catch {
            // Preserve the host startup failure.
        }
        await registry.close();
        await closeInbox();
        throw error;
    }

    startupLog({
        type: "host_startup_complete",
        duration_ms: performance.now() - startupStarted,
    });
    return {
        registry,
        extensions,
        server,
        shutdownRequested,
        close: closeHost,
    };
}

/**
 * The pool overlay a workspace contributes. Absent workspace means user scope
 * only, which is what an embedded host with no checkout gets.
 */
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

/**
 * How long a discovered model list answers for before its provider is asked
 * again. Starting Vera is not a reason to call a provider: the lists change
 * over weeks, and Vera used to pay a request on every launch, before the host
 * was even discoverable. `vera models refresh` passes `0` to ask now.
 */
export function catalogMaxAgeMs(config: VeraConfig): number {
    const days = config.model_catalog_max_age_days;
    return days === undefined
        ? DEFAULT_CATALOG_MAX_AGE_MS
        : days * 24 * 60 * 60 * 1000;
}

export interface CatalogRefreshOutcome {
    readonly provider: string;
    /** Present only when a provider response was saved successfully. */
    readonly models?: number;
    readonly failure?: CatalogRefreshFailure;
    /** Rows retained from an older snapshot after a failed request. */
    readonly keptModels?: number;
}

export type CatalogRefreshFailure =
    | ProviderCatalogFailure
    | "missing_credential"
    | "persistence_failed"
    | "invalid";

export interface CatalogRefreshOptions {
    readonly authStorage?: AuthStorage;
    readonly cacheDir?: string;
}

/**
 * Asks every discoverable provider now and rewrites its snapshot, which is
 * what `vera models refresh` is for: the TTL means an ordinary start does not
 * do this, so there has to be a way to say "a model came out today".
 *
 * A provider with no credential is reported as skipped rather than as empty,
 * since the two look the same in the picker and only one of them is something
 * the user can act on. Ollama and oMLX have no credential gate, so an
 * unavailable local daemon is reported separately from a reachable daemon
 * with no models.
 */
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

/** Replace one provider's live list, including the valid empty-list case. */
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

/**
 * Replaces one provider's rows in an already discovered list, leaving every
 * other provider's rows exactly where they were.
 *
 * Rediscovering everything to refresh one provider would let an unrelated
 * provider that happens to be down at that moment drop out of the picker,
 * which is not something the user asked for by pressing refresh on an
 * OpenRouter row.
 */
export function withProviderRows(
    models: readonly SuggestedModel[],
    provider: string,
    rows: readonly SuggestedModel[],
): readonly SuggestedModel[] {
    if (rows.length === 0) {
        return models;
    }
    const named = new Set(rows.map((row) => row.model));
    // The placeholder for a configured model the provider does not list stays:
    // it is the row the session is running on.
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
    // Asked together rather than one after another: each provider caps its own
    // wait, and the host is not discoverable until all of them have answered,
    // so serial waits add up into the client's startup deadline.
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
    ]);
    catalog.push(...ollama);
    catalog.push(...standard.flatMap((result) => result.models));
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
    catalog.push(...discoveredDeepSeekModels(config, { authStorage }));
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
    return withProviderRefreshability(catalog, config);
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
    /** See `catalogMaxAgeMs`. `0` always asks the provider. */
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
        // A moved provider is discovered where it was moved to. Its own
        // public list lives on a different path from the chat endpoint, so
        // only the shipped case uses that path.
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
        // Discovery enriches the picker; it must never block host startup.
        return staleCerebrasModels(cacheOptions);
    }
}

/**
 * The last list Cerebras gave, however old. A snapshot too old to skip the
 * fetch is still the better answer when the fetch itself failed, which is the
 * same trade the OpenRouter catalog makes.
 */
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
            // Cerebras publishes no reasoning levels, so the entries carry
            // none: the snapshot says what the listing said and nothing more.
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
        // A snapshot Vera cannot write is not a reason to hide models it just
        // fetched. The next start tries again.
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

export interface OllamaDiscoveryResult {
    /** Whether `/v1/models` answered successfully, including an empty list. */
    readonly available: boolean;
    readonly models: readonly SuggestedModel[];
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
    /** Whether `/v1/models` answered successfully, including an empty list. */
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
    const moved = config.provider_endpoints?.openrouter;
    const catalog = await refreshOpenRouterCatalog(
        moved === undefined || options.endpoint !== undefined
            ? options
            : { ...options, endpoint: providerEndpointUrl(moved, "/models") },
    );
    if (catalog === undefined) {
        return [];
    }
    // Every row travels, including the ones the picker folds away. The reduction
    // is a mark on the row so that revealing the rest is a keypress in the
    // client rather than another request to the host.
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

/**
 * The index is built once at startup, so a session written since then is only
 * visible on disk. Both are checked before an id is called unknown.
 */
async function storedSessionExists(
    agentId: string,
    sessionDirectory: string,
    index: ReadonlyMap<string, RegisteredAgentSummary>,
): Promise<boolean> {
    if (index.has(agentId)) {
        return true;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
        return false;
    }
    try {
        return (await stat(
            join(sessionDirectory, `${agentId}.jsonl`),
        )).isFile();
    } catch {
        return false;
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
        // Resolve with the shared map either way: sessions indexed after
        // startup land in it, and a fresh map here would hide them.
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

/**
 * Index one session file into the stored-session map. Called for every file
 * at startup, after a run-once turn, and after a live tree close, so the
 * listing keeps covering sessions the registry no longer holds.
 */
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

/**
 * Fills one page of listing rows with the facts the caller named. The failure
 * ledger is profile-wide, so it is read once for the page rather than once per
 * row; usage and context need the session file and are read per row.
 */
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

/**
 * Wires the config's `hooks` entries into a session's hook chain. The paths
 * were bound to the profile's `hooks/` directory when the config was read, so
 * nothing here decides what a hook is allowed to run.
 */
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
        if (spec.phase === "pre_tool_use") {
            hooks.registerPreToolUse(hook as PreToolUseHook);
        } else {
            hooks.registerPostToolUse(hook as PostToolUseHook);
        }
    }
}

/** Imported by the worker, which builds the adapter for itself. */
const WORKER_ADAPTER_MODULE = fileURLToPath(
    new URL("./worker/adapter.ts", import.meta.url),
);

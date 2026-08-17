import { readdir, realpath, stat } from "node:fs/promises";
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
    eventLogEnabled,
    loadVeraConfig,
    updateVeraConfigDefaults,
    type VeraProviderId,
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
    namePoolModel,
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
    createAuthStorage,
    credentialFingerprint,
    type AuthStorage,
} from "../providers/auth-storage.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";
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
import { skillScriptTool } from "../skills/script.ts";
import { inboxEnabled, openInboxIfEnabled } from "../store/inbox.ts";
import { createConsumerRegistry } from "./consumers.ts";
import { InboxDeliveryCoordinator } from "./inbox-delivery.ts";
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
import { ScheduleStore } from "../scheduler/store.ts";
import {
    startSchedulerRuntime,
    type SchedulerRuntime,
} from "../scheduler/runtime.ts";
import { SCHEDULER_SOURCE } from "../scheduler/types.ts";

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
    let models = options.createAdapter === undefined
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
    const hasModelRequestHooks = extensions.modelRequestHooks().length > 0;
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
        registeredAgents: extensions.agents(),
        loadContextualContributions: loadSkillContribution,
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
        scheduler = scheduleStore === null || inboxDelivery === undefined
            ? null
            : await startSchedulerRuntime({
                store: scheduleStore,
                emit: (key, entry) =>
                    inboxDelivery.appendOnce(SCHEDULER_SOURCE, key, entry),
                onError: (error) => hostLog({
                    type: "scheduler_failed",
                    message: error instanceof Error
                        ? error.message
                        : String(error),
                }),
            });
        server = await startHostServer({
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
            findAgent: (agentId) => findOrRestoreAgent(
                registry,
                agentId,
                sessionDirectory,
                storedSessions,
                resumeSession,
            ),
            listAgents: async () => mergeStoredAndResidentAgents(
                await storedSessions,
                registry.list(),
            ),
            listBackgroundAgents: () => registry.list(),
            ...(scheduler === null ? {} : {
                runScheduleOperation: (operation) => scheduler!.execute(operation),
            }),
            onRosterChanged: (listener) => registry.onRosterChanged(listener),
            createAgent: (createOptions) => registry.create(createOptions),
            resumeAgent: resumeSession,
            branchAgent: (options) => registry.branch(options),
            discardBranch: async (agentId) => {
                await registry.trashSession(agentId);
            },
            commitBranch: (agentId) => registry.commitBranch(agentId),
            syncAgentContext: (agentId) => registry.syncBranchContext(agentId),
            trashSession: (targetId) => registry.trashSession(targetId),
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
        });
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

async function discoverAvailableModels(
    config: VeraConfig,
    authStorage: AuthStorage,
): Promise<readonly SuggestedModel[]> {
    const catalog = catalogModels(config);
    // Asked together rather than one after another: each provider caps its own
    // wait, and the host is not discoverable until all of them have answered,
    // so serial waits add up into the client's startup deadline.
    const [ollama, openrouter, cerebras] = await Promise.all([
        discoveredOllamaModels({
            log: hostLog,
            ...(config.provider_endpoints?.ollama === undefined
                ? {}
                : { host: config.provider_endpoints.ollama }),
        }),
        discoveredOpenRouterModels(config),
        discoveredCerebrasModels(config, { authStorage }),
    ]);
    catalog.push(...ollama);
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
    catalog.push(...cerebras);
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
    if (config.provider !== "deepseek") {
        return [...withoutDeepSeek, ...deepSeek];
    }
    if (deepSeek.some((model) => model.model === config.model)) {
        return [...withoutDeepSeek, ...deepSeek];
    }
    return [
        ...withoutDeepSeek,
        ...deepSeek,
        {
            provider: config.provider,
            model: config.model,
            label: config.model,
            description: "configured model",
        },
    ];
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
    const existing = registry.list().find(
        (agent) => agent.session_path === canonicalPath,
    );
    if (existing !== undefined) {
        const agent = registry.find(existing.id);
        if (agent !== undefined) {
            return agent;
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
 * at startup, and again for each session finished after startup (a run-once
 * turn closes its agent immediately), so the listing keeps covering sessions
 * the registry no longer holds.
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
            kind: "interactive",
            status: "completed",
            live: false,
            updated_at: fileStat?.mtime.toISOString() ?? header.timestamp,
            ...(metadata.title === undefined
                ? {}
                : { title: metadata.title.slice(0, 80) }),
            has_user_content: metadata.hasUserContent,
            ...(header.origin === undefined
                ? {}
                : { forked_from: header.origin.sessionId }),
            ...(size === undefined ? {} : { size_bytes: size }),
        });
    } catch {
        // A corrupt unopened session cannot block healthy lazy resumes.
    }
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

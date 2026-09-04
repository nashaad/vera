import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { EngineEventBus } from "../engine/events.ts";
import type { WorkAgentFacts, WorkScheduleFacts } from "./work-index.ts";
import type { ContextualContributionContext, PromptContribution } from "../engine/prompt-contributions.ts";
import type { PoolAdmissionVerdict } from "../engine/events.ts";
import { BUILT_IN_PERMISSION_MODE_NAMES, type ApprovalMode } from "../engine/permissions.ts";
import { ProviderUnavailableError, UserFacingError } from "../user-facing-error.ts";
import { isModelReasoningEffort, type ModelSettingsPatch, type ModelTurnSettings } from "../engine/model-settings.ts";
import type { EffectiveCatalogOptions } from "../model/catalog.ts";
import { runHeadlessLoop, sessionScratchDir } from "../engine/run-turn.ts";
import type { RunHeadlessLoopData, RunHeadlessLoopServices } from "../engine/loop-services.ts";
import { createRoutedCompletionService } from "../engine/completion-service.ts";
import { BUNDLED_COMPACTION_STRATEGIES, bindCompaction } from "../engine/compaction-binding.ts";
import type { ResolvedCompactionProfile, VeraCatalogModel } from "../config/model-catalog.ts";
import { createSubagentEffectApplier, type MissingSubagentConfigurationRequest, type SpawnModelResolution } from "../engine/subagent.ts";
import { type ToolApprovalUiRequestUpdate } from "../engine/protocol.ts";
import { DEFAULT_MAX_CONCURRENT_CHILD_AGENTS, validChildAgentLimit } from "../engine/agent-limits.ts";
import type { ToolReviewerSettings } from "../engine/reviewer.ts";
import type { ReviewerModelDefault, ReviewerSettingsPatch } from "../engine/model-settings.ts";
import type { ModelReasoningEffort } from "../model/types.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import { admittedEffortIds, availableModelsWithLevels, type PooledModel } from "../model/catalog-view.ts";
import { projectTranscript } from "../engine/protocol.ts";
import type { AgentInboxEffect, AgentSendEffect, AppliedToolEffectOutput, ApplyCommittedToolEffect, ApplyToolEffect, CloseSubagentEffect, MessageSubagentEffect, NotifyParentEffect, RegisteredTool, SpawnAsyncSubagentEffect, ToolEffectContext, ToolOutput } from "../tools/types.ts";
import { ManagedProcessRegistry } from "../tools/process-runtime.ts";
import { SessionStore, type SessionSettingOrigin } from "../store/session-store.ts";
import { findCatalogAgent, loadAgentCatalog, type AgentCatalog } from "../agents/catalog.ts";
import { type AgentDefinition } from "../agents/definition.ts";
import { agentSnapshotDrift, resolveAgentSnapshot, type AgentSnapshot } from "../agents/snapshot.ts";
import type { InboxEntry, InboxEntryInput } from "../store/inbox.ts";
import type { EmittedScheduleRun } from "../scheduler/types.ts";
import { copySessionMessageAttachments, createSessionBranch } from "../store/session-branch.ts";
import { disabledContributionsForProfile } from "../startup-profile.ts";
import { loopCompactionState, type LoopState } from "../engine/host-protocol.ts";
import type { VeraExtensionConfig } from "../config.ts";
import { discoverProjectExtensionConfigs } from "../extensions/discovery.ts";
import { startExtensionRegistry } from "../extensions/registry.ts";
import type { SessionIdentity, SessionIdentityProvider } from "../sdk/extensions.ts";
import type { InboxAdmissionCandidate, InboxAdmissionDecision } from "./inbox-delivery.ts";
import { ImageAttachmentService, sessionAttachmentName } from "../attachments/service.ts";
import { ProviderRoutingAdapter } from "../providers/routing.ts";
import { type SkillCommandCatalog, type SkillInvocationDecision } from "../skills/commands.ts";
import { startWorker, type WorkerHandle, type WorkerOutcome } from "./worker/handle.ts";
import type { WorkerAdapterSpec } from "./worker/start.ts";
import { createFailedRequestCapture } from "../providers/failed-request-capture.ts";
import { type AgentAttachment, ResidentAgent } from "./resident-agent.ts";
import { trashSessionArtifacts, type SessionArtifacts } from "./session-trash.ts";
import { PEER_MESSAGE_KIND, PEER_READ_KIND, VERA_INBOX_SOURCE, parsePeerMessage, parsePeerRead, type PeerMessagePayload } from "./local-participation.ts";

import { IMAGE_ATTACHMENT_LIMITS, resolveInstructionRoot, peerReadReceipt, type RegisteredAgentKind, type RegisteredAgentSummary, type AgentRegistryOptions, type CloseAgentTreeResult, type CloseDescendantTreeResult, type CreateRegisteredAgentOptions, type ResumeRegisteredAgentOptions, type BranchRegisteredAgentOptions, type BranchedRegisteredAgent, type RenameSessionOutcome, type InheritedAgentSettings, type BoundSessionIdentity, type RegisteredAgentEntry, type PendingSubagentLaunch, type PendingSubagentConfigurationBatch } from "./agent-registry/support.ts";
import { supportedModelSettings, settingsForClient, oneshotModelMessage, delegatedSubagentPolicy, WorkerCapReachedError } from "./agent-registry/helpers.ts";
import * as registryLifecycle from "./agent-registry/lifecycle.ts";
import * as registrySettings from "./agent-registry/settings.ts";
import * as registrySelect from "./agent-registry/select.ts";
import * as registryRoster from "./agent-registry/roster.ts";
import * as registrySubagent from "./agent-registry/subagent.ts";

export * from "./agent-registry/support.ts";
export * from "./agent-registry/helpers.ts";

export class AgentRegistry {
    readonly agents = new Map<string, RegisteredAgentEntry>();
    readonly startingIds = new Set<string>();
    readonly deliveryTasks = new Set<Promise<void>>();
    readonly suppressedCompletionDeliveries = new WeakSet<
        RegisteredAgentEntry
    >();
    readonly closingCompletionRecipients = new WeakSet<SessionStore>();
    defaultModel: string;
    defaultProvider: string;
    defaultReasoningEffort: ModelReasoningEffort | undefined;
    defaultApprovalMode: ApprovalMode;
    reviewerSettings: ToolReviewerSettings | undefined;
    isClosed = false;
    readonly trashArtifacts: (artifacts: SessionArtifacts) => Promise<void>;
    readonly maxConcurrentBackgroundAgents: number;
    readonly startingBackgroundAgents = new Map<string, number>();
    readonly spawnNotices = new Map<string, string>();
    readonly pendingSubagentConfigurations = new Map<
        string,
        PendingSubagentConfigurationBatch[]
    >();
    readonly catalog: EffectiveCatalogOptions;
    availableModels: readonly SuggestedModel[];
    readonly rosterListeners = new Set<() => void>();
    readonly processRegistry = new ManagedProcessRegistry();
    readonly options: AgentRegistryOptions;

    constructor(options: AgentRegistryOptions) {
        this.options = options;
        this.reviewerSettings = options.reviewer;
        this.defaultModel = options.model;
        this.defaultProvider = options.provider ?? "unknown";
        this.defaultReasoningEffort = options.reasoningEffort;
        this.availableModels = options.availableModels ?? [];
        this.defaultApprovalMode = options.approvalMode;
        this.maxConcurrentBackgroundAgents = validChildAgentLimit(
            options.maxConcurrentBackgroundAgents
                ?? DEFAULT_MAX_CONCURRENT_CHILD_AGENTS,
        );
        this.trashArtifacts = options.trashSessionArtifacts
            ?? trashSessionArtifacts;
        this.catalog = options.cacheDir === undefined
            ? {}
            : { cacheDir: options.cacheDir };
    }

    modelsForClient(): readonly SuggestedModel[] {
        return registrySettings.modelsForClient(this);
    }

    isKnownProvider(provider: string): boolean {
        return registrySettings.isKnownProvider(this, provider);
    }

    async create(
        options: CreateRegisteredAgentOptions,
    ): Promise<ResidentAgent> {
        return registryLifecycle.create(this, options);
    }

    async closeAgent(id: string): Promise<"closed" | "not_found"> {
        return registryLifecycle.closeAgent(this, id);
    }

    ownedTreeIds(id: string): readonly string[] {
        return registryLifecycle.ownedTreeIds(this, id);
    }

    async closeAgentTree(id: string): Promise<CloseAgentTreeResult> {
        return registryLifecycle.closeAgentTree(this, id);
    }

    async closeDescendantTree(
        callerId: string,
        targetId: string,
    ): Promise<CloseDescendantTreeResult> {
        return registryLifecycle.closeDescendantTree(this, callerId, targetId);
    }

    async reapClosedAgent(
        id: string,
        entry: RegisteredAgentEntry,
    ): Promise<void> {
        return registryLifecycle.reapClosedAgent(this, id, entry);
    }

    liveDescendantsOf(id: string): readonly string[] {
        return registryLifecycle.liveDescendantsOf(this, id);
    }

    async createWithKind(
        options: CreateRegisteredAgentOptions,
        kind: RegisteredAgentKind,
        inherited?: InheritedAgentSettings,
        clientPromptRefusal?: string,
    ): Promise<ResidentAgent> {
        return registryLifecycle.createWithKind(this, options, kind, inherited, clientPromptRefusal);
    }

    async resume(
        options: ResumeRegisteredAgentOptions,
    ): Promise<ResidentAgent> {
        return registryLifecycle.resume(this, options);
    }

    async branch(
        options: BranchRegisteredAgentOptions,
    ): Promise<BranchedRegisteredAgent | undefined> {
        return registryLifecycle.branch(this, options);
    }

    async trashSession(
        targetId: string,
    ): Promise<"trashed" | "busy" | "not_found" | "failed"> {
        return registryLifecycle.trashSession(this, targetId);
    }

    find(id: string): ResidentAgent | undefined {
        return registryLifecycle.find(this, id);
    }

    commitBranch(id: string): boolean {
        return registryLifecycle.commitBranch(this, id);
    }

    async syncBranchContext(
        targetId: string,
    ): Promise<{
        readonly status:
            | "synced"
            | "unchanged"
            | "busy"
            | "stale_cursor"
            | "not_found";
        readonly turns: number;
    }> {
        return registryLifecycle.syncBranchContext(this, targetId);
    }

    arcNameOf(id: string): string | undefined {
        return registryLifecycle.arcNameOf(this, id);
    }

    agentIdForArcSession(value: string): string | undefined {
        return registryLifecycle.agentIdForArcSession(this, value);
    }

    readonly identityKeyOwners = new Map<string, string>();
    readonly unavailableIdentityKeys = new Set<string>();

    identityKeyTaken(key: string): boolean {
        return registryLifecycle.identityKeyTaken(this, key);
    }

    async bindSessionIdentity(
        store: SessionStore,
    ): Promise<BoundSessionIdentity | undefined> {
        return registryLifecycle.bindSessionIdentity(this, store);
    }

    async claimSessionIdentityKey(
        sessionId: string,
        key: string,
    ): Promise<boolean> {
        return registryLifecycle.claimSessionIdentityKey(this, sessionId, key);
    }

    readHostModelSettings(workspace?: string): ModelTurnSettings {
        return registrySettings.readHostModelSettings(this, workspace);
    }

    reviewerDefault(): ReviewerModelDefault {
        return registrySettings.reviewerDefault(this);
    }

    readReviewer(): ToolReviewerSettings | undefined {
        return registrySettings.readReviewer(this);
    }

    applyReviewerPatch(patch: ReviewerSettingsPatch | null): boolean {
        return registrySettings.applyReviewerPatch(this, patch);
    }

    resolveModelPatch(
        entry: RegisteredAgentEntry,
        patch: ModelSettingsPatch,
    ): {
        readonly settings: ModelTurnSettings;
        readonly requestedReasoningEffort?: ModelReasoningEffort;
    } | undefined {
        return registrySettings.resolveModelPatch(this, entry, patch);
    }

    async updateModelSettings(
        id: string,
        patch: ModelSettingsPatch,
    ): Promise<ModelTurnSettings | undefined> {
        return registrySettings.updateModelSettings(this, id, patch);
    }

    async applyModelSettings(
        id: string,
        patch: ModelSettingsPatch,
    ): Promise<ModelTurnSettings | undefined> {
        return registrySettings.applyModelSettings(this, id, patch);
    }

    effectiveDefaultPair(
        entry: RegisteredAgentEntry,
    ): ModelTurnSettings {
        return registrySettings.effectiveDefaultPair(this, entry);
    }

    originFor(
        entry: RegisteredAgentEntry,
        settings: ModelTurnSettings,
    ): SessionSettingOrigin {
        return registrySettings.originFor(this, entry, settings);
    }

    async updateSessionModelSettings(
        id: string,
        patch: ModelSettingsPatch,
    ): Promise<
        { settings: ModelTurnSettings; origin: SessionSettingOrigin } | undefined
    > {
        return registrySettings.updateSessionModelSettings(this, id, patch);
    }

    async applySessionModelSettings(
        id: string,
        patch: ModelSettingsPatch,
    ): Promise<
        { settings: ModelTurnSettings; origin: SessionSettingOrigin } | undefined
    > {
        return registrySettings.applySessionModelSettings(this, id, patch);
    }

    sessionModelSettingsHistory(id: string): readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: SessionSettingOrigin;
        readonly timestamp: string;
    }[] {
        return registrySettings.sessionModelSettingsHistory(this, id);
    }

    async updateSessionPermissionMode(
        id: string,
        mode: ApprovalMode,
    ): Promise<ApprovalMode | undefined> {
        return registrySelect.updateSessionPermissionMode(this, id, mode);
    }

    async applySessionPermissionMode(
        id: string,
        mode: ApprovalMode,
    ): Promise<ApprovalMode | undefined> {
        return registrySelect.applySessionPermissionMode(this, id, mode);
    }

    async leaveAgentThatForbidsAccess(
        entry: RegisteredAgentEntry,
        id: string,
        mode: ApprovalMode,
    ): Promise<void> {
        return registrySelect.leaveAgentThatForbidsAccess(this, entry, id, mode);
    }

    selectedAgentDefaultPair(
        entry: RegisteredAgentEntry,
    ): ModelTurnSettings | undefined {
        return registrySelect.selectedAgentDefaultPair(this, entry);
    }

    selectedAgentPosture(
        entry: RegisteredAgentEntry,
    ): ApprovalMode | undefined {
        return registrySelect.selectedAgentPosture(this, entry);
    }

    async listAgentsFor(id: string): Promise<{
        readonly selected: string;
        readonly agents: readonly {
            readonly name: string;
            readonly description?: string;
            readonly scope: "project" | "user" | "extension";
            readonly writable: boolean;
            readonly tools?: readonly string[];
            readonly skills?: readonly string[];
            readonly posture?: string;
            readonly forbiddenAccess?: readonly string[];
            readonly defaultPair?: {
                readonly name: string;
                readonly effort?: string;
            };
        }[];
        readonly notices: readonly string[];
    }> {
        return registrySelect.listAgentsFor(this, id);
    }

    async listSkillsFor(id: string): Promise<SkillCommandCatalog> {
        return registrySelect.listSkillsFor(this, id);
    }

    async decideSkillInvocationFor(
        id: string,
        name: string,
    ): Promise<SkillInvocationDecision> {
        return registrySelect.decideSkillInvocationFor(this, id, name);
    }

    async agentCatalogFor(
        entry: RegisteredAgentEntry,
    ): Promise<AgentCatalog> {
        return registrySelect.agentCatalogFor(this, entry);
    }

    async selectAgentFor(id: string, name: string): Promise<{
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly notice?: string;
        readonly permissionChanged?: boolean;
    } | undefined> {
        return registrySelect.selectAgentFor(this, id, name);
    }

    async applySelectedAgent(id: string, name: string): Promise<{
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly notice?: string;
        readonly permissionChanged?: boolean;
    } | undefined> {
        return registrySelect.applySelectedAgent(this, id, name);
    }

    async adoptAgentDefaultPair(
        entry: RegisteredAgentEntry,
        definition: AgentDefinition,
    ): Promise<string | undefined> {
        return registrySelect.adoptAgentDefaultPair(this, entry, definition);
    }

    async reconcileResumedSelectedAgent(
        entry: RegisteredAgentEntry,
        events: EngineEventBus,
    ): Promise<void> {
        return registrySelect.reconcileResumedSelectedAgent(this, entry, events);
    }

    async updateAgentDefaultPairFor(
        id: string,
        name: string,
        pair: { readonly name: string; readonly effort?: string } | null,
    ): Promise<string | undefined> {
        return registrySelect.updateAgentDefaultPairFor(this, id, name, pair);
    }

    async poolAdd(
        id: string,
        entry: { readonly provider: string; readonly model: string },
        onStep: Parameters<
            NonNullable<AgentRegistryOptions["admitToPool"]>
        >[1],
        options?: { readonly verify?: boolean },
    ): Promise<{
        verdict: PoolAdmissionVerdict;
        reason?: string;
        statusCode?: number;
        settings?: ModelTurnSettings;
    }> {
        return registrySettings.poolAdd(this, id, entry, onStep, options);
    }

    async applyPoolAddEffect(
        effect: { readonly models: readonly string[] },
    ): Promise<ToolOutput> {
        return registrySettings.applyPoolAddEffect(this, effect);
    }

    applyAgentRosterEffect(
        callerId: string,
        details: boolean,
    ): Promise<ToolOutput> {
        return registryRoster.applyAgentRosterEffect(this, callerId, details);
    }

    async applyAgentSendEffect(
        callerId: string,
        effect: AgentSendEffect,
    ): Promise<ToolOutput> {
        return registryRoster.applyAgentSendEffect(this, callerId, effect);
    }

    async wakeForPeerMessage(
        caller: RegisteredAgentEntry,
        recipient: RegisteredAgentEntry,
        seq: number,
    ): Promise<{
        readonly delivered: boolean;
        readonly reason?:
            | "approval_mode"
            | "hop_limit"
            | "rate_limit"
            | "unavailable"
            | "admission";
    }> {
        return registryRoster.wakeForPeerMessage(this, caller, recipient, seq);
    }

    async applyAgentInboxEffect(
        callerId: string,
        effect: AgentInboxEffect,
    ): Promise<AppliedToolEffectOutput> {
        return registryRoster.applyAgentInboxEffect(this, callerId, effect);
    }

    async refreshHostCatalog(
        provider: string,
    ): Promise<readonly SuggestedModel[] | undefined> {
        return registrySettings.refreshHostCatalog(this, provider);
    }

    async refreshCatalog(
        id: string,
        provider: string,
    ): Promise<ModelTurnSettings | undefined> {
        return registrySettings.refreshCatalog(this, id, provider);
    }

    async poolRemove(
        id: string,
        entry: { readonly provider: string; readonly model: string },
    ): Promise<ModelTurnSettings | undefined> {
        return registrySettings.poolRemove(this, id, entry);
    }

    async poolName(
        id: string,
        entry: { readonly provider: string; readonly model: string },
        name: string | null,
    ): Promise<ModelTurnSettings | undefined> {
        return registrySettings.poolName(this, id, entry, name);
    }

    async poolMove(
        id: string,
        entry: { readonly provider: string; readonly model: string },
        delta: number,
    ): Promise<ModelTurnSettings | undefined> {
        return registrySettings.poolMove(this, id, entry, delta);
    }

    async updateApprovalMode(
        id: string,
        mode: ApprovalMode,
    ): Promise<ApprovalMode | undefined> {
        return registrySelect.updateApprovalMode(this, id, mode);
    }

    async applyApprovalMode(
        id: string,
        mode: ApprovalMode,
    ): Promise<ApprovalMode | undefined> {
        return registrySelect.applyApprovalMode(this, id, mode);
    }

    approvalModeOf(agentId: string): ApprovalMode | undefined {
        return registrySelect.approvalModeOf(this, agentId);
    }

    async renameSession(
        targetId: string,
        name: string | null,
    ): Promise<RenameSessionOutcome> {
        return registryRoster.renameSession(this, targetId, name);
    }

    async updateSessionName(
        id: string,
        name: string | null,
    ): Promise<string | null | undefined> {
        return registryRoster.updateSessionName(this, id, name);
    }

    onRosterChanged(listener: () => void): () => void {
        return registryRoster.onRosterChanged(this, listener);
    }

    notifyRosterChanged(): void {
        return registryRoster.notifyRosterChanged(this);
    }

    list(): RegisteredAgentSummary[] {
        return registryRoster.list(this);
    }

    workFacts(): readonly WorkAgentFacts[] {
        return registryRoster.workFacts(this);
    }

    scheduleWorkFacts(
        runs: readonly EmittedScheduleRun[],
        agents: readonly WorkAgentFacts[],
    ): readonly WorkScheduleFacts[] {
        return registryRoster.scheduleWorkFacts(this, runs, agents);
    }

    idleForShutdown(): boolean {
        return registryLifecycle.idleForShutdown(this);
    }

    idleForReplacement(): boolean {
        return registryLifecycle.idleForReplacement(this);
    }

    async close(): Promise<void> {
        return registryLifecycle.close(this);
    }

    async start(
        store: SessionStore,
        kind: RegisteredAgentKind,
        eventLogPath = this.options.eventLogPathForId?.(
            store.header.id,
            store.header.cwd,
        ),
        parentId?: string,
        clientPromptRefusal?: string,
        ephemeral = false,
        pendingPublication = false,
    ): Promise<ResidentAgent> {
        const identity = await this.bindSessionIdentity(store);
        const startupProfile = store.header.contextAssemblyMode ?? "default";
        const projectExtensionConfigs = startupProfile === "default"
            ? discoverProjectExtensionConfigs(store.header.cwd)
            : [];
        const projectExtensions = projectExtensionConfigs.length === 0
            ? undefined
            : await startExtensionRegistry({
                extensions: projectExtensionConfigs,
            });
        const extensionTools = startupProfile === "default"
            ? [
                ...(this.options.extensionTools ?? []),
                ...(projectExtensions?.tools() ?? []),
            ]
            : [];
        const registry = this;
        const disabledPromptContributions = () =>
            disabledContributionsForProfile(
                startupProfile,
                registry.options.disabledPromptContributions,
            );
        const storedFailure = store.agentFailure();
        const captureFailedRequest = (
            this.options.createFailedRequestCapture
                ?? ((sessionId) => createFailedRequestCapture({ sessionId }))
        )(store.header.id);
        const adapter = storedFailure === undefined
            ? new ProviderRoutingAdapter(
                (provider) =>
                    this.options.createAdapter(
                        provider,
                        store.header.cwd,
                        captureFailedRequest,
                    ),
                this.defaultProvider,
                this.options.credentialFingerprint,
                this.options.prepareModelRequest?.({
                    sessionId: store.header.id,
                    workspace: store.header.cwd,
                }),
            )
            : undefined;
        const imageAttachments = new ImageAttachmentService(
            store,
            IMAGE_ATTACHMENT_LIMITS,
        );
        const agent = new ResidentAgent(store.header.id, store.header.cwd, {
            attachImage: (path, signal) =>
                imageAttachments.attachFile(path, signal),
            onRunStateChanged: () => this.notifyRosterChanged(),
            onClientPrompt: () => {
                const woken = this.agents.get(store.header.id);
                if (woken !== undefined) {
                    woken.peerHop = 0;
                }
            },
            ...(clientPromptRefusal === undefined
                ? {}
                : { clientPromptRefusal }),
        });
        const events = new EngineEventBus();
        const instructionRoot = resolveInstructionRoot(store.header.cwd);
        const storedSettings = store.modelSettings();
        const entry: RegisteredAgentEntry = {
            agent,
            store,
            kind,
            ephemeral,
            pendingPublication,
            ...(identity === undefined ? {} : { identity }),
            events,
            eventLogPath,
            ...(parentId === undefined
                ? {}
                : { parentId }),
            ...(adapter === undefined ? {} : { adapter }),
            modelSettings: supportedModelSettings(
                storedSettings === undefined
                    ? {
                        provider: this.defaultProvider,
                        model: this.defaultModel,
                        ...(this.defaultReasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: this.defaultReasoningEffort }),
                    }
                    : {
                        ...storedSettings,
                        provider: storedSettings.provider ?? this.defaultProvider,
                    },
                this.catalog,
            ),
            approvalMode: store.approvalMode() ?? this.defaultApprovalMode,
            ...(store.selectedAgent() === undefined
                ? {}
                : { selectedAgent: store.selectedAgent()!.snapshot }),
            run: Promise.resolve(),
            ...(projectExtensions === undefined
                ? {}
                : { projectExtensions }),
            completed: false,
            peerHop: 0,
            peerWakes: [],
            pendingAsyncTurns: 0,
            pendingCompletionDeliveries: 0,
            completionSequence: 0,
            ...(store.header.origin === undefined
                ? {}
                : { syncedSourceEntryId: store.header.origin.entryId }),
            ...(storedFailure === undefined
                ? {}
                : { failure: new Error(storedFailure.detail) }),
        };
        this.agents.set(agent.id, entry);
        try {
            await this.options.acquireWorkspaceSidecars?.(store.header.cwd);
        } catch (error) {
            this.agents.delete(agent.id);
            await projectExtensions?.close();
            throw error;
        }
        this.notifyRosterChanged();
        void this.reconcileResumedSelectedAgent(entry, events);
        if (storedFailure !== undefined) {
            agent.restoreFailure({
                type: "history",
                entries: projectTranscript(
                    store.messages(),
                    sessionAttachmentName(store),
                    store.activeMessageIds(),
                    store.projectedHarnessMessages(),
                ),
                seq: 0,
            }, storedFailure.id, storedFailure.detail);
            return agent;
        }
        if (adapter === undefined) {
            throw new Error("Active resident agent has no model adapter");
        }
        const applySubagentEffect = createSubagentEffectApplier({
            adapter,
            loadAgent: async (name) => {
                const catalog = await loadAgentCatalog({
                    projectRoot: store.header.cwd,
                    permissionModes: [
                        ...BUILT_IN_PERMISSION_MODE_NAMES,
                        ...Object.keys(this.options.permissionModes ?? {}),
                    ],
                    interactive: false,
                    ...(this.options.registeredAgents === undefined
                        ? {}
                        : { registered: this.options.registeredAgents }),
                });
                return findCatalogAgent(catalog, name)?.definition;
            },
            workspace: store.header.cwd,
            parentSessionId: store.header.id,
            instructionRoot,
            scratchDir: sessionScratchDir(store.header.id),
            processRegistry: this.processRegistry,
            get disabledPromptContributions() {
                return disabledPromptContributions();
            },
            extensionTools,
            ...(startupProfile !== "default"
                || this.options.loadContextualContributions === undefined
                ? {}
                : {
                    loadContextualContributions:
                        this.options.loadContextualContributions,
                }),
            offerTools: startupProfile !== "prompt_only",
            loadOptionalContext: startupProfile === "default",
            ...(store.header.contextAssemblyMode === undefined
                ? {}
                : {
                    sessionMetadata: {
                        contextAssemblyMode: store.header.contextAssemblyMode,
                    },
                }),
            ...(this.options.readPool === undefined
                ? {}
                : {
                    readPool: () =>
                        this.options.readPool?.(store.header.cwd) ?? [],
                }),
            ...(this.options.subagentModel === undefined
                ? {}
                : { subagentModel: this.options.subagentModel }),
            readPolicy: () => delegatedSubagentPolicy(
                this.options.readPolicy === undefined
                    ? { allowSelf: true }
                    : this.options.readPolicy(store.header.cwd),
                store.header.delegation,
            ),
            requestMissingConfiguration: (request, context, signal) =>
                this.requestMissingSubagentConfiguration(
                    entry,
                    request,
                    context,
                    signal,
                ),
            relayToolApproval: (update, sourceAgentId, sourceTask, signal) =>
                this.relayChildToolApproval(
                    entry,
                    update,
                    sourceAgentId,
                    sourceTask,
                    signal,
                ),
            ...(this.options.modelFallback === undefined
                ? {}
                : { modelFallback: this.options.modelFallback }),
            ...(this.options.reviewer === undefined
                ? {}
                : { reviewer: this.options.reviewer }),
            readReviewer: () => this.readReviewer(),
            ...(this.options.reviewers === undefined
                ? {}
                : { reviewers: this.options.reviewers }),
            ...(this.options.reviewLog === undefined
                ? {}
                : { reviewLog: this.options.reviewLog }),
            ...(this.options.permissionModes === undefined
                ? {}
                : { permissionModes: this.options.permissionModes }),
        });
        const boundCompaction = (): ReturnType<typeof bindCompaction> =>
            bindCompaction(
                this.options.compaction,
                adapter,
                {
                    ...(entry.modelSettings.provider === undefined
                        ? {}
                        : { provider: entry.modelSettings.provider }),
                    model: entry.modelSettings.model,
                },
                BUNDLED_COMPACTION_STRATEGIES,
                this.options.compactionModels,
                this.options.compactionOverrides,
            );
        const applyToolEffect: ApplyToolEffect = (effect, signal, context) => {
            if (effect.type === "spawn_async_subagent") {
                return this.spawnAsyncSubagent(
                    store,
                    effect,
                    context,
                    signal,
                );
            }
            if (effect.type === "message_subagent") {
                return this.messageSubagent(store, effect);
            }
            if (effect.type === "close_subagent") {
                return this.closeSubagent(agent.id, effect);
            }
            if (effect.type === "notify_parent") {
                return this.notifyParent(store, effect);
            }
            if (effect.type === "pool_add") {
                return this.applyPoolAddEffect(effect);
            }
            if (effect.type === "agent_roster") {
                return this.applyAgentRosterEffect(agent.id, effect.details);
            }
            if (effect.type === "agent_send") {
                return this.applyAgentSendEffect(agent.id, effect);
            }
            if (effect.type === "agent_inbox") {
                return this.applyAgentInboxEffect(agent.id, effect);
            }
            return applySubagentEffect(effect, signal, context);
        };
        const applyCommittedToolEffect: ApplyCommittedToolEffect = async (
            effect,
        ) => {
            if (effect.key !== "inbox.acknowledge") {
                throw new Error(`Unknown committed tool effect: ${effect.key}`);
            }
            const seq = effect.data.seq;
            const receiptTo = effect.data.receipt_to;
            if (!Number.isSafeInteger(seq) || (seq as number) <= 0) {
                throw new Error("Invalid inbox acknowledgement sequence");
            }
            if (receiptTo !== undefined && (
                typeof receiptTo !== "string" || receiptTo.length === 0
            )) {
                throw new Error("Invalid inbox read-receipt recipient");
            }
            if (entry.inbox === undefined) {
                throw new Error("inbox consumer closed before acknowledgement");
            }
            const acknowledged = entry.inbox.consumer.acknowledge(
                seq as number,
                receiptTo === undefined
                    ? undefined
                    : peerReadReceipt(agent.id, receiptTo as string, seq as number),
            );
            if (acknowledged.receipt !== undefined) {
                await this.options.inboxDelivery?.pumpAll();
            }
        };
        const loopData: RunHeadlessLoopData = {
                eventLogPath,
                approvalMode: entry.approvalMode,
                toolEnv: entry.identity?.env ?? {},
                instructionRoot,
                enabledToolEffects: kind === "interactive"
                    ? [
                        "spawn_subagent",
                        "spawn_async_subagent",
                        "message_subagent",
                        "close_subagent",
                        "pool_add",
                        "agent_roster",
                        ...(this.options.inboxDelivery === undefined
                            ? []
                            : ["agent_send" as const, "agent_inbox" as const]),
                    ]
                    : ["notify_parent", "agent_roster"],
                enableUserInteraction: kind === "interactive",
                offerTools: startupProfile !== "prompt_only",
                loadOptionalContext: startupProfile === "default",
        };
        const loopServices: RunHeadlessLoopServices = {
                sessionStore: store,
                ...(this.options.modelFailureLedger === undefined
                    ? {}
                    : { modelFailureLedger: this.options.modelFailureLedger }),
                eventBus: events,
                processRegistry: this.processRegistry,
                ...(this.options.createEffortPool === undefined
                    ? {}
                    : {
                        effortPool: this.options.createEffortPool(
                            store.header.cwd,
                        ),
                    }),
                readReviewer: () => this.readReviewer(),
                ...(this.options.reviewLog === undefined
                    ? {}
                    : { reviewLog: this.options.reviewLog }),
                get compaction() {
                    return boundCompaction();
                },
                ...(this.options.toolResults === undefined
                    ? {}
                    : { toolResults: this.options.toolResults }),
                applyToolEffect,
                requestMissingSubagentConfiguration:
                    (request, context, signal) =>
                        this.requestMissingSubagentConfiguration(
                            entry,
                            request,
                            context,
                            signal,
                        ),
                applyCommittedToolEffect,
                extensionTools,
                ...(startupProfile !== "default"
                    || this.options.loadContextualContributions === undefined
                    ? {}
                    : {
                        loadContextualContributions:
                            this.options.loadContextualContributions,
                    }),
                readPolicy: () => {
                    const reviewer = this.readReviewer();
                    return {
                        ...(store.header.delegation !== undefined
                                || registry.options.modelFallback === undefined
                            ? {}
                            : {
                            modelFallback: registry.options.modelFallback,
                        }),
                        ...(registry.options.permissionModes === undefined
                            ? {}
                            : {
                                permissionModes:
                                    registry.options.permissionModes,
                            }),
                        ...(reviewer === undefined ? {} : { reviewer }),
                        ...(registry.options.reviewers === undefined ? {} : {
                            reviewers: registry.options.reviewers,
                        }),
                        disabledPromptContributions:
                            disabledPromptContributions(),
                        subagentPolicy: delegatedSubagentPolicy(
                            this.options.readPolicy === undefined
                                ? { allowSelf: true }
                                : this.options.readPolicy(store.header.cwd),
                            store.header.delegation,
                        ),
                    };
                },
                readModelSettings: () => settingsForClient(
                    entry.modelSettings,
                    entry.modelSettings.provider ?? this.defaultProvider,
                    this.catalog,
                    this.modelsForClient(),
                    this.options.readPool?.(store.header.cwd),
                    this.options.subagentModel,
                    entry.requestedReasoningEffort,
                    this.reviewerDefault(),
                    this.options.contextLimit?.(),
                    this.options.configuredOverrides?.(),
                    store.header.cwd,
                    this.options.refreshableProviders?.(),
                ),
                readSelectedAgent: () => entry.selectedAgent,
                readApprovalMode: () => entry.approvalMode,
                updateApprovalMode: (mode) =>
                    this.updateApprovalMode(agent.id, mode),
                ...(this.options.permissionPreferences === undefined ? {} : {
                    readPermissionPreferences: () =>
                        this.options.permissionPreferences!.list(),
                }),
                ...(startupProfile !== "default"
                        || this.options.createToolHooks === undefined
                    ? {}
                    : { hooks: this.options.createToolHooks() }),
                router: {
                    onInboundReady: (inbound) => {
                        entry.inbound = inbound;
                    },
                    hasPendingDeliveryTurn: () =>
                        entry.inbox?.hasAdmittedPending() === true,
                    onDeliveryTurnDiscarded: () =>
                        agent.deliveryTurnDiscarded(),
                    updateModelSettings: (patch) =>
                        this.updateModelSettings(agent.id, patch),
                    updateSessionModelSettings: (patch) =>
                        this.updateSessionModelSettings(agent.id, patch),
                    readSessionModelSettingsHistory: () =>
                        this.sessionModelSettingsHistory(agent.id),
                    updateSessionPermissionMode: (mode) =>
                        this.updateSessionPermissionMode(agent.id, mode),
                    selectAgent: (name) => this.selectAgentFor(agent.id, name),
                    listAgents: () => this.listAgentsFor(agent.id),
                    listSkills: () => this.listSkillsFor(agent.id),
                    invokeSkill: (name) =>
                        this.decideSkillInvocationFor(agent.id, name),
                    updateAgentDefaultPair: (name, pair) =>
                        this.updateAgentDefaultPairFor(agent.id, name, pair),
                    poolAdd: (poolEntry, onStep, poolOptions) =>
                        this.poolAdd(agent.id, poolEntry, onStep, poolOptions),
                    poolRemove: (poolEntry) =>
                        this.poolRemove(agent.id, poolEntry),
                    refreshCatalog: (provider) =>
                        this.refreshCatalog(agent.id, provider),
                    poolName: (poolEntry, name) =>
                        this.poolName(agent.id, poolEntry, name),
                    poolMove: (poolEntry, delta) =>
                        this.poolMove(agent.id, poolEntry, delta),
                    ...(adapter === undefined ? {} : {
                        oneshot: (request, signal) => {
                            const complete = createRoutedCompletionService(
                                adapter,
                                {
                                    models: [{
                                        model: request.model,
                                        ...(request.provider === undefined
                                            ? {}
                                            : { provider: request.provider }),
                                        ...(request.reasoningEffort
                                                === undefined
                                            ? {}
                                            : isModelReasoningEffort(
                                                    request.reasoningEffort,
                                                )
                                            ? {
                                                reasoningEffort:
                                                    request.reasoningEffort,
                                            }
                                            : {}),
                                    }],
                                },
                            );
                            return complete({
                                systemPrompt: request.systemPrompt ?? "",
                                messages: request.messages.map((message) =>
                                    oneshotModelMessage(message)
                                ),
                                ...(request.maxTokens === undefined
                                    ? {}
                                    : { maxTokens: request.maxTokens }),
                            }, signal);
                        },
                    }),
                    sendOneshotReply: (ownerId, reply) =>
                        agent.sendOneshotReply(ownerId, reply),
                    readApprovalModeOrigin: () =>
                        entry.store.approvalModeOrigin(),
                    ...(this.options.permissionPreferences === undefined
                        ? {}
                        : {
                            addPermissionPreference: async (when) => {
                                const added = await this.options
                                    .permissionPreferences!.add(when);
                                this.pushWorkerStateEverywhere();
                                return added;
                            },
                            removePermissionPreference: async (id) => {
                                const removed = await this.options
                                    .permissionPreferences!.remove(id);
                                this.pushWorkerStateEverywhere();
                                return removed;
                            },
                        }),
                    updateSessionName: (name) =>
                        this.updateSessionName(agent.id, name),
                    sendTimelineReply: (ownerId, reply) =>
                        agent.sendTimelineReply(ownerId, reply),
                    sendSessionNameReply: (ownerId, reply) =>
                        agent.sendSessionNameReply(ownerId, reply),
                },
        };
        entry.loopServices = loopServices;
        const adapterSpec = this.workerAdapterSpecFor(store, entry);
        entry.run = (adapterSpec === undefined
            ? runHeadlessLoop(
                agent.engine,
                adapter,
                this.defaultModel,
                this.defaultReasoningEffort,
                loopData,
                loopServices,
            )
            : this.runInWorker({
                agent,
                store,
                entry,
                adapter: adapterSpec,
                data: loopData,
                services: loopServices,
                extensionTools,
            })
        ).catch(async (error: unknown) => {
            entry.inbox?.release();
            if (!agent.closed) {
                entry.failure = error;
                const failureId = randomUUID();
                const detail = error instanceof WorkerCapReachedError
                    ? error.message
                    : "Resident agent stopped unexpectedly";
                try {
                    await store.appendAgentFailure(failureId, detail);
                } catch {
                }
                agent.fail(failureId, detail);
            }
        });
        if (kind === "interactive" && this.options.inboxDelivery !== undefined) {
            const inboxDelivery = this.options.inboxDelivery;
            const admissionPath = inboxDelivery.hasAdmissionPath();
            const inbox = inboxDelivery.attach({
                label: agent.id,
                actor: this.options.inboxActorForSession?.(agent.id) ?? null,
                projectRoot: agent.workspace,
                session: entry.identity?.name ?? agent.id,
                notify: (notice) => {
                    if (!agent.closed && !agent.failed) {
                        events.emit({
                            type: "notice",
                            key: "inbox",
                            count: notice.unreadCount,
                        });
                    }
                },
                canStartTurn: () => agent.attached,
                startTurn: () => agent.triggerDeliveryTurn(),
                ...(admissionPath ? {
                    requestAdmission: (candidate: InboxAdmissionCandidate, signal: AbortSignal) =>
                        this.requestInboxAdmission(entry, candidate, signal),
                    onAdmissionFailure: (candidate: InboxAdmissionCandidate) => {
                        if (!agent.closed && !agent.failed && agent.attached) {
                            events.emit({
                                type: "task_notification",
                                deliveryId: `inbox-admission:${candidate.seq}`,
                                sourceAgentId: agent.id,
                                content:
                                    `Could not save admission for ${candidate.sourceFamily}; `
                                    + "the inbox entry is still held.",
                                kind: "attention",
                            });
                        }
                    },
                } : {}),
            });
            entry.inbox = inbox;
            agent.onAttachmentChanged((attached) => {
                inbox.clientAttachmentChanged(attached);
                if (attached) {
                    this.trackDelivery(inbox.pump());
                }
            });
            this.trackDelivery(inbox.pump());
        }
        const pendingDeliveries = store.pendingDeliveries();
        for (const delivery of pendingDeliveries) {
            events.emit({
                type: "task_notification",
                deliveryId: delivery.id,
                sourceAgentId: delivery.sourceAgentId,
                content: delivery.content,
                kind: delivery.kind ?? "completion",
            });
        }
        if (
            pendingDeliveries.length > 0
            || store.hasUnansweredDeliveryTurn()
        ) {
            agent.triggerDeliveryTurn();
        }
        return agent;
    }

    workerAdapterSpecFor(
        store: SessionStore,
        entry: RegisteredAgentEntry,
    ): WorkerAdapterSpec | undefined {
        return registrySubagent.workerAdapterSpecFor(this, store, entry);
    }

    workerExtensions(
        workspace: string,
    ): readonly VeraExtensionConfig[] | undefined {
        return registrySubagent.workerExtensions(this, workspace);
    }

    pushWorkerState(id: string): void {
        return registrySubagent.pushWorkerState(this, id);
    }

    pushWorkerStateEverywhere(): void {
        return registrySubagent.pushWorkerStateEverywhere(this);
    }

    liveWorkerCount(): number {
        return registrySubagent.liveWorkerCount(this);
    }

    async runInWorker(options: {
        readonly agent: ResidentAgent;
        readonly store: SessionStore;
        readonly entry: RegisteredAgentEntry;
        readonly adapter: WorkerAdapterSpec;
        readonly data: RunHeadlessLoopData;
        readonly services: RunHeadlessLoopServices;
        readonly extensionTools?: readonly RegisteredTool[];
    }): Promise<void> {
        return registrySubagent.runInWorker(this, options);
    }

    async requestInboxAdmission(
        entry: RegisteredAgentEntry,
        candidate: InboxAdmissionCandidate,
        signal: AbortSignal,
    ): Promise<InboxAdmissionDecision | undefined> {
        return registryRoster.requestInboxAdmission(this, entry, candidate, signal);
    }

    requestMissingSubagentConfiguration(
        entry: RegisteredAgentEntry,
        request: MissingSubagentConfigurationRequest,
        context: ToolEffectContext,
        signal: AbortSignal,
    ): Promise<SpawnModelResolution> {
        return registrySubagent.requestMissingSubagentConfiguration(this, entry, request, context, signal);
    }

    scheduleSubagentConfigurationBatch(
        batch: PendingSubagentConfigurationBatch,
    ): void {
        return registrySubagent.scheduleSubagentConfigurationBatch(this, batch);
    }

    async processMissingSubagentConfiguration(
        batch: PendingSubagentConfigurationBatch,
    ): Promise<void> {
        return registrySubagent.processMissingSubagentConfiguration(this, batch);
    }

    resolveConfiguredSubagentLaunch(
        entry: RegisteredAgentEntry,
        action: PendingSubagentLaunch,
    ): {
        readonly action: PendingSubagentLaunch;
        readonly resolution: SpawnModelResolution;
    } {
        return registrySubagent.resolveConfiguredSubagentLaunch(this, entry, action);
    }

    finishSubagentConfigurationBatch(
        batch: PendingSubagentConfigurationBatch,
        resolution: SpawnModelResolution,
    ): void {
        return registrySubagent.finishSubagentConfigurationBatch(this, batch, resolution);
    }

    completeSubagentConfigurationBatch(
        batch: PendingSubagentConfigurationBatch,
    ): void {
        return registrySubagent.completeSubagentConfigurationBatch(this, batch);
    }

    finishSubagentChoices(
        choices: readonly {
            readonly action: PendingSubagentLaunch;
            readonly resolution: SpawnModelResolution;
        }[],
        resolution: SpawnModelResolution,
    ): void {
        return registrySubagent.finishSubagentChoices(this, choices, resolution);
    }

    settlePendingSubagentLaunch(
        action: PendingSubagentLaunch,
        resolution: SpawnModelResolution,
    ): void {
        return registrySubagent.settlePendingSubagentLaunch(this, action, resolution);
    }

    async spawnAsyncSubagent(
        parentStore: SessionStore,
        effect: SpawnAsyncSubagentEffect,
        context: Parameters<ApplyToolEffect>[2],
        signal: AbortSignal,
    ): Promise<ToolOutput> {
        return registrySubagent.spawnAsyncSubagent(this, parentStore, effect, context, signal);
    }

    async messageSubagent(
        parentStore: SessionStore,
        effect: MessageSubagentEffect,
    ): Promise<ToolOutput> {
        return registrySubagent.messageSubagent(this, parentStore, effect);
    }

    async closeSubagent(
        callerId: string,
        effect: CloseSubagentEffect,
    ): Promise<ToolOutput> {
        return registrySubagent.closeSubagent(this, callerId, effect);
    }

    trackAsyncSubagentTurn(childId: string): void {
        return registrySubagent.trackAsyncSubagentTurn(this, childId);
    }

    monitorAsyncSubagent(
        parentStore: SessionStore,
        childEntry: RegisteredAgentEntry,
        attachment: AgentAttachment,
        completionSequence: number,
    ): void {
        return registrySubagent.monitorAsyncSubagent(this, parentStore, childEntry, attachment, completionSequence);
    }

    async notifyParent(
        childStore: SessionStore,
        effect: NotifyParentEffect,
    ): Promise<ToolOutput> {
        return registrySubagent.notifyParent(this, childStore, effect);
    }

    async deliverBackgroundResult(
        parentStore: SessionStore,
        childEntry: RegisteredAgentEntry,
        attachment: AgentAttachment,
        completionSequence: number,
    ): Promise<void> {
        return registrySubagent.deliverBackgroundResult(this, parentStore, childEntry, attachment, completionSequence);
    }

    async relayChildToolApproval(
        parent: RegisteredAgentEntry,
        update: ToolApprovalUiRequestUpdate,
        sourceAgentId: string,
        sourceTask: string,
        signal?: AbortSignal,
    ): Promise<"allow_once" | "deny"> {
        return registrySubagent.relayChildToolApproval(this, parent, update, sourceAgentId, sourceTask, signal);
    }

    trackDelivery(task: Promise<void>): void {
        return registrySubagent.trackDelivery(this, task);
    }

    reserveId(id: string): void {
        return registryLifecycle.reserveId(this, id);
    }

    requireOpen(): void {
        return registryLifecycle.requireOpen(this);
    }
}

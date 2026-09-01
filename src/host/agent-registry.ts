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
import { agentSnapshotDrift, resolveAgentSnapshot, type AgentWearSnapshot } from "../agents/wear.ts";
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
import * as registryWear from "./agent-registry/wear.ts";
import * as registryRoster from "./agent-registry/roster.ts";
import * as registrySubagent from "./agent-registry/subagent.ts";

export * from "./agent-registry/support.ts";
export * from "./agent-registry/helpers.ts";

export class AgentRegistry {
    readonly agents = new Map<string, RegisteredAgentEntry>();
    readonly startingIds = new Set<string>();
    readonly deliveryTasks = new Set<Promise<void>>();
    /** Kept for the entry's lifetime so overlapping monitors all suppress. */
    readonly suppressedCompletionDeliveries = new WeakSet<
        RegisteredAgentEntry
    >();
    readonly closingCompletionRecipients = new WeakSet<SessionStore>();
    defaultModel: string;
    defaultProvider: string;
    defaultReasoningEffort: ModelReasoningEffort | undefined;
    defaultApprovalMode: ApprovalMode;
    /** Fixed classifier route for embedded callers without a live reader. */
    reviewerSettings: ToolReviewerSettings | undefined;
    isClosed = false;
    readonly trashArtifacts: (artifacts: SessionArtifacts) => Promise<void>;
    readonly maxConcurrentBackgroundAgents: number;
    readonly startingBackgroundAgents = new Map<string, number>();
    /** Child id to the ladder notice its spawn produced, if any. */
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

    /**
     * Stop one agent and forget it, leaving its session on disk.
     *
     * Distinct from `abort`, which cancels a turn and leaves the agent
     * running, and from `trashSession`, which is this plus deleting what the
     * session wrote. Idempotent: the second call finds nothing to close, which
     * is what makes "closed exactly once" checkable.
     */
    async closeAgent(id: string): Promise<"closed" | "not_found"> {
        return registryLifecycle.closeAgent(this, id);
    }

    /** Root plus every live descendant whose execution it owns. */
    ownedTreeIds(id: string): readonly string[] {
        return registryLifecycle.ownedTreeIds(this, id);
    }

    /**
     * Close one agent and every live agent descended from it.
     *
     * Fence first, quiesce second. `agent.close()` is synchronous and shuts
     * admission, so every member of the subtree is fenced in one pass before
     * anything is awaited; awaiting a child first would leave the parent live
     * for the seconds that child takes to exit, long enough to spawn a
     * subagent nothing is walking any more. Fencing is then repeated to a
     * fixpoint, because a spawn can still have raced the very first pass.
     * Roster entries are removed only at the end, so the parent links the
     * walk follows are still intact while the subtree is being quiesced.
     * Idempotent for the same reason `closeAgent` is: a second call finds
     * nothing left to close and says so.
     */
    async closeAgentTree(id: string): Promise<CloseAgentTreeResult> {
        return registryLifecycle.closeAgentTree(this, id);
    }

    /** Close one live descendant while preserving the caller and its peers. */
    async closeDescendantTree(
        callerId: string,
        targetId: string,
    ): Promise<CloseDescendantTreeResult> {
        return registryLifecycle.closeDescendantTree(this, callerId, targetId);
    }

    /** Release what a quiesced entry still holds and take it off the roster. */
    async reapClosedAgent(
        id: string,
        entry: RegisteredAgentEntry,
    ): Promise<void> {
        return registryLifecycle.reapClosedAgent(this, id, entry);
    }

    /** Every live agent under `id`, deepest first. */
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

    /** The identity name a live session posts under, `undefined` when gone. */
    arcNameOf(id: string): string | undefined {
        return registryLifecycle.arcNameOf(this, id);
    }

    /**
     * Resolves an identity `session` value to the live session it names.
     * Matching uses the identity extension's key when one is loaded, so a
     * purpose tail does not change addressing; a value that is not a name
     * still resolves as a raw agent id, because entries recorded before
     * naming carry ids.
     */
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

    /**
     * The model settings a client sees when it has no session behind it.
     *
     * The catalog, the shortlist and the defaults are the host's, not any
     * conversation's, so they can be read before one exists. The pair reported
     * is the host default: nobody has dialed anything yet.
     */
    readHostModelSettings(workspace?: string): ModelTurnSettings {
        return registrySettings.readHostModelSettings(this, workspace);
    }

    reviewerDefault(): ReviewerModelDefault {
        return registrySettings.reviewerDefault(this);
    }

    /** The reviewer route agents read at each review, not once at start. */
    readReviewer(): ToolReviewerSettings | undefined {
        return registrySettings.readReviewer(this);
    }

    /**
     * Applies a reviewer choice to every running agent and writes it to the
     * config file, so the session the user is in changes with the file rather
     * than at the next start. Any model may be a reviewer: nothing here checks
     * the pool or the catalog, because a reviewer that turns out to be
     * unreachable falls through to the failsafe on its own.
     */
    applyReviewerPatch(patch: ReviewerSettingsPatch | null): boolean {
        return registrySettings.applyReviewerPatch(this, patch);
    }

    /**
     * Validate a pair patch and answer with the settings it resolves to.
     *
     * Shared by the global write and the session-scoped one so a chord and a
     * picker cannot disagree about which levels a model publishes, or coerce an
     * unpublished level differently.
     */
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

    /**
     * The pair a session falls back to when nobody has dialed it.
     *
     * Today that is the host default. Once an agent can carry a `default_pair`
     * the worn agent's answer comes first, and everything that compares against
     * "the default" goes through here so there is one answer to compare with.
     */
    effectiveDefaultPair(
        entry: RegisteredAgentEntry,
    ): ModelTurnSettings {
        return registrySettings.effectiveDefaultPair(this, entry);
    }

    /**
     * Derived at write time on every path, never carried forward.
     *
     * Reclassifying here is what makes dialing back to the default clear the
     * override: a stale `user` origin sitting on a pair that equals the default
     * would show a marker the user could not get rid of by any means except
     * knowing about the record.
     */
    originFor(
        entry: RegisteredAgentEntry,
        settings: ModelTurnSettings,
    ): SessionSettingOrigin {
        return registrySettings.originFor(this, entry, settings);
    }

    /**
     * Dial one session. The host's defaults, and every session that is not this
     * one, are left exactly as they were.
     */
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

    /** The posture for this session alone, leaving the host default alone. */
    async updateSessionPermissionMode(
        id: string,
        mode: ApprovalMode,
    ): Promise<ApprovalMode | undefined> {
        return registryWear.updateSessionPermissionMode(this, id, mode);
    }

    async applySessionPermissionMode(
        id: string,
        mode: ApprovalMode,
    ): Promise<ApprovalMode | undefined> {
        return registryWear.applySessionPermissionMode(this, id, mode);
    }

    /**
     * An explicit permission choice wins over an incompatible agent.
     *
     * The host owns this transition so `/permissions`, the HUD, and other
     * clients cannot disagree. The agent update is deliberately loud and
     * durable: the client receives a sticky transcript notice explaining why
     * the session returned to default.
     */
    async leaveAgentThatForbidsAccess(
        entry: RegisteredAgentEntry,
        id: string,
        mode: ApprovalMode,
    ): Promise<void> {
        return registryWear.leaveAgentThatForbidsAccess(this, entry, id, mode);
    }

    /**
     * The worn agent's default pair, resolved against the pool as it stands.
     *
     * Undefined when the agent names none, or names one the pool no longer
     * has: in both cases the effective default is the host's own, which is
     * what row 7 and row 9 of the origin table say.
     */
    wornAgentDefaultPair(
        entry: RegisteredAgentEntry,
    ): ModelTurnSettings | undefined {
        return registryWear.wornAgentDefaultPair(this, entry);
    }

    /**
     * The worn agent's posture. Omitted on the agent means the host's current
     * default, resolved now rather than frozen at wear: editing the default
     * has to reach the sessions that never named one.
     */
    wornAgentPosture(
        entry: RegisteredAgentEntry,
    ): ApprovalMode | undefined {
        return registryWear.wornAgentPosture(this, entry);
    }

    /** Every agent this session could wear, with the one in force named. */
    async listAgentsFor(id: string): Promise<{
        readonly worn: string;
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
        return registryWear.listAgentsFor(this, id);
    }

    async listSkillsFor(id: string): Promise<SkillCommandCatalog> {
        return registryWear.listSkillsFor(this, id);
    }

    async decideSkillInvocationFor(
        id: string,
        name: string,
    ): Promise<SkillInvocationDecision> {
        return registryWear.decideSkillInvocationFor(this, id, name);
    }

    async agentCatalogFor(
        entry: RegisteredAgentEntry,
    ): Promise<AgentCatalog> {
        return registryWear.agentCatalogFor(this, entry);
    }

    /**
     * Put an agent on. Records the resolved definition, adopts its default
     * pair when nobody has dialled this session, and answers with what is now
     * in force.
     */
    async wearAgentFor(id: string, name: string): Promise<{
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly notice?: string;
        readonly permissionChanged?: boolean;
    } | undefined> {
        return registryWear.wearAgentFor(this, id, name);
    }

    async applyAgentWear(id: string, name: string): Promise<{
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly notice?: string;
        readonly permissionChanged?: boolean;
    } | undefined> {
        return registryWear.applyAgentWear(this, id, name);
    }

    /**
     * Rows 7 to 9 of the origin table, in one place.
     *
     * A session the user has dialled keeps its pair: the override survives an
     * agent switch, which is the difference between a dial and a default.
     */
    async adoptAgentDefaultPair(
        entry: RegisteredAgentEntry,
        definition: AgentDefinition,
    ): Promise<string | undefined> {
        return registryWear.adoptAgentDefaultPair(this, entry, definition);
    }

    /**
     * Table 8.2: what a resumed session does about the agent it was wearing.
     *
     * Agents are by reference, so a definition that moved is worn as it is
     * now. The notice is what stops that from being a silent change of what
     * the session can reach.
     */
    async reconcileResumedAgentWear(
        entry: RegisteredAgentEntry,
        events: EngineEventBus,
    ): Promise<void> {
        return registryWear.reconcileResumedAgentWear(this, entry, events);
    }

    /** The narrow writer: one key, one file, temp-and-rename. */
    async updateAgentDefaultPairFor(
        id: string,
        name: string,
        pair: { readonly name: string; readonly effort?: string } | null,
    ): Promise<string | undefined> {
        return registryWear.updateAgentDefaultPairFor(this, id, name, pair);
    }

    /**
     * Editing the pool never changes which model runs, so the settings that
     * come back are unchanged apart from the new pool. It refuses an unknown
     * agent for the same reason every other command does: the reply is that
     * agent's snapshot, and there is none to send.
     */
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

    /**
     * The `pool_add` tool's effect: the same admission hook the client's
     * checklist calls, one model at a time, reported back as per-model
     * verdict lines. Verdicts land in the tool result rather than as
     * progress updates: the transcript is the surface the agent path owns.
     */
    async applyPoolAddEffect(
        effect: { readonly models: readonly string[] },
    ): Promise<ToolOutput> {
        return registrySettings.applyPoolAddEffect(this, effect);
    }

    /**
     * The `agent_roster` tool's effect: the host's live session table, cut to
     * the caller's workspace and to the sessions still running in it.
     *
     * Every field is observed. The name was minted when the session
     * registered, the activity time is the last thing written to that
     * session's log, and the path is where the log lives. Nothing here is
     * declared by an agent and nothing is stored, so a host that is gone and
     * an empty roster mean the same thing.
     */
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

    /**
     * Wakes the recipient for a peer message it just received, when the host
     * is willing to. Three things can hold it back, and the sender is told
     * which: a session that does not run tools on its own does not get its
     * turn taken by another agent either, a chain of messages may only run so
     * deep, and no session may be woken faster than a person could follow.
     *
     * What arrives is a notice, never the message. The text stays in the inbox
     * until the recipient reads it there, so the read receipt keeps meaning
     * what it says.
     */
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

    /**
     * Refetches a provider's list on the user's say-so and answers with the
     * settings the refreshed list produces, so the pane that asked can redraw
     * from one reply. A provider that cannot be asked leaves the list alone:
     * a stale list beats an empty one, which is the same rule discovery
     * itself follows on a failed fetch.
     */
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
        return registryWear.updateApprovalMode(this, id, mode);
    }

    async applyApprovalMode(
        id: string,
        mode: ApprovalMode,
    ): Promise<ApprovalMode | undefined> {
        return registryWear.applyApprovalMode(this, id, mode);
    }

    /**
     * The posture a session ran under, for a spawn that has one to inherit.
     * `undefined` when the id names no session here, which is the cold case.
     */
    approvalModeOf(agentId: string): ApprovalMode | undefined {
        return registryWear.approvalModeOf(this, agentId);
    }

    /**
     * Rename a session by id rather than through an attachment.
     *
     * An attached session is refused: its client holds the name it is
     * displaying and learns of a change only by replying to its own
     * `update_session_name`, so writing the store from here would leave that
     * client showing a name the session no longer has.
     */
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

    /**
     * Watch for anything that would change what `list` answers about who is
     * registered and what is running: a session registered or forgotten, and
     * any agent starting or stopping a turn.
     *
     * Returns the unsubscribe. Listeners are told that something changed, not
     * what changed, because the only reader wants a fresh derivation anyway.
     */
    onRosterChanged(listener: () => void): () => void {
        return registryRoster.onRosterChanged(this, listener);
    }

    notifyRosterChanged(): void {
        return registryRoster.notifyRosterChanged(this);
    }

    list(): RegisteredAgentSummary[] {
        return registryRoster.list(this);
    }

    /**
     * The live facts the work index is built from, one entry per listed agent.
     *
     * A separate reading rather than more fields on the listing: these are the
     * facts of a running process (what it is blocked on, what tool is in
     * flight) and they are meaningless for the sessions that are merely on
     * disk, which is most of what a listing returns.
     */
    workFacts(): readonly WorkAgentFacts[] {
        return registryRoster.workFacts(this);
    }

    /**
     * Turn emitted schedule runs into work rows, dropping the ones with no
     * session behind them.
     *
     * A schedule addresses a consumer label, and a session's label is its
     * agent id, so a run that named a session this host holds resolves here.
     * One that named anything else is left out: a row whose enter key opens
     * nothing is worse than no row.
     */
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
        // Named so the getters below can reach the registry's own options:
        // inside an object literal `this` is the literal, not the registry.
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
            // Resume wears the recorded agent immediately, so the first turn
            // after a restart runs under the same scope the last one did. The
            // comparison against the current definition happens below, once
            // the catalog can be read.
            ...(store.agentWear() === undefined
                ? {}
                : { agentWear: store.agentWear()!.snapshot }),
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
        void this.reconcileResumedAgentWear(entry, events);
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
                    // A spawn has no surface for a nudge, and the parser is
                    // what says so.
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
        // Read at each compact, not copied for the session: an assignment the
        // user changes has to reach a compact already in this session.
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
                // The registry the host assembled. Extension-registered
                // strategies join this list when activation lands; binding
                // stays agnostic.
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
                // Every shell this session spawns carries its identity name,
                // so arc stamps the session's posts with it and self-echo
                // suppression matches with no manual export.
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
                // Read at each use, not copied for the session: a setting the
                // user changes has to reach a session already running.
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
                    this.options.developerSettings?.(),
                    store.header.cwd,
                    this.options.refreshableProviders?.(),
                ),
                readAgentWear: () => entry.agentWear,
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
                    wearAgent: (name) => this.wearAgentFor(agent.id, name),
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
                            // One candidate, so the route cannot fall back:
                            // the caller named a model and gets that model or
                            // an error.
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
                                // Preferences are the host's, not the
                                // session's, so every worker needs the new
                                // list, not just this one.
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
                // A refused start is a decision with a next action, so it
                // reaches the client as itself rather than as the generic
                // outcome used when a running agent stops.
                const detail = error instanceof WorkerCapReachedError
                    ? error.message
                    : "Resident agent stopped unexpectedly";
                try {
                    await store.appendAgentFailure(failureId, detail);
                } catch {
                    // Live clients still need a terminal outcome when the
                    // failure record itself cannot be persisted.
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
                // The minted name, not the agent id: arc stamps posts with
                // the ARC_SESSION the shell carries, which is this name, so
                // the self-echo pair must hold the same value.
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

    /**
     * How this session's worker would build its adapter, or nothing.
     *
     * A spec is the default. Nothing means the turn runs in this process,
     * which happens when the owner cannot rebuild the adapter from JSON.
     */
    workerAdapterSpecFor(
        store: SessionStore,
        entry: RegisteredAgentEntry,
    ): WorkerAdapterSpec | undefined {
        return registrySubagent.workerAdapterSpecFor(this, store, entry);
    }

    /**
     * Runs the turn loop in a separate process, and reports how it stopped.
     *
     * The client channel is pumped in both directions here rather than by the
     * loop, and every durable service stays on this side. A `kill -9` on the
     * worker therefore lands on `handle.outcome` as one typed value, and the
     * session file it was writing through is already complete on disk.
     */
    /**
     * The extensions a worker should load for itself, or nothing.
     *
     * Nothing is the default: the tools stay in this process and the worker
     * reaches them over the boundary.
     */
    workerExtensions(
        workspace: string,
    ): readonly VeraExtensionConfig[] | undefined {
        return registrySubagent.workerExtensions(this, workspace);
    }

    /**
     * Sends this session's worker the owner state as it now stands.
     *
     * A no-op for a session whose loop runs in this process, which reads the
     * same values directly.
     */
    pushWorkerState(id: string): void {
        return registrySubagent.pushWorkerState(this, id);
    }

    /** Sends every running worker the owner state as it now stands. */
    pushWorkerStateEverywhere(): void {
        return registrySubagent.pushWorkerStateEverywhere(this);
    }

    /** Sessions whose loop currently runs in a separate process. */
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

    /** One event-loop turn admits siblings; later arrivals queue behind it. */
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

    /** Keeps shutdown waiting on a delivery that is mid-flight. */
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

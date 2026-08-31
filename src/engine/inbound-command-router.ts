import { randomUUID } from "node:crypto";

import { AsyncQueue } from "./async-queue.ts";
import type {
    ConfigurationRequiredUiRequest,
    ConfigurationRequiredUiResponse,
    EngineEventBus,
    PoolAdmissionVerdict,
    ToolApprovalUiResponse,
    UserQuestionChoice,
    UserQuestionUiRequest,
    UserQuestionUiResponse,
} from "./events.ts";
import type {
    AgentUpdate,
    OneshotCommand,
    OneshotMessage,
    OneshotRejectedUpdate,
    OneshotResultUpdate,
    PromptCommand,
    SessionNameReplyUpdate,
    UiResponseCommand,
} from "./protocol.ts";
import { isTimelineCommand, type TimelineCommand } from "./protocol.ts";
import type { EngineCommand } from "./timeline-control.ts";
import type {
    ModelSettingsPatch,
    ModelTurnSettings,
} from "./model-settings.ts";
import type { MessageChannel } from "./message-channel.ts";
import type { HookToolCall } from "../sdk/hooks.ts";
import type {
    ApprovalMode,
    PermissionGrantProposal,
    PermissionInspection,
    PermissionPredicate,
    PermissionPreference,
} from "./permissions.ts";
import type { ModelMessage } from "../model/types.ts";
import type { SessionSettingOrigin } from "../store/session-store.ts";
import type { PromptQueueState } from "./prompt-queue.ts";

/** A session-scoped model write, and how it was classified. */
export interface SessionModelSettingsResult {
    readonly settings: ModelTurnSettings;
    readonly origin: SessionSettingOrigin;
}

/**
 * What the approval is actually agreeing to. The line is the last thing read
 * before allowing, so it names the authority the tool takes rather than the
 * authority a shell takes: a fetch that warns about child processes teaches
 * the reader to skip the warning.
 */
const AUTHORITY_WARNINGS: Readonly<Record<string, string>> = {
    bash: "If allowed, this command and its child processes run with your"
        + " full user permissions.",
    write: "If allowed, Vera writes this file with your full user permissions,"
        + " inside the workspace or outside it.",
    edit: "If allowed, Vera changes this file with your full user permissions,"
        + " inside the workspace or outside it.",
    read: "If allowed, Vera reads this file with your full user permissions,"
        + " inside the workspace or outside it.",
    web_fetch: "If allowed, Vera requests this address from your machine, over"
        + " your network.",
    web_search: "If allowed, Vera sends this query to a search service from"
        + " your machine.",
    web_download: "If allowed, Vera requests this address from your machine"
        + " and saves the file it returns to your computer.",
};

const DEFAULT_AUTHORITY_WARNING =
    "If allowed, this runs with your full user permissions.";

const BROWSER_AUTHORITY_WARNING =
    "If allowed, Vera acts in your browser, in your signed-in sessions.";

function authorityWarning(tool: string): string {
    return AUTHORITY_WARNINGS[tool]
        ?? (tool.startsWith("browser_")
            ? BROWSER_AUTHORITY_WARNING
            : DEFAULT_AUTHORITY_WARNING);
}

export interface ToolApprovalOptions {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly sourceAgentId?: string;
    readonly sourceTask?: string;
    readonly permissionGrants?: readonly PermissionGrantProposal[];
}

export interface ToolApprovalAllowed {
    readonly behavior: "allow";
}

export interface ToolApprovalDenied {
    readonly behavior: "deny";
    readonly reason: string;
}

export type ToolApprovalResult = ToolApprovalAllowed | ToolApprovalDenied;

interface PendingApproval {
    readonly resolve: (result: ToolApprovalResult) => void;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
    readonly permissionGrants?: readonly PermissionGrantProposal[];
}

export interface UserQuestionOptions {
    readonly signal?: AbortSignal;
    readonly outOfBand?: true;
}

export interface UserQuestionSelected {
    readonly outcome: "selected";
    readonly choice: UserQuestionChoice;
    readonly notes?: string;
}

export interface UserQuestionCancelled {
    readonly outcome: "cancelled";
}

export interface UserQuestionCustom {
    readonly outcome: "custom";
    readonly text: string;
}

export type UserQuestionResult =
    | UserQuestionSelected
    | UserQuestionCustom
    | UserQuestionCancelled;

interface PendingQuestion {
    readonly request: UserQuestionUiRequest;
    readonly resolve: (result: UserQuestionResult) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
}

export type ConfigurationRequiredResult =
    ConfigurationRequiredUiResponse["outcome"];

interface PendingConfigurationRequired {
    readonly resolve: (result: ConfigurationRequiredResult) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
}

export interface InboundTurn {
    readonly prompt: PromptCommand;
    /** Later user messages admitted to the same model turn, in FIFO order. */
    readonly additionalPrompts?: readonly PromptCommand[];
    readonly signal: AbortSignal;
    readonly modelSettings?: ModelTurnSettings;
    readonly triggeredByDelivery?: true;
    /** Authority minted only by the router's typed skill-command path. */
    readonly userInvokedSkill?: string;
}

interface QueuedTurnContext {
    readonly modelSettings?: ModelTurnSettings;
}

interface QueuedPrompt extends QueuedTurnContext {
    readonly prompt: PromptCommand;
    readonly triggeredByDelivery?: never;
    readonly wear?: never;
    readonly skillInvocation?: never;
    readonly userInvokedSkill?: string;
}

interface QueuedDeliveryTurn extends QueuedTurnContext {
    readonly prompt?: never;
    readonly triggeredByDelivery: true;
    readonly wear?: never;
    readonly skillInvocation?: never;
}

/**
 * A wear waiting its turn in the same queue as the prompts.
 *
 * It is not a turn: `startTurn` applies it and keeps waiting. That is what
 * makes "applies after the current work" true without hybridising a prompt
 * that was queued before it.
 */
interface QueuedWear extends Partial<QueuedTurnContext> {
    readonly wear: { readonly requestId: string; readonly name: string };
    readonly prompt?: never;
    readonly triggeredByDelivery?: never;
    readonly skillInvocation?: never;
}

/**
 * A typed skill command waiting behind any earlier turns and wear changes.
 *
 * Validation happens when this item reaches the front of the queue. Doing it
 * on socket arrival would validate against the agent worn before an earlier
 * queued `/agent` command, then run the turn under the agent worn after it.
 */
interface QueuedSkillInvocation extends QueuedTurnContext {
    readonly skillInvocation: {
        readonly requestId: string;
        readonly name: string;
        readonly argumentsText: string;
    };
    readonly prompt?: never;
    readonly triggeredByDelivery?: never;
    readonly wear?: never;
}

type QueuedTurn =
    | QueuedPrompt
    | QueuedDeliveryTurn
    | QueuedWear
    | QueuedSkillInvocation;

type QueueReleaseMode = "direct" | "automatic" | "one" | "all";

interface QueueRelease {
    readonly id: number;
    readonly mode: QueueReleaseMode;
    readonly boundary: QueuedTurn;
}

interface ActiveQueueTurn {
    readonly releaseId: number;
    readonly releaseMode: QueueReleaseMode;
    readonly final: boolean;
    readonly queuedPrompt: boolean;
}

export type InboundTurnOutcome = "completed" | "aborted" | "failed";

export interface InboundCommandRouterOptions {
    readonly appendHarnessMessage?: (
        text: string,
        tone: "primary" | "soft" | "error",
    ) => Promise<void>;
    readonly appendContext?: (
        messages: readonly ModelMessage[],
        harnessMessage: {
            readonly text: string;
            readonly tone: "primary" | "soft" | "error";
        },
    ) => Promise<void>;
    readonly hasPendingDeliveryTurn?: () => boolean;
    /** Clears a resident wake that was discarded because its work was drained. */
    readonly onDeliveryTurnDiscarded?: () => void;
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly updateModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<ModelTurnSettings | undefined>;
    /**
     * Writes the session's own model settings and answers with the origin the
     * write was classified as. Undefined means the patch did not apply.
     */
    readonly updateSessionModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<SessionModelSettingsResult | undefined>;
    readonly readSessionModelSettingsHistory?: () => readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: SessionSettingOrigin;
        readonly timestamp: string;
    }[];
    readonly readApprovalModeOrigin?: () => SessionSettingOrigin | undefined;
    readonly updateSessionPermissionMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    /** Applies the wear and answers with what is now in force. */
    readonly wearAgent?: (name: string) => Promise<{
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly notice?: string;
    } | undefined>;
    readonly listAgents?: () => Promise<{
        readonly worn: string;
        readonly agents: readonly {
            readonly name: string;
            readonly description?: string;
            readonly scope: "project" | "user" | "extension";
            readonly writable: boolean;
            readonly tools?: readonly string[];
            readonly skills?: readonly string[];
            readonly posture?: string;
            readonly defaultPair?: {
                readonly name: string;
                readonly effort?: string;
            };
        }[];
        readonly notices: readonly string[];
    }>;
    readonly listSkills?: () => Promise<{
        readonly skills: readonly {
            readonly name: string;
            readonly description: string;
            readonly disableModelInvocation: boolean;
        }[];
        readonly warnings: readonly string[];
    }>;
    readonly invokeSkill?: (name: string) => Promise<
        | { readonly allowed: true }
        | { readonly allowed: false; readonly reason: string }
    >;
    /** Answers with why the write was refused, or nothing when it happened. */
    readonly updateAgentDefaultPair?: (
        name: string,
        pair: { readonly name: string; readonly effort?: string } | null,
    ) => Promise<string | undefined>;
    /**
     * Admits one model and returns the verdict, with the settings snapshot as
     * it stands afterwards so the reply carries the new pool. `verify` asks
     * for the probes, and only then does `onStep` fire per check for the
     * client's checklist.
     */
    readonly poolAdd?: (
        entry: { readonly provider: string; readonly model: string },
        onStep: (step: {
            readonly step: string;
            readonly label: string;
            readonly status: "running" | "passed" | "failed" | "skipped";
            readonly detail?: string;
        }) => void,
        options?: { readonly verify?: boolean },
    ) => Promise<{
        readonly verdict: PoolAdmissionVerdict;
        readonly reason?: string;
        readonly statusCode?: number;
        readonly settings?: ModelTurnSettings;
    }>;
    /**
     * Returns the settings snapshot as it stands after the removal.
     * `undefined` means the edit did not happen.
     */
    readonly poolRemove?: (
        entry: { readonly provider: string; readonly model: string },
    ) => Promise<ModelTurnSettings | undefined>;
    /**
     * Returns the settings snapshot as it stands after the name is set or
     * cleared. `undefined` means the name was refused and nothing changed.
     */
    readonly poolName?: (
        entry: { readonly provider: string; readonly model: string },
        name: string | null,
    ) => Promise<ModelTurnSettings | undefined>;
    /**
     * Returns the settings snapshot as it stands after the move. `undefined`
     * means the move was refused and nothing changed.
     */
    readonly poolMove?: (
        entry: { readonly provider: string; readonly model: string },
        delta: number,
    ) => Promise<ModelTurnSettings | undefined>;
    /**
     * Asks the named provider (or every askable one) for its list now and
     * returns the settings snapshot the refreshed list produces. `undefined`
     * means nothing could be asked, which is a refusal rather than an empty
     * list: the remembered list stays.
     */
    readonly refreshCatalog?: (
        provider: string,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly readApprovalMode?: () => ApprovalMode;
    readonly readPermissionInspection?: () => PermissionInspection | undefined;
    readonly updateApprovalMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    readonly addPermissionPreference?: (
        when: PermissionPredicate,
    ) => Promise<PermissionPreference | undefined>;
    readonly removePermissionPreference?: (id: string) => Promise<boolean>;
    readonly updateSessionName?: (
        name: string | null,
    ) => Promise<string | null | undefined>;
    /**
     * Runs one bounded call against the named model and returns its text. The
     * named model answers or the call fails: this never falls back to another
     * model, because the caller asked for a specific one.
     */
    readonly oneshot?: (
        request: {
            readonly provider?: string;
            readonly model: string;
            readonly reasoningEffort?: string;
            readonly systemPrompt?: string;
            readonly messages: readonly OneshotMessage[];
            readonly maxTokens?: number;
        },
        signal: AbortSignal,
    ) => Promise<{
        readonly text: string;
        readonly model: string;
        readonly provider?: string;
    }>;
    readonly sendOneshotReply?: (
        ownerId: string,
        reply: OneshotResultUpdate | OneshotRejectedUpdate,
    ) => void;
    readonly sendSessionNameReply?: (
        ownerId: string,
        reply: SessionNameReplyUpdate,
    ) => void;
    readonly addPermissionGrants?: (
        grants: readonly PermissionGrantProposal[],
    ) => Promise<void>;
    /** Resolves false when the ID names no live grant. */
    readonly removePermissionGrant?: (id: string) => Promise<boolean>;
    /**
     * Absent when the session cannot compact, so an asked-for compaction on a
     * session with no strategy bound does nothing rather than reporting a
     * failure the user cannot act on.
     */
    readonly compactNow?: (
        turnActive: boolean,
        signal?: AbortSignal,
    ) => Promise<void>;
    readonly handleTimelineCommand?: (
        ownerId: string,
        command: TimelineCommand,
    ) => Promise<void>;
    readonly detachTimelineOwner?: (ownerId: string) => void;
}

export class InboundCommandRouter {
    private readonly queuedTurns: QueuedTurn[] = [];
    private readonly turnAvailable = new AsyncQueue<true>();
    private readonly pendingApprovals = new Map<string, PendingApproval>();
    private readonly pendingQuestions = new Map<string, PendingQuestion>();
    private readonly pendingConfigurations = new Map<
        string,
        PendingConfigurationRequired
    >();
    private waitingForPrompt = false;
    private activeTurn: AbortController | undefined;
    private activeQueueTurn: ActiveQueueTurn | undefined;
    private claimedQueueRelease: QueueRelease | undefined;
    private release: QueueRelease | undefined;
    private queuedDirectAbortId: number | undefined;
    private queuedDirectFollowUp: {
        readonly mode: "direct" | "one" | "all";
        readonly boundary: QueuedTurn;
    } | undefined;
    private resumeAfterAbort = false;
    private nextReleaseId = 1;
    private lastPromptQueueState: PromptQueueState = {
        prompts: [],
        draining: false,
    };
    private receiveFailed = false;
    private pendingPromptCount = 0;
    private deliveryTurnQueued = false;
    private contextAppend: Promise<void> | undefined;
    private compactionAbort: AbortController | undefined;
    private compactionInFlight: Promise<void> | undefined;
    private automaticCompactionAbort: AbortController | undefined;

    constructor(
        endpoint: MessageChannel<AgentUpdate, EngineCommand>,
        private readonly events: EngineEventBus,
        private readonly options: InboundCommandRouterOptions = {},
    ) {
        void this.receiveCommands(endpoint);
    }

    async startTurn(): Promise<InboundTurn> {
        if (this.waitingForPrompt || this.activeTurn !== undefined) {
            throw new Error("A turn is already pending or active");
        }

        this.waitingForPrompt = true;
        let queued: QueuedTurn;
        let claimedItem: QueuedTurn;
        let claimedRelease: QueueRelease;
        try {
            while (true) {
                while (
                    this.release === undefined
                    || this.queuedTurns.length === 0
                ) {
                    await this.turnAvailable.receive();
                }
                claimedRelease = this.release;
                claimedItem = this.queuedTurns.shift()!;
                queued = claimedItem;
                this.claimedQueueRelease = claimedRelease;
                // Keep the item counted while it waits for a background
                // compaction (and while a queued wear is applying). Timeline
                // commands must see the claimed prompt as in flight until it
                // is safe to hand the turn to the engine.
                try {
                    const compaction = this.compactionInFlight;
                    if (compaction !== undefined) {
                        await compaction;
                    }
                    if (queued.wear !== undefined) {
                        await this.applyWear(queued.wear);
                        this.claimedQueueRelease = undefined;
                        this.finishNonTurnQueueItem(claimedItem, claimedRelease);
                        continue;
                    }
                    if (queued.skillInvocation !== undefined) {
                        const prompt = await this.resolveSkillInvocation(
                            queued.skillInvocation,
                            queued.modelSettings,
                        );
                        if (prompt === undefined) {
                            this.claimedQueueRelease = undefined;
                            this.finishNonTurnQueueItem(
                                claimedItem,
                                claimedRelease,
                            );
                            continue;
                        }
                        queued = prompt;
                    }
                    if (
                        queued.triggeredByDelivery !== true
                        || this.options.hasPendingDeliveryTurn?.() !== false
                    ) {
                        if (queued.triggeredByDelivery === true) {
                            this.deliveryTurnQueued = false;
                        }
                        break;
                    }
                    this.deliveryTurnQueued = false;
                } finally {
                    this.pendingPromptCount -= 1;
                }
                this.options.onDeliveryTurnDiscarded?.();
                this.claimedQueueRelease = undefined;
                this.finishNonTurnQueueItem(claimedItem, claimedRelease);
            }
        } finally {
            this.waitingForPrompt = false;
        }
        const additionalPrompts: PromptCommand[] = [];
        if (
            claimedItem.prompt !== undefined
            && claimedRelease.mode === "all"
        ) {
            // One provider turn has one model-settings snapshot. The oldest
            // prompt supplies it; later ordinary prompts remain distinct
            // messages. Queue controls are retained to settle after the batch,
            // so they cannot split one send-all claim into multiple turns.
            const boundaryIndex = this.queuedTurns.indexOf(
                claimedRelease.boundary,
            );
            if (boundaryIndex >= 0) {
                const claimedSnapshot = this.queuedTurns.splice(
                    0,
                    boundaryIndex + 1,
                );
                const retainedControls: QueuedTurn[] = [];
                for (const next of claimedSnapshot) {
                    if (next.prompt === undefined) {
                        retainedControls.push(next);
                        continue;
                    }
                    this.pendingPromptCount -= 1;
                    additionalPrompts.push(next.prompt);
                }
                this.queuedTurns.unshift(...retainedControls);
            }
        }

        const controller = new AbortController();
        this.activeTurn = controller;
        this.activeQueueTurn = {
            releaseId: claimedRelease.id,
            releaseMode: claimedRelease.mode,
            final: claimedRelease.mode === "all"
                && claimedItem.prompt !== undefined
                ? true
                : claimedRelease.boundary === claimedItem,
            queuedPrompt: claimedItem.prompt !== undefined,
        };
        this.claimedQueueRelease = undefined;
        if (this.queuedDirectAbortId === claimedRelease.id) {
            this.queuedDirectAbortId = undefined;
            const followUp = this.queuedDirectFollowUp;
            this.queuedDirectFollowUp = undefined;
            if (followUp !== undefined) this.resumeAfterAbort = false;
            this.release = followUp === undefined
                ? undefined
                : this.newRelease(followUp.mode, followUp.boundary);
            controller.abort(new Error("Turn aborted before it started"));
        }
        this.emitPromptQueue();
        const context = {
            signal: controller.signal,
            ...(queued.modelSettings === undefined
                ? {}
                : { modelSettings: queued.modelSettings }),
        };
        return queued.triggeredByDelivery === true
            ? {
                ...context,
                prompt: { type: "prompt", content: "" },
                triggeredByDelivery: true,
            }
            : {
                ...context,
                prompt: queued.prompt,
                ...(additionalPrompts.length === 0
                    ? {}
                    : { additionalPrompts }),
                ...(queued.userInvokedSkill === undefined
                    ? {}
                    : { userInvokedSkill: queued.userInvokedSkill }),
            };
    }

    finishTurn(outcome?: InboundTurnOutcome): void {
        if (this.activeTurn === undefined || this.activeQueueTurn === undefined) {
            throw new Error("No turn is active");
        }
        const active = this.activeQueueTurn;
        const terminal = outcome
            ?? (this.activeTurn.signal.aborted ? "aborted" : "completed");
        this.activeTurn = undefined;
        this.activeQueueTurn = undefined;

        // A release or plain stop accepted during this turn already chose what
        // may run next. The old turn's terminal event cannot overwrite it.
        if (this.release?.id !== active.releaseId) {
            this.emitPromptQueue();
            this.signalTurnAvailable();
            return;
        }

        if (terminal !== "completed") {
            this.release = undefined;
        } else if (active.final) {
            this.finishRelease(active.releaseMode);
        }
        this.emitPromptQueue();
        this.signalTurnAvailable();
    }

    private enqueueTurn(queued: QueuedTurn): void {
        if (
            this.resumeAfterAbort
            && this.queuedDirectAbortId !== undefined
            && this.queuedDirectFollowUp === undefined
            && queued.prompt !== undefined
        ) {
            this.queuedDirectFollowUp = {
                mode: "direct",
                boundary: queued,
            };
            this.resumeAfterAbort = false;
        }
        const startsDirectly = this.activeTurn === undefined
            || (this.resumeAfterAbort && this.activeTurn.signal.aborted);
        const opensTurn = startsDirectly
            && this.release === undefined
            && this.queuedTurns.length === 0;
        this.queuedTurns.push(queued);
        this.pendingPromptCount += 1;
        if (opensTurn) {
            this.release = this.newRelease("direct", queued);
            this.resumeAfterAbort = false;
        } else if (queued.prompt !== undefined) {
            this.events.emit({
                type: "prompt_queued",
                content: queued.prompt.content,
            });
        }
        this.emitPromptQueue();
        this.signalTurnAvailable();
    }

    private releaseQueuedPrompts(mode: "one" | "all"): void {
        // Key-repeat and concurrent attachments cannot expand a release that
        // has already been accepted but has not reached its fence yet.
        if (
            this.release?.mode === "one"
            || this.release?.mode === "all"
            || this.queuedDirectFollowUp?.mode === "one"
            || this.queuedDirectFollowUp?.mode === "all"
        ) {
            return;
        }
        const directBoundaryIndex = this.release?.mode === "direct"
            ? this.queuedTurns.indexOf(this.release.boundary)
            : -1;
        const promptIndices = this.queuedTurns.flatMap((queued, index) =>
            queued.prompt !== undefined && index > directBoundaryIndex
                ? [index]
                : []
        );
        if (promptIndices.length === 0) return;
        const boundaryIndex = mode === "all"
            ? this.queuedTurns.length - 1
            : (promptIndices[1] ?? this.queuedTurns.length) - 1;
        const boundary = this.queuedTurns[boundaryIndex]!;

        const queuedDirect = this.activeTurn === undefined
            && this.release?.mode === "direct"
            && (
                directBoundaryIndex >= 0
                || this.claimedQueueRelease?.id === this.release.id
            );
        if (queuedDirect) {
            this.queuedDirectAbortId = this.release!.id;
            this.queuedDirectFollowUp = { mode, boundary };
            this.resumeAfterAbort = false;
            this.emitPromptQueue();
            this.events.emit({ type: "abort_requested" });
            this.signalTurnAvailable();
            return;
        }

        this.release = this.newRelease(mode, boundary);
        this.resumeAfterAbort = false;
        // Publish the atomic claim before the abort can produce a terminal
        // update and make the client paint the next boundary.
        this.emitPromptQueue();
        if (this.activeTurn !== undefined) {
            this.events.emit({ type: "abort_requested" });
            this.activeTurn.abort(new Error("Turn steered"));
        }
        this.signalTurnAvailable();
    }

    private plainAbort(): void {
        const visibleQueuedPrompts = this.promptQueueState().prompts.length;
        const claimedTurn = this.activeTurn === undefined
            ? this.claimedQueueRelease
            : undefined;
        const queuedDirect = this.activeTurn === undefined
            && this.release?.mode === "direct"
            && (
                this.queuedTurns.includes(this.release.boundary)
                || this.claimedQueueRelease?.id === this.release.id
            );
        this.resumeAfterAbort = visibleQueuedPrompts === 0;
        if (queuedDirect || claimedTurn !== undefined) {
            this.queuedDirectAbortId = claimedTurn?.id ?? this.release!.id;
            this.queuedDirectFollowUp = undefined;
            if (!queuedDirect) this.release = undefined;
            this.emitPromptQueue();
            this.events.emit({ type: "abort_requested" });
            this.compactionAbort?.abort(new Error("Compaction aborted"));
            this.signalTurnAvailable();
            return;
        }
        this.release = undefined;
        this.emitPromptQueue();

        // A running compaction claims an ordinary stop. Queue releases use a
        // separate path because steering must stop the containing turn.
        const compaction = this.automaticCompactionAbort
            ?? this.compactionAbort;
        if (compaction !== undefined) {
            this.events.emit({ type: "abort_requested" });
            compaction.abort(new Error("Compaction aborted"));
        } else if (this.activeTurn !== undefined) {
            this.events.emit({ type: "abort_requested" });
            this.activeTurn.abort(new Error("Turn aborted"));
        }
    }

    private finishNonTurnQueueItem(
        queued: QueuedTurn,
        release: QueueRelease,
    ): void {
        if (this.release?.id !== release.id || release.boundary !== queued) {
            return;
        }
        if (this.queuedDirectAbortId === release.id) {
            this.queuedDirectAbortId = undefined;
            const followUp = this.queuedDirectFollowUp;
            this.queuedDirectFollowUp = undefined;
            this.release = followUp === undefined
                ? undefined
                : this.newRelease(followUp.mode, followUp.boundary);
            this.emitPromptQueue();
            this.signalTurnAvailable();
            return;
        }
        this.finishRelease(release.mode);
        this.emitPromptQueue();
        this.signalTurnAvailable();
    }

    private finishRelease(mode: QueueReleaseMode): void {
        if (
            mode === "direct"
            || mode === "automatic"
            || mode === "all"
        ) {
            // A completed ordinary or send-all turn holds later prompts for
            // Escape or Enter, while queued controls still settle before them.
            const heldPromptIndex = this.queuedTurns.findIndex(
                (queued) => queued.prompt !== undefined,
            );
            const automaticBoundaryIndex = heldPromptIndex === -1
                ? this.queuedTurns.length - 1
                : heldPromptIndex - 1;
            if (automaticBoundaryIndex < 0) {
                this.release = undefined;
                return;
            }
            this.release = this.newRelease(
                "automatic",
                this.queuedTurns[automaticBoundaryIndex]!,
            );
            return;
        }
        this.release = undefined;
    }

    private newRelease(
        mode: QueueReleaseMode,
        boundary: QueuedTurn,
    ): QueueRelease {
        return { id: this.nextReleaseId++, mode, boundary };
    }

    private signalTurnAvailable(): void {
        if (this.release !== undefined && this.queuedTurns.length > 0) {
            this.turnAvailable.push(true);
        }
    }

    private promptQueueState(): PromptQueueState {
        const effectiveRelease = this.queuedDirectFollowUp ?? this.release;
        const boundaryIndex = effectiveRelease === undefined
            ? -1
            : this.queuedTurns.indexOf(effectiveRelease.boundary);
        const directBoundaryIndex = this.release?.mode === "direct"
            ? this.queuedTurns.indexOf(this.release.boundary)
            : -1;
        const releasedPromptPending = this.queuedTurns.some(
            (queued, index) => queued.prompt !== undefined
                && index > directBoundaryIndex
                && boundaryIndex >= index,
        );
        const releasedPromptActive = this.release !== undefined
            && this.activeQueueTurn?.releaseId === this.release.id
            && this.activeQueueTurn.queuedPrompt;
        return {
            prompts: this.queuedTurns.flatMap((queued, index) =>
                queued.prompt === undefined
                    || directBoundaryIndex >= index
                    ? []
                    : [{
                        content: queued.prompt.content,
                        ...(queued.prompt.attachmentIds === undefined
                            ? {}
                            : {
                                attachmentIds: [
                                    ...queued.prompt.attachmentIds,
                                ],
                            }),
                        state: boundaryIndex >= index ? "released" : "held",
                    } as const]
            ),
            draining: effectiveRelease !== undefined
                && effectiveRelease.mode !== "direct"
                && (releasedPromptPending || releasedPromptActive),
        };
    }

    private emitPromptQueue(): void {
        const queue = this.promptQueueState();
        if (samePromptQueueState(queue, this.lastPromptQueueState)) return;
        this.lastPromptQueueState = queue;
        this.events.emit({
            type: "prompt_queue_changed",
            queue,
        });
    }

    async appendContext(
        messages: readonly ModelMessage[],
        harnessMessage: {
            readonly text: string;
            readonly tone: "primary" | "soft" | "error";
        },
    ): Promise<boolean> {
        if (
            this.hasPendingTurn()
            || this.contextAppend !== undefined
            || this.options.appendContext === undefined
        ) {
            return false;
        }
        const append = this.options.appendContext(
            structuredClone(messages),
            { ...harnessMessage },
        );
        this.contextAppend = append;
        try {
            await append;
            return true;
        } finally {
            if (this.contextAppend === append) {
                this.contextAppend = undefined;
            }
        }
    }

    timelineBlocked(): boolean {
        return this.activeTurn !== undefined
            || this.pendingPromptCount > 0
            || this.pendingApprovals.size > 0
            || this.pendingQuestions.size > 0
            || this.pendingConfigurations.size > 0;
    }

    /** Whether this router, rather than a remote loop, owns the response ID. */
    ownsUiRequest(requestId: string): boolean {
        return this.pendingApprovals.has(requestId)
            || this.pendingQuestions.has(requestId)
            || this.pendingConfigurations.has(requestId);
    }

    requestToolApproval(
        toolCall: HookToolCall,
        reason: string,
        options: ToolApprovalOptions,
    ): Promise<ToolApprovalResult> {
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
            throw new Error("Approval timeout must be a positive finite number");
        }
        if (this.receiveFailed) {
            return Promise.resolve(noClientDenial());
        }
        if (options.signal?.aborted) {
            return Promise.resolve(abortedDenial());
        }

        const requestId = randomUUID();
        const result = new Promise<ToolApprovalResult>((resolve) => {
            const timer = setTimeout(() => {
                this.finishApproval(requestId, {
                    behavior: "deny",
                    reason: "Tool approval timed out.",
                });
            }, options.timeoutMs);
            const pending: PendingApproval = {
                resolve,
                timer,
                ...(options.permissionGrants === undefined
                    ? {}
                    : {
                        permissionGrants: options.permissionGrants.map(
                            copyPermissionGrantProposal,
                        ),
                    }),
                ...(options.signal === undefined
                    ? {}
                    : {
                        signal: options.signal,
                        onAbort: () => {
                            this.finishApproval(requestId, abortedDenial());
                        },
                    }),
            };
            this.pendingApprovals.set(requestId, pending);
            pending.signal?.addEventListener("abort", pending.onAbort!, {
                once: true,
            });
        });

        this.events.emit({
            type: "ui_request",
            requestId,
            request: {
                type: "tool_approval",
                toolCall,
                reason,
                warning: authorityWarning(toolCall.name),
                ...(options.sourceAgentId === undefined
                    ? {}
                    : { sourceAgentId: options.sourceAgentId }),
                ...(options.sourceTask === undefined
                    ? {}
                    : { sourceTask: options.sourceTask }),
                ...(options.permissionGrants === undefined
                    ? {}
                    : {
                        permissionGrants: options.permissionGrants.map(
                            copyPermissionGrantProposal,
                        ),
                    }),
            },
        });
        return result;
    }

    requestUserQuestion(
        request: Omit<UserQuestionUiRequest, "type">,
        options: UserQuestionOptions = {},
    ): Promise<UserQuestionResult> {
        if (this.receiveFailed || options.signal?.aborted) {
            return Promise.resolve({ outcome: "cancelled" });
        }

        const semanticRequest: UserQuestionUiRequest = {
            type: "user_question",
            question: request.question,
            choices: request.choices.map((choice) => ({ ...choice })),
            ...(options.outOfBand === true ? { outOfBand: true } : {}),
        };
        const requestId = randomUUID();
        const result = new Promise<UserQuestionResult>((resolve) => {
            const pending: PendingQuestion = {
                request: semanticRequest,
                resolve,
                ...(options.signal === undefined
                    ? {}
                    : {
                        signal: options.signal,
                        onAbort: () => {
                            this.finishQuestion(requestId, {
                                outcome: "cancelled",
                            });
                        },
                    }),
            };
            this.pendingQuestions.set(requestId, pending);
            pending.signal?.addEventListener("abort", pending.onAbort!, {
                once: true,
            });
        });

        this.events.emit({
            type: "ui_request",
            requestId,
            request: semanticRequest,
        });
        return result;
    }

    requestConfigurationRequired(
        request: Omit<ConfigurationRequiredUiRequest, "type">,
        options: { readonly signal?: AbortSignal } = {},
    ): Promise<ConfigurationRequiredResult> {
        if (this.receiveFailed) return Promise.resolve("unavailable");
        if (options.signal?.aborted) return Promise.resolve("cancelled");

        const requestId = randomUUID();
        const semanticRequest: ConfigurationRequiredUiRequest = {
            type: "configuration_required",
            destination: structuredClone(request.destination),
            reason: request.reason,
            pendingAction: { ...request.pendingAction },
        };
        const result = new Promise<ConfigurationRequiredResult>((resolve) => {
            const pending: PendingConfigurationRequired = {
                resolve,
                ...(options.signal === undefined ? {} : {
                    signal: options.signal,
                    onAbort: () => {
                        this.finishConfigurationRequired(requestId, "cancelled");
                    },
                }),
            };
            this.pendingConfigurations.set(requestId, pending);
            pending.signal?.addEventListener("abort", pending.onAbort!, {
                once: true,
            });
        });
        this.events.emit({
            type: "ui_request",
            requestId,
            request: semanticRequest,
        });
        return result;
    }

    private async receiveCommands(
        endpoint: MessageChannel<AgentUpdate, EngineCommand>,
    ): Promise<void> {
        try {
            while (true) {
                const command = await endpoint.receive();
                if (command.type === "owned_timeline_command") {
                    await this.options.handleTimelineCommand?.(
                        command.ownerId,
                        command.command,
                    );
                    continue;
                }
                if (command.type === "owned_oneshot_command") {
                    // Not awaited: a oneshot is a side call, and blocking the
                    // command loop on it would stall the user's own turn.
                    void this.oneshot(command.ownerId, command.command);
                    continue;
                }
                if (command.type === "owned_session_name_command") {
                    await this.updateSessionName(
                        command.ownerId,
                        command.command.requestId,
                        command.command.name,
                    );
                    continue;
                }
                if (command.type === "timeline_owner_detached") {
                    this.options.detachTimelineOwner?.(command.ownerId);
                    continue;
                }
                if (command.type === "trigger_delivery_turn") {
                    await this.contextAppend;
                    if (this.deliveryTurnQueued) {
                        continue;
                    }
                    this.deliveryTurnQueued = true;
                    const settings = this.options.readModelSettings?.();
                    this.enqueueTurn({
                        triggeredByDelivery: true,
                        ...(settings === undefined
                            ? {}
                            : { modelSettings: copyModelSettings(settings) }),
                    });
                    continue;
                }
                if (isTimelineCommand(command)) {
                    await this.options.handleTimelineCommand?.(
                        "direct-client",
                        command,
                    );
                    continue;
                }
                if (command.type === "prompt") {
                    await this.contextAppend;
                    const settings = this.options.readModelSettings?.();
                    this.enqueueTurn({
                        prompt: command,
                        ...(settings === undefined
                            ? {}
                            : { modelSettings: copyModelSettings(settings) }),
                    });
                    continue;
                }

                if (command.type === "release_queued_prompts") {
                    this.releaseQueuedPrompts(command.mode);
                    continue;
                }

                if (command.type === "append_harness_message") {
                    try {
                        await this.options.appendHarnessMessage?.(
                            command.text,
                            command.tone,
                        );
                    } catch {
                        // The originating client already showed the line. A
                        // persistence failure must not stop later commands.
                    }
                    continue;
                }

                if (command.type === "ui_response") {
                    await this.receiveUiResponse(command);
                    continue;
                }

                if (command.type === "get_model_settings") {
                    this.sendModelSettings(command.requestId);
                    continue;
                }

                if (command.type === "update_model_settings") {
                    await this.updateModelSettings(
                        command.requestId,
                        command.patch,
                    );
                    continue;
                }

                if (command.type === "update_session_model_settings") {
                    await this.updateSessionModelSettings(
                        command.requestId,
                        command.patch,
                    );
                    continue;
                }

                if (command.type === "get_session_model_settings_history") {
                    this.sendSessionModelSettingsHistory(command.requestId);
                    continue;
                }

                if (command.type === "wear_agent") {
                    // Queued, never applied here: FIFO with the prompts is
                    // the whole point.
                    this.enqueueTurn({
                        wear: {
                            requestId: command.requestId,
                            name: command.name,
                        },
                    });
                    continue;
                }

                if (command.type === "list_agents") {
                    await this.listAgents(command.requestId);
                    continue;
                }

                if (command.type === "list_skills") {
                    await this.listSkills(command.requestId);
                    continue;
                }

                if (command.type === "invoke_skill") {
                    await this.contextAppend;
                    const settings = this.options.readModelSettings?.();
                    this.enqueueTurn({
                        skillInvocation: {
                            requestId: command.requestId,
                            name: command.name,
                            argumentsText: command.argumentsText,
                        },
                        ...(settings === undefined
                            ? {}
                            : { modelSettings: copyModelSettings(settings) }),
                    });
                    continue;
                }

                if (command.type === "update_agent_default_pair") {
                    await this.updateAgentDefaultPair(
                        command.requestId,
                        command.name,
                        command.pair,
                    );
                    continue;
                }

                if (command.type === "update_session_permission_mode") {
                    await this.updateSessionPermissionMode(
                        command.requestId,
                        command.mode,
                    );
                    continue;
                }

                if (command.type === "pool_add") {
                    await this.poolAdd(command.requestId, {
                        provider: command.provider,
                        model: command.model,
                    }, command.verify === true);
                    continue;
                }

                if (command.type === "pool_remove") {
                    await this.poolRemove(command.requestId, {
                        provider: command.provider,
                        model: command.model,
                    });
                    continue;
                }

                if (command.type === "catalog_refresh") {
                    await this.refreshCatalog(
                        command.requestId,
                        command.provider,
                    );
                    continue;
                }

                if (command.type === "pool_name") {
                    await this.poolName(command.requestId, {
                        provider: command.provider,
                        model: command.model,
                    }, command.name);
                    continue;
                }

                if (command.type === "pool_move") {
                    await this.poolMove(command.requestId, {
                        provider: command.provider,
                        model: command.model,
                    }, command.delta);
                    continue;
                }

                if (command.type === "get_permissions") {
                    this.sendPermissions(command.requestId);
                    continue;
                }

                if (command.type === "update_permissions") {
                    await this.updatePermissions(command.requestId, command.mode);
                    continue;
                }

                if (command.type === "add_permission_preference") {
                    await this.addPermissionPreference(
                        command.requestId,
                        command.when,
                    );
                    continue;
                }

                if (command.type === "remove_permission_grant") {
                    await this.removePermissionGrant(
                        command.requestId,
                        command.id,
                    );
                    continue;
                }

                if (command.type === "remove_permission_preference") {
                    await this.removePermissionPreference(
                        command.requestId,
                        command.id,
                    );
                    continue;
                }

                if (command.type === "oneshot") {
                    // Not awaited: a oneshot is a side call, and blocking the
                    // command loop on it would stall the user's own turn.
                    void this.oneshot("direct-client", command);
                    continue;
                }

                if (command.type === "update_session_name") {
                    await this.updateSessionName(
                        "direct-client",
                        command.requestId,
                        command.name,
                    );
                    continue;
                }

                if (command.type === "compact") {
                    // Compaction runs between turns, never inside one: the
                    // span it replaces has to be finished and durable. A
                    // queued prompt counts as a turn already underway, since
                    // it can be claimed while the compaction is still running.
                    // Start it in the background so an abort command can
                    // reach the operation while its model call is pending;
                    // startTurn waits before handing a queued prompt over.
                    this.startCompaction(
                        this.activeTurn !== undefined
                            || this.pendingPromptCount > 0,
                    );
                    continue;
                }

                if (command.type === "abort") {
                    this.plainAbort();
                }
            }
        } catch (error) {
            this.receiveFailed = true;
            this.turnAvailable.fail(error);
            for (const requestId of this.pendingApprovals.keys()) {
                this.finishApproval(requestId, noClientDenial());
            }
            for (const requestId of this.pendingQuestions.keys()) {
                this.finishQuestion(requestId, { outcome: "cancelled" });
            }
            for (const requestId of this.pendingConfigurations.keys()) {
                this.finishConfigurationRequired(requestId, "unavailable");
            }
        }
    }

    /**
     * Registers the controller for a compaction the turn loop started, so an
     * abort command can reach it without taking the turn down with it.
     */
    beginAutomaticCompaction(controller: AbortController): void {
        this.automaticCompactionAbort = controller;
    }

    endAutomaticCompaction(controller: AbortController): void {
        if (this.automaticCompactionAbort === controller) {
            this.automaticCompactionAbort = undefined;
        }
    }

    private startCompaction(turnActive: boolean): void {
        if (
            this.compactionInFlight !== undefined
            || this.options.compactNow === undefined
        ) {
            return;
        }
        const controller = new AbortController();
        let work: Promise<void>;
        try {
            work = this.options.compactNow(turnActive, controller.signal);
        } catch {
            return;
        }
        const settled = work
            .catch(() => undefined)
            .finally(() => {
                if (this.compactionInFlight === settled) {
                    this.compactionInFlight = undefined;
                    this.compactionAbort = undefined;
                }
            });
        this.compactionAbort = controller;
        this.compactionInFlight = settled;
    }

    private sendModelSettings(requestId: string): void {
        const settings = this.options.readModelSettings?.();
        if (settings === undefined) {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        this.events.emit({
            type: "model_settings_changed",
            requestId,
            settings: copyModelSettings(settings),
            pending: this.hasPendingTurn(),
        });
    }

    private async updateModelSettings(
        requestId: string,
        patch: ModelSettingsPatch,
    ): Promise<void> {
        let settings: ModelTurnSettings | undefined;
        try {
            settings = await this.options.updateModelSettings?.(patch);
        } catch {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        if (settings === undefined) {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: this.options.updateModelSettings === undefined
                    ? "unavailable"
                    : "invalid",
            });
            return;
        }
        this.events.emit({
            type: "model_settings_changed",
            requestId,
            settings: copyModelSettings(settings),
            pending: this.hasPendingTurn(),
            ...(patch.provider !== undefined
                    || patch.model !== undefined
                    || patch.reasoningEffort !== undefined
                    || patch.contextLimit !== undefined
                ? { updatedDefaults: true as const }
                : {}),
        });
    }

    /**
     * Dial the session, leaving the host's defaults where they are.
     *
     * The reply never carries `updatedDefaults`. A client that saw both flags
     * on one update would have no way to tell which of the two writes actually
     * happened, and "the strip quietly rewrote my defaults" is precisely the
     * outcome this command exists to make impossible.
     */
    private async updateSessionModelSettings(
        requestId: string,
        patch: ModelSettingsPatch,
    ): Promise<void> {
        if (this.options.updateSessionModelSettings === undefined) {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        let result: SessionModelSettingsResult | undefined;
        try {
            result = await this.options.updateSessionModelSettings(patch);
        } catch {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        if (result === undefined) {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: "invalid",
            });
            return;
        }
        this.events.emit({
            type: "model_settings_changed",
            requestId,
            settings: copyModelSettings(result.settings),
            pending: this.hasPendingTurn(),
            updatedSession: true,
            origin: result.origin,
        });
    }

    private async applyWear(
        wear: { readonly requestId: string; readonly name: string },
    ): Promise<void> {
        if (this.options.wearAgent === undefined) {
            this.events.emit({
                type: "agent_rejected",
                requestId: wear.requestId,
                reason: "This host does not support agents.",
            });
            return;
        }
        const worn = await this.options.wearAgent(wear.name);
        if (worn === undefined) {
            this.events.emit({
                type: "agent_rejected",
                requestId: wear.requestId,
                reason: `No agent named ${wear.name}`,
            });
            return;
        }
        this.events.emit({
            type: "agent_worn",
            update: { requestId: wear.requestId, ...worn },
        });
    }

    private async listAgents(requestId: string): Promise<void> {
        if (this.options.listAgents === undefined) {
            this.events.emit({
                type: "agent_rejected",
                requestId,
                reason: "This host does not support agents.",
            });
            return;
        }
        this.events.emit({
            type: "agent_catalog",
            update: { requestId, ...(await this.options.listAgents()) },
        });
    }

    private async listSkills(requestId: string): Promise<void> {
        if (this.options.listSkills === undefined) {
            this.events.emit({
                type: "skill_catalog",
                requestId,
                skills: [],
                warnings: ["This host does not support skill commands."],
            });
            return;
        }
        try {
            const catalog = await this.options.listSkills();
            this.events.emit({
                type: "skill_catalog",
                requestId,
                skills: catalog.skills,
                warnings: catalog.warnings,
            });
        } catch {
            this.events.emit({
                type: "skill_catalog",
                requestId,
                skills: [],
                warnings: ["Skill commands are unavailable."],
            });
        }
    }

    private async resolveSkillInvocation(
        invocation: QueuedSkillInvocation["skillInvocation"],
        modelSettings: ModelTurnSettings | undefined,
    ): Promise<QueuedPrompt | undefined> {
        const { requestId, name, argumentsText } = invocation;
        const invoke = this.options.invokeSkill;
        if (invoke === undefined) {
            this.events.emit({
                type: "skill_invocation_rejected",
                requestId,
                name,
                reason: "This host does not support skill commands.",
            });
            return undefined;
        }
        let decision: Awaited<ReturnType<typeof invoke>>;
        try {
            decision = await invoke(name);
        } catch {
            this.events.emit({
                type: "skill_invocation_rejected",
                requestId,
                name,
                reason: `/${name} is unavailable.`,
            });
            return undefined;
        }
        if (!decision.allowed) {
            this.events.emit({
                type: "skill_invocation_rejected",
                requestId,
                name,
                reason: decision.reason,
            });
            return undefined;
        }
        const prompt = `/${name}${
            argumentsText.length === 0 ? "" : ` ${argumentsText}`
        }`;
        this.events.emit({
            type: "skill_invocation_accepted",
            requestId,
            name,
            prompt,
            // Validation happens only when this item is about to become the
            // active turn, after every earlier queue item has settled.
            queued: false,
        });
        return {
            prompt: {
                type: "prompt",
                content: prompt,
            },
            userInvokedSkill: name,
            ...(modelSettings === undefined
                ? {}
                : { modelSettings: copyModelSettings(modelSettings) }),
        };
    }

    private async updateAgentDefaultPair(
        requestId: string,
        name: string,
        pair: { readonly name: string; readonly effort?: string } | null,
    ): Promise<void> {
        if (this.options.updateAgentDefaultPair === undefined) {
            this.events.emit({
                type: "agent_rejected",
                requestId,
                reason: "This host does not support agents.",
            });
            return;
        }
        const failure = await this.options.updateAgentDefaultPair(name, pair);
        if (failure !== undefined) {
            this.events.emit({
                type: "agent_rejected",
                requestId,
                reason: failure,
            });
            return;
        }
        await this.listAgents(requestId);
    }

    private sendSessionModelSettingsHistory(requestId: string): void {
        this.events.emit({
            type: "session_model_settings_history",
            requestId,
            entries: this.options.readSessionModelSettingsHistory?.() ?? [],
        });
    }

    private async updateSessionPermissionMode(
        requestId: string,
        mode: ApprovalMode,
    ): Promise<void> {
        if (this.options.updateSessionPermissionMode === undefined) {
            this.events.emit({
                type: "permissions_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        let result: ApprovalMode | undefined;
        try {
            result = await this.options.updateSessionPermissionMode(mode);
        } catch {
            this.events.emit({
                type: "permissions_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        if (result === undefined) {
            this.events.emit({
                type: "permissions_rejected",
                requestId,
                reason: "invalid",
            });
            return;
        }
        this.sendPermissions(requestId);
    }

    private async poolAdd(
        requestId: string,
        entry: { readonly provider: string; readonly model: string },
        verify = false,
    ): Promise<void> {
        if (this.options.poolAdd === undefined) {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        const result = await this.options.poolAdd(entry, (step) => {
            this.events.emit({
                type: "pool_admission_progress",
                requestId,
                step: step.step,
                label: step.label,
                status: step.status,
                ...(step.detail === undefined ? {} : { detail: step.detail }),
            });
        }, { verify });
        this.events.emit({
            type: "pool_admission_result",
            requestId,
            provider: entry.provider,
            model: entry.model,
            verdict: result.verdict,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            ...(result.statusCode === undefined
                ? {}
                : { statusCode: result.statusCode }),
        });
        if (result.settings !== undefined) {
            this.events.emit({
                type: "model_settings_changed",
                requestId,
                settings: copyModelSettings(result.settings),
                pending: this.hasPendingTurn(),
            });
        }
    }

    private async poolRemove(
        requestId: string,
        entry: { readonly provider: string; readonly model: string },
    ): Promise<void> {
        const settings = await this.options.poolRemove?.(entry);
        if (settings === undefined) {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: this.options.poolRemove === undefined
                    ? "unavailable"
                    : "invalid",
            });
            return;
        }
        this.events.emit({
            type: "model_settings_changed",
            requestId,
            settings: copyModelSettings(settings),
            pending: this.hasPendingTurn(),
        });
    }

    private async refreshCatalog(
        requestId: string,
        provider: string,
    ): Promise<void> {
        let settings: ModelTurnSettings | undefined;
        try {
            settings = await this.options.refreshCatalog?.(provider);
        } catch {
            // Asking a provider is a network call, and one that throws is not
            // a reason to stop reading this session's commands.
            settings = undefined;
        }
        if (settings === undefined) {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: this.options.refreshCatalog === undefined
                    ? "unavailable"
                    : "invalid",
            });
            return;
        }
        this.events.emit({
            type: "model_settings_changed",
            requestId,
            settings: copyModelSettings(settings),
            pending: this.hasPendingTurn(),
        });
    }

    private async poolName(
        requestId: string,
        entry: { readonly provider: string; readonly model: string },
        name: string | null,
    ): Promise<void> {
        const settings = await this.options.poolName?.(entry, name);
        if (settings === undefined) {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: this.options.poolName === undefined
                    ? "unavailable"
                    : "invalid",
            });
            return;
        }
        this.events.emit({
            type: "model_settings_changed",
            requestId,
            settings: copyModelSettings(settings),
            pending: this.hasPendingTurn(),
        });
    }

    private async poolMove(
        requestId: string,
        entry: { readonly provider: string; readonly model: string },
        delta: number,
    ): Promise<void> {
        const settings = await this.options.poolMove?.(entry, delta);
        if (settings === undefined) {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: this.options.poolMove === undefined
                    ? "unavailable"
                    : "invalid",
            });
            return;
        }
        this.events.emit({
            type: "model_settings_changed",
            requestId,
            settings: copyModelSettings(settings),
            pending: this.hasPendingTurn(),
        });
    }

    private hasPendingTurn(): boolean {
        return this.activeTurn !== undefined || this.pendingPromptCount > 0;
    }

    private async oneshot(
        ownerId: string,
        command: OneshotCommand,
    ): Promise<void> {
        const run = this.options.oneshot;
        if (run === undefined) {
            this.options.sendOneshotReply?.(ownerId, {
                type: "oneshot_rejected",
                requestId: command.requestId,
                reason: "This session cannot run a oneshot model call.",
            });
            return;
        }
        try {
            const result = await run({
                model: command.model,
                messages: command.messages,
                ...(command.provider === undefined
                    ? {}
                    : { provider: command.provider }),
                ...(command.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: command.reasoningEffort }),
                ...(command.systemPrompt === undefined
                    ? {}
                    : { systemPrompt: command.systemPrompt }),
                ...(command.maxTokens === undefined
                    ? {}
                    : { maxTokens: command.maxTokens }),
            }, new AbortController().signal);
            this.options.sendOneshotReply?.(ownerId, {
                type: "oneshot_result",
                requestId: command.requestId,
                text: result.text,
                model: result.model,
                ...(result.provider === undefined
                    ? {}
                    : { provider: result.provider }),
            });
        } catch (error) {
            this.options.sendOneshotReply?.(ownerId, {
                type: "oneshot_rejected",
                requestId: command.requestId,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async updateSessionName(
        ownerId: string,
        requestId: string,
        requestedName: string | null,
    ): Promise<void> {
        const name = requestedName === null ? null : requestedName.trim();
        if (
            name !== null
            && (
                name.length === 0
                || name.includes("\0")
                || Buffer.byteLength(name, "utf8") > 200
            )
        ) {
            this.sendSessionNameReply(ownerId, {
                type: "session_name_rejected",
                requestId,
                reason: "invalid",
            });
            return;
        }
        let effective: string | null | undefined;
        try {
            effective = await this.options.updateSessionName?.(name);
        } catch {
            effective = undefined;
        }
        if (effective === undefined) {
            this.sendSessionNameReply(ownerId, {
                type: "session_name_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        this.sendSessionNameReply(ownerId, {
            type: "session_name",
            requestId,
            name: effective,
        });
    }

    private sendSessionNameReply(
        ownerId: string,
        reply: SessionNameReplyUpdate,
    ): void {
        this.options.sendSessionNameReply?.(ownerId, reply);
    }

    private sendPermissions(requestId: string): void {
        const mode = this.options.readApprovalMode?.();
        if (mode === undefined) {
            this.events.emit({
                type: "permissions_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        const inspection = this.options.readPermissionInspection?.();
        const origin = this.options.readApprovalModeOrigin?.();
        this.events.emit({
            type: "permissions_changed",
            requestId,
            mode,
            pending: this.hasPendingTurn(),
            ...(inspection === undefined ? {} : { inspection }),
            ...(origin === undefined ? {} : { origin }),
        });
    }

    private async updatePermissions(
        requestId: string,
        mode: ApprovalMode,
    ): Promise<void> {
        let effective: ApprovalMode | undefined;
        try {
            effective = await this.options.updateApprovalMode?.(mode);
        } catch {
            this.events.emit({
                type: "permissions_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        if (effective === undefined) {
            this.events.emit({
                type: "permissions_rejected",
                requestId,
                reason: this.options.updateApprovalMode === undefined
                    ? "unavailable"
                    : "invalid",
            });
            return;
        }
        const inspection = this.options.readPermissionInspection?.();
        this.events.emit({
            type: "permissions_changed",
            requestId,
            mode: effective,
            pending: this.hasPendingTurn(),
            ...(inspection === undefined ? {} : { inspection }),
        });
    }

    private async addPermissionPreference(
        requestId: string,
        when: PermissionPredicate,
    ): Promise<void> {
        let added: PermissionPreference | undefined;
        try {
            added = await this.options.addPermissionPreference?.(when);
        } catch {
            this.emitPermissionsRejected(requestId, "unavailable");
            return;
        }
        if (added === undefined) {
            this.emitPermissionsRejected(
                requestId,
                this.options.addPermissionPreference === undefined
                    ? "unavailable"
                    : "invalid",
            );
            return;
        }
        this.sendPermissions(requestId);
    }

    private async removePermissionGrant(
        requestId: string,
        id: string,
    ): Promise<void> {
        let removed: boolean;
        try {
            removed = await this.options.removePermissionGrant?.(id) ?? false;
        } catch {
            this.emitPermissionsRejected(requestId, "unavailable");
            return;
        }
        if (!removed) {
            // Same split as the preference path: an unknown or already revoked
            // ID is `invalid` because the surface exists, while a host with no
            // session log behind it is `unavailable`.
            this.emitPermissionsRejected(
                requestId,
                this.options.removePermissionGrant === undefined
                    ? "unavailable"
                    : "invalid",
            );
            return;
        }
        this.sendPermissions(requestId);
    }

    private async removePermissionPreference(
        requestId: string,
        id: string,
    ): Promise<void> {
        let removed: boolean;
        try {
            removed = await this.options.removePermissionPreference?.(id)
                ?? false;
        } catch {
            this.emitPermissionsRejected(requestId, "unavailable");
            return;
        }
        if (!removed) {
            // An unknown ID is `invalid` rather than `unavailable`: the surface
            // exists, the caller just named a preference that is not there.
            this.emitPermissionsRejected(
                requestId,
                this.options.removePermissionPreference === undefined
                    ? "unavailable"
                    : "invalid",
            );
            return;
        }
        this.sendPermissions(requestId);
    }

    private emitPermissionsRejected(
        requestId: string,
        reason: "invalid" | "unavailable",
    ): void {
        this.events.emit({ type: "permissions_rejected", requestId, reason });
    }

    private async receiveUiResponse(command: UiResponseCommand): Promise<void> {
        if (
            command.response.type === "tool_approval"
            && this.pendingApprovals.has(command.requestId)
        ) {
            const pending = this.pendingApprovals.get(command.requestId)!;
            const decision = command.response.decision;
            // Both remembering decisions need a predicate to remember and a
            // sink to put it in. With either missing the keypress is ignored
            // rather than downgraded to a plain allow, so the prompt stays up
            // and the user is never told a preference was saved when it was
            // not.
            if (
                (decision === "allow_similar" || decision === "allow_always")
                && (
                    pending.permissionGrants === undefined
                    || (decision === "allow_similar"
                        ? this.options.addPermissionGrants === undefined
                        : this.options.addPermissionPreference === undefined)
                )
            ) {
                return;
            }
            if (decision === "allow_similar") {
                try {
                    await this.options.addPermissionGrants!(
                        pending.permissionGrants!,
                    );
                } catch {
                    this.finishApproval(command.requestId, {
                        behavior: "deny",
                        reason: "The session permission grants could not be saved.",
                    });
                    return;
                }
            }
            if (decision === "allow_always") {
                try {
                    // One preference per proposal, reusing the predicate the
                    // session row would have stored, so the durable row
                    // silences exactly the prompts its neighbour would.
                    for (const proposal of pending.permissionGrants!) {
                        await this.options.addPermissionPreference!(
                            proposal.when,
                        );
                    }
                } catch {
                    this.finishApproval(command.requestId, {
                        behavior: "deny",
                        reason:
                            "The permission preference could not be saved.",
                    });
                    return;
                }
            }
            this.events.emit({
                type: "ui_response",
                requestId: command.requestId,
                response: command.response,
            });
            this.finishApproval(
                command.requestId,
                approvalResult(command.response),
            );
            if (decision === "allow_always") {
                // Unsolicited refresh, because the client's cached inspection
                // is now stale and it only fetches one at startup. Sent after
                // the approval closes, and carrying the approval's own request
                // ID rather than a fresh one, so the update is traceable to the
                // keypress that caused it instead of appearing out of nowhere.
                this.sendPermissions(command.requestId);
            }
            return;
        }
        if (command.response.type === "user_question") {
            this.receiveQuestionResponse(command.requestId, command.response);
            return;
        }
        if (command.response.type === "configuration_required") {
            this.receiveConfigurationRequiredResponse(
                command.requestId,
                command.response,
            );
        }
    }

    private finishApproval(
        requestId: string,
        result: ToolApprovalResult,
    ): void {
        const pending = this.pendingApprovals.get(requestId);
        if (pending === undefined) {
            return;
        }
        this.pendingApprovals.delete(requestId);
        clearTimeout(pending.timer);
        if (pending.signal !== undefined && pending.onAbort !== undefined) {
            pending.signal.removeEventListener("abort", pending.onAbort);
        }
        this.events.emit({ type: "ui_request_closed", requestId });
        pending.resolve(result);
    }

    private receiveQuestionResponse(
        requestId: string,
        response: UserQuestionUiResponse,
    ): void {
        const pending = this.pendingQuestions.get(requestId);
        if (pending === undefined) {
            return;
        }
        const result = questionResult(pending.request, response);
        if (result === undefined) {
            return;
        }
        this.events.emit({
            type: "ui_response",
            requestId,
            response,
        });
        this.finishQuestion(requestId, result);
    }

    private finishQuestion(
        requestId: string,
        result: UserQuestionResult,
    ): void {
        const pending = this.pendingQuestions.get(requestId);
        if (pending === undefined) {
            return;
        }
        this.pendingQuestions.delete(requestId);
        if (pending.signal !== undefined && pending.onAbort !== undefined) {
            pending.signal.removeEventListener("abort", pending.onAbort);
        }
        this.events.emit({ type: "ui_request_closed", requestId });
        pending.resolve(result);
    }

    private receiveConfigurationRequiredResponse(
        requestId: string,
        response: ConfigurationRequiredUiResponse,
    ): void {
        if (!this.pendingConfigurations.has(requestId)) return;
        this.events.emit({ type: "ui_response", requestId, response });
        this.finishConfigurationRequired(requestId, response.outcome);
    }

    private finishConfigurationRequired(
        requestId: string,
        result: ConfigurationRequiredResult,
    ): void {
        const pending = this.pendingConfigurations.get(requestId);
        if (pending === undefined) return;
        this.pendingConfigurations.delete(requestId);
        if (pending.signal !== undefined && pending.onAbort !== undefined) {
            pending.signal.removeEventListener("abort", pending.onAbort);
        }
        this.events.emit({ type: "ui_request_closed", requestId });
        pending.resolve(result);
    }
}

function copyModelSettings(settings: ModelTurnSettings): ModelTurnSettings {
    return {
        ...(settings.provider === undefined ? {} : { provider: settings.provider }),
        model: settings.model,
        ...(settings.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: settings.reasoningEffort }),
        ...(settings.requestedReasoningEffort === undefined
            ? {}
            : { requestedReasoningEffort: settings.requestedReasoningEffort }),
        ...(settings.contextWindow === undefined
            ? {}
            : { contextWindow: settings.contextWindow }),
        ...(settings.modelContextWindow === undefined
            ? {}
            : { modelContextWindow: settings.modelContextWindow }),
        ...(settings.contextLimit === undefined
            ? {}
            : { contextLimit: settings.contextLimit }),
        ...(settings.subagentDefault === undefined
            ? {}
            : { subagentDefault: { ...settings.subagentDefault } }),
        ...(settings.reviewerDefault === undefined ? {} : {
            reviewerDefault: {
                mode: settings.reviewerDefault.mode,
                ...(settings.reviewerDefault.primary === undefined
                    ? {}
                    : { primary: { ...settings.reviewerDefault.primary } }),
                ...(settings.reviewerDefault.fallback === undefined
                    ? {}
                    : { fallback: { ...settings.reviewerDefault.fallback } }),
            },
        }),
        ...(settings.availableReasoningEfforts === undefined
            ? {}
            : {
                availableReasoningEfforts: [
                    ...settings.availableReasoningEfforts,
                ],
            }),
        ...(settings.availableModels === undefined
            ? {}
            : {
                availableModels: settings.availableModels.map((model) => ({
                    ...model,
                    levels: model.levels.map((level) => ({ ...level })),
                })),
            }),
        ...(settings.refreshableProviders === undefined
            ? {}
            : { refreshableProviders: [...settings.refreshableProviders] }),
        ...(settings.pooled === undefined
            ? {}
            : {
                pooled: settings.pooled.map((model) => ({
                    ...model,
                    levels: model.levels.map((level) => ({ ...level })),
                })),
            }),
        ...(settings.webdevArenaSnapshot === undefined
            ? {}
            : { webdevArenaSnapshot: settings.webdevArenaSnapshot }),
    };
}

function approvalResult(
    response: ToolApprovalUiResponse,
): ToolApprovalResult {
    return response.decision === "allow_once"
        || response.decision === "allow_similar"
        || response.decision === "allow_always"
        ? { behavior: "allow" }
        : { behavior: "deny", reason: "Tool use was denied by the user." };
}

function copyPermissionGrantProposal(
    proposal: PermissionGrantProposal,
): PermissionGrantProposal {
    return {
        kind: proposal.kind,
        when: { ...proposal.when },
        scope: proposal.scope,
        lifetime: proposal.lifetime,
    };
}

function samePromptQueueState(
    left: PromptQueueState,
    right: PromptQueueState,
): boolean {
    return left.draining === right.draining
        && left.prompts.length === right.prompts.length
        && left.prompts.every((prompt, index) => {
            const other = right.prompts[index];
            return other !== undefined
                && prompt.content === other.content
                && prompt.state === other.state
                && (prompt.attachmentIds?.length ?? 0)
                    === (other.attachmentIds?.length ?? 0)
                && (prompt.attachmentIds ?? []).every(
                    (id, attachmentIndex) =>
                        id === other.attachmentIds?.[attachmentIndex],
                );
        });
}

function questionResult(
    request: UserQuestionUiRequest,
    response: UserQuestionUiResponse,
): UserQuestionResult | undefined {
    if (response.outcome === "cancelled") {
        return { outcome: "cancelled" };
    }
    if (response.outcome === "custom") {
        const text = response.text.trim();
        return text.length === 0 ? undefined : { outcome: "custom", text };
    }
    const choice = request.choices.find(
        (candidate) => candidate.id === response.choiceId,
    );
    if (choice === undefined) {
        return undefined;
    }
    const notes = response.notes?.trim();
    return {
        outcome: "selected",
        choice: { ...choice },
        ...(notes === undefined || notes.length === 0 ? {} : { notes }),
    };
}

function abortedDenial(): ToolApprovalDenied {
    return { behavior: "deny", reason: "Tool approval was cancelled." };
}

function noClientDenial(): ToolApprovalDenied {
    return {
        behavior: "deny",
        reason: "No client is available to approve this tool.",
    };
}

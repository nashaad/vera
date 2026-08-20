import { randomUUID } from "node:crypto";

import { AsyncQueue } from "./async-queue.ts";
import type {
    EngineEventBus,
    PoolAdmissionVerdict,
    ToolApprovalUiResponse,
    UserQuestionChoice,
    UserQuestionUiRequest,
    UserQuestionUiResponse,
} from "./events.ts";
import type {
    AgentUpdate,
    ConsultCommand,
    ConsultMessage,
    ConsultRejectedUpdate,
    ConsultResultUpdate,
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

export interface InboundTurn {
    readonly prompt: PromptCommand;
    readonly signal: AbortSignal;
    readonly modelSettings?: ModelTurnSettings;
    readonly triggeredByDelivery?: true;
}

interface QueuedTurnContext {
    readonly modelSettings?: ModelTurnSettings;
}

interface QueuedPrompt extends QueuedTurnContext {
    readonly prompt: PromptCommand;
    readonly triggeredByDelivery?: never;
    readonly wear?: never;
}

interface QueuedDeliveryTurn extends QueuedTurnContext {
    readonly prompt?: never;
    readonly triggeredByDelivery: true;
    readonly wear?: never;
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
}

type QueuedTurn = QueuedPrompt | QueuedDeliveryTurn | QueuedWear;

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
    readonly consult?: (
        request: {
            readonly provider?: string;
            readonly model: string;
            readonly reasoningEffort?: string;
            readonly systemPrompt?: string;
            readonly messages: readonly ConsultMessage[];
            readonly maxTokens?: number;
        },
        signal: AbortSignal,
    ) => Promise<{
        readonly text: string;
        readonly model: string;
        readonly provider?: string;
    }>;
    readonly sendConsultReply?: (
        ownerId: string,
        reply: ConsultResultUpdate | ConsultRejectedUpdate,
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
    readonly compactNow?: (turnActive: boolean) => Promise<void>;
    readonly handleTimelineCommand?: (
        ownerId: string,
        command: TimelineCommand,
    ) => Promise<void>;
    readonly detachTimelineOwner?: (ownerId: string) => void;
}

export class InboundCommandRouter {
    private readonly prompts = new AsyncQueue<QueuedTurn>();
    private readonly pendingApprovals = new Map<string, PendingApproval>();
    private readonly pendingQuestions = new Map<string, PendingQuestion>();
    private waitingForPrompt = false;
    private activeTurn: AbortController | undefined;
    private receiveFailed = false;
    private pendingPromptCount = 0;
    private deliveryTurnQueued = false;
    private contextAppend: Promise<void> | undefined;

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
        try {
            while (true) {
                queued = await this.prompts.receive();
                this.pendingPromptCount -= 1;
                if (queued.wear !== undefined) {
                    await this.applyWear(queued.wear);
                    continue;
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
            }
        } finally {
            this.waitingForPrompt = false;
        }
        const controller = new AbortController();
        this.activeTurn = controller;
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
            : { ...context, prompt: queued.prompt };
    }

    finishTurn(): void {
        if (this.activeTurn === undefined) {
            throw new Error("No turn is active");
        }
        this.activeTurn = undefined;
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
            || this.pendingQuestions.size > 0;
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
                if (command.type === "owned_consult_command") {
                    // Not awaited: a consult is a side call, and blocking the
                    // command loop on it would stall the user's own turn.
                    void this.consult(command.ownerId, command.command);
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
                    this.pendingPromptCount += 1;
                    this.prompts.push({
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
                    this.pendingPromptCount += 1;
                    this.prompts.push({
                        prompt: command,
                        ...(settings === undefined
                            ? {}
                            : { modelSettings: copyModelSettings(settings) }),
                    });
                    if (this.activeTurn !== undefined) {
                        this.events.emit({
                            type: "prompt_queued",
                            content: command.content,
                        });
                    }
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
                    this.pendingPromptCount += 1;
                    this.prompts.push({
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

                if (command.type === "consult") {
                    // Not awaited: a consult is a side call, and blocking the
                    // command loop on it would stall the user's own turn.
                    void this.consult("direct-client", command);
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
                    // Prompts only enter the queue through this loop, so the
                    // await below also keeps new ones out until it settles.
                    await this.options.compactNow?.(
                        this.activeTurn !== undefined
                            || this.pendingPromptCount > 0,
                    );
                    continue;
                }

                if (command.type === "abort" && this.activeTurn !== undefined) {
                    this.events.emit({ type: "abort_requested" });
                    this.activeTurn.abort(new Error("Turn aborted"));
                }
            }
        } catch (error) {
            this.receiveFailed = true;
            this.prompts.fail(error);
            for (const requestId of this.pendingApprovals.keys()) {
                this.finishApproval(requestId, noClientDenial());
            }
            for (const requestId of this.pendingQuestions.keys()) {
                this.finishQuestion(requestId, { outcome: "cancelled" });
            }
        }
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

    private async consult(
        ownerId: string,
        command: ConsultCommand,
    ): Promise<void> {
        const run = this.options.consult;
        if (run === undefined) {
            this.options.sendConsultReply?.(ownerId, {
                type: "consult_rejected",
                requestId: command.requestId,
                reason: "This session cannot consult another model.",
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
            this.options.sendConsultReply?.(ownerId, {
                type: "consult_result",
                requestId: command.requestId,
                text: result.text,
                model: result.model,
                ...(result.provider === undefined
                    ? {}
                    : { provider: result.provider }),
            });
        } catch (error) {
            this.options.sendConsultReply?.(ownerId, {
                type: "consult_rejected",
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
        ...(settings.pooled === undefined
            ? {}
            : {
                pooled: settings.pooled.map((model) => ({
                    ...model,
                    levels: model.levels.map((level) => ({ ...level })),
                })),
            }),
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

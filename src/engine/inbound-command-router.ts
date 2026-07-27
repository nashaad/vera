import { randomUUID } from "node:crypto";

import { AsyncQueue } from "./async-queue.ts";
import type {
    EngineEventBus,
    ToolApprovalUiResponse,
    UserQuestionChoice,
    UserQuestionUiRequest,
    UserQuestionUiResponse,
} from "./events.ts";
import type {
    AgentUpdate,
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

const FULL_USER_AUTHORITY_WARNING =
    "If allowed, this command and its child processes run with your full user permissions.";

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
    readonly approvalMode?: ApprovalMode;
    readonly triggeredByDelivery?: true;
}

interface QueuedTurnContext {
    readonly modelSettings?: ModelTurnSettings;
    readonly approvalMode?: ApprovalMode;
}

interface QueuedPrompt extends QueuedTurnContext {
    readonly prompt: PromptCommand;
    readonly triggeredByDelivery?: never;
}

interface QueuedDeliveryTurn extends QueuedTurnContext {
    readonly prompt?: never;
    readonly triggeredByDelivery: true;
}

type QueuedTurn = QueuedPrompt | QueuedDeliveryTurn;

export interface InboundCommandRouterOptions {
    readonly hasPendingDeliveryTurn?: () => boolean;
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly updateModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<ModelTurnSettings | undefined>;
    /**
     * Returns the settings snapshot as it stands after the edit, so the reply
     * carries the new pin list. `undefined` means the edit did not happen.
     */
    readonly updatePin?: (
        action: "add" | "remove",
        entry: { readonly provider: string; readonly model: string },
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
    readonly sendSessionNameReply?: (
        ownerId: string,
        reply: SessionNameReplyUpdate,
    ) => void;
    readonly addPermissionGrants?: (
        grants: readonly PermissionGrantProposal[],
    ) => Promise<void>;
    /** Resolves false when the ID names no live grant. */
    readonly removePermissionGrant?: (id: string) => Promise<boolean>;
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
            ...(queued.approvalMode === undefined
                ? {}
                : { approvalMode: queued.approvalMode }),
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
                warning: FULL_USER_AUTHORITY_WARNING,
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
                    if (this.deliveryTurnQueued) {
                        continue;
                    }
                    this.deliveryTurnQueued = true;
                    const settings = this.options.readModelSettings?.();
                    const approvalMode = this.options.readApprovalMode?.();
                    this.pendingPromptCount += 1;
                    this.prompts.push({
                        triggeredByDelivery: true,
                        ...(settings === undefined
                            ? {}
                            : { modelSettings: copyModelSettings(settings) }),
                        ...(approvalMode === undefined
                            ? {}
                            : { approvalMode }),
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
                    const settings = this.options.readModelSettings?.();
                    const approvalMode = this.options.readApprovalMode?.();
                    this.pendingPromptCount += 1;
                    this.prompts.push({
                        prompt: command,
                        ...(settings === undefined
                            ? {}
                            : { modelSettings: copyModelSettings(settings) }),
                        ...(approvalMode === undefined
                            ? {}
                            : { approvalMode }),
                    });
                    if (this.activeTurn !== undefined) {
                        this.events.emit({
                            type: "prompt_queued",
                            content: command.content,
                        });
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

                if (command.type === "update_pin") {
                    await this.updatePin(command.requestId, command.action, {
                        provider: command.provider,
                        model: command.model,
                    });
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

                if (command.type === "update_session_name") {
                    await this.updateSessionName(
                        "direct-client",
                        command.requestId,
                        command.name,
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
        const settings = await this.options.updateModelSettings?.(patch);
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
        });
    }

    private async updatePin(
        requestId: string,
        action: "add" | "remove",
        entry: { readonly provider: string; readonly model: string },
    ): Promise<void> {
        const settings = await this.options.updatePin?.(action, entry);
        if (settings === undefined) {
            this.events.emit({
                type: "model_settings_rejected",
                requestId,
                reason: this.options.updatePin === undefined
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
        this.events.emit({
            type: "permissions_changed",
            requestId,
            mode,
            pending: this.hasPendingTurn(),
            ...(inspection === undefined ? {} : { inspection }),
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
        ...(settings.contextWindow === undefined
            ? {}
            : { contextWindow: settings.contextWindow }),
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
        ...(settings.pinned === undefined
            ? {}
            : {
                pinned: settings.pinned.map((model) => ({
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
    return choice === undefined
        ? undefined
        : { outcome: "selected", choice: { ...choice } };
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

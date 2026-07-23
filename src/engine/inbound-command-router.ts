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
import type { ApprovalMode } from "./permissions.ts";
import type { CommandPrefix } from "./permissions.ts";

const FULL_USER_AUTHORITY_WARNING =
    "If allowed, this command and its child processes run with your full user permissions.";

export interface ToolApprovalOptions {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly commandPrefix?: CommandPrefix;
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
    readonly commandPrefix?: CommandPrefix;
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
}

interface QueuedPrompt {
    readonly prompt: PromptCommand;
    readonly modelSettings?: ModelTurnSettings;
    readonly approvalMode?: ApprovalMode;
}

export interface InboundCommandRouterOptions {
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly updateModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly readApprovalMode?: () => ApprovalMode;
    readonly updateApprovalMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    readonly updateSessionName?: (
        name: string | null,
    ) => Promise<string | null | undefined>;
    readonly addCommandPrefix?: (
        prefix: CommandPrefix,
    ) => Promise<void>;
    readonly handleTimelineCommand?: (
        ownerId: string,
        command: TimelineCommand,
    ) => Promise<void>;
    readonly detachTimelineOwner?: (ownerId: string) => void;
}

export class InboundCommandRouter {
    private readonly prompts = new AsyncQueue<QueuedPrompt>();
    private readonly pendingApprovals = new Map<string, PendingApproval>();
    private readonly pendingQuestions = new Map<string, PendingQuestion>();
    private waitingForPrompt = false;
    private activeTurn: AbortController | undefined;
    private receiveFailed = false;
    private pendingPromptCount = 0;

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
        let queued: QueuedPrompt;
        try {
            queued = await this.prompts.receive();
            this.pendingPromptCount -= 1;
        } finally {
            this.waitingForPrompt = false;
        }
        const controller = new AbortController();
        this.activeTurn = controller;
        return {
            prompt: queued.prompt,
            signal: controller.signal,
            ...(queued.modelSettings === undefined
                ? {}
                : { modelSettings: queued.modelSettings }),
            ...(queued.approvalMode === undefined
                ? {}
                : { approvalMode: queued.approvalMode }),
        };
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
                ...(options.commandPrefix === undefined
                    ? {}
                    : {
                        commandPrefix: {
                            tokens: [...options.commandPrefix.tokens],
                        },
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
                ...(options.commandPrefix === undefined
                    ? {}
                    : {
                        commandPrefix: {
                            tokens: [...options.commandPrefix.tokens],
                        },
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
                if (command.type === "timeline_owner_detached") {
                    this.options.detachTimelineOwner?.(command.ownerId);
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

                if (command.type === "get_permissions") {
                    this.sendPermissions(command.requestId);
                    continue;
                }

                if (command.type === "update_permissions") {
                    await this.updatePermissions(command.requestId, command.mode);
                    continue;
                }

                if (command.type === "update_session_name") {
                    await this.updateSessionName(command.requestId, command.name);
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

    private hasPendingTurn(): boolean {
        return this.activeTurn !== undefined || this.pendingPromptCount > 0;
    }

    private async updateSessionName(
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
            this.events.emit({
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
            this.events.emit({
                type: "session_name_rejected",
                requestId,
                reason: "unavailable",
            });
            return;
        }
        this.events.emit({
            type: "session_name_changed",
            requestId,
            name: effective,
        });
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
        this.events.emit({
            type: "permissions_changed",
            requestId,
            mode,
            pending: this.hasPendingTurn(),
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
        this.events.emit({
            type: "permissions_changed",
            requestId,
            mode: effective,
            pending: this.hasPendingTurn(),
        });
    }

    private async receiveUiResponse(command: UiResponseCommand): Promise<void> {
        if (
            command.response.type === "tool_approval"
            && this.pendingApprovals.has(command.requestId)
        ) {
            const pending = this.pendingApprovals.get(command.requestId)!;
            if (
                command.response.decision === "allow_prefix"
                && (
                    pending.commandPrefix === undefined
                    || this.options.addCommandPrefix === undefined
                )
            ) {
                return;
            }
            if (command.response.decision === "allow_prefix") {
                try {
                    await this.options.addCommandPrefix!(pending.commandPrefix!);
                } catch {
                    this.finishApproval(command.requestId, {
                        behavior: "deny",
                        reason: "The session command prefix could not be saved.",
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
                })),
            }),
    };
}

function approvalResult(
    response: ToolApprovalUiResponse,
): ToolApprovalResult {
    return response.decision === "allow_once"
        || response.decision === "allow_prefix"
        ? { behavior: "allow" }
        : { behavior: "deny", reason: "Tool use was denied by the user." };
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

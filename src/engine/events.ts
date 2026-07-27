import {
    appendFileSync,
    chmodSync,
    closeSync,
    fchmodSync,
    mkdirSync,
    openSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
    AssistantMessage,
    ModelMessage,
    ModelReasoningEffort,
    ModelStreamEvent,
    ModelTool,
    StreamErrorEvent,
    ToolCallContent,
    ToolResultMessage,
    ToolPresentation,
    UserMessage,
} from "../model/types.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import type { HookToolCall } from "../sdk/hooks.ts";
import type { ModelTurnSettings } from "./model-settings.ts";
import type {
    ApprovalMode,
    PermissionGrantProposal,
    PermissionInspection,
} from "./permissions.ts";
import type { ProjectInstructionMetadata } from "./project-instructions.ts";
import type { PromptContributionMetadata } from "./prompt-contributions.ts";
import type { PromptPrefixDrift } from "./prompt-prefix-drift.ts";
import type {
    ToolReviewRiskLevel,
    ToolReviewUserAuthorization,
} from "./reviewer.ts";

export interface TurnStartedEvent {
    readonly type: "turn_started";
    readonly message: UserMessage;
}

export interface PromptQueuedEvent {
    readonly type: "prompt_queued";
    readonly content: string;
}

export interface AbortRequestedEvent {
    readonly type: "abort_requested";
}

export interface TaskNotificationEvent {
    readonly type: "task_notification";
    readonly deliveryId: string;
    readonly sourceAgentId: string;
    readonly content: string;
}

export interface ToolApprovalUiRequest {
    readonly type: "tool_approval";
    readonly toolCall: HookToolCall;
    readonly reason: string;
    readonly warning: string;
    readonly permissionGrants?: readonly PermissionGrantProposal[];
}

export interface ToolApprovalUiResponse {
    readonly type: "tool_approval";
    readonly decision:
        | "allow_once"
        | "allow_similar"
        /** Same predicate as `allow_similar`, stored durably instead. */
        | "allow_always"
        | "deny";
}

export interface UserQuestionChoice {
    readonly id: string;
    readonly label: string;
}

export interface UserQuestionUiRequest {
    readonly type: "user_question";
    readonly question: string;
    readonly choices: readonly UserQuestionChoice[];
}

export interface UserQuestionSelectedUiResponse {
    readonly type: "user_question";
    readonly outcome: "selected";
    readonly choiceId: string;
}

export interface UserQuestionCancelledUiResponse {
    readonly type: "user_question";
    readonly outcome: "cancelled";
}

export interface UserQuestionCustomUiResponse {
    readonly type: "user_question";
    readonly outcome: "custom";
    readonly text: string;
}

export type UserQuestionUiResponse =
    | UserQuestionSelectedUiResponse
    | UserQuestionCustomUiResponse
    | UserQuestionCancelledUiResponse;

export type UiRequest = ToolApprovalUiRequest | UserQuestionUiRequest;
export type UiResponse = ToolApprovalUiResponse | UserQuestionUiResponse;

export interface UiRequestEvent {
    readonly type: "ui_request";
    readonly requestId: string;
    readonly request: UiRequest;
}

export interface UiResponseEvent {
    readonly type: "ui_response";
    readonly requestId: string;
    readonly response: UiResponse;
}

export interface UiRequestClosedEvent {
    readonly type: "ui_request_closed";
    readonly requestId: string;
}

export interface ModelSettingsChangedEvent {
    readonly type: "model_settings_changed";
    readonly requestId: string;
    readonly settings: ModelTurnSettings;
    readonly pending: boolean;
}

export interface ModelSettingsRejectedEvent {
    readonly type: "model_settings_rejected";
    readonly requestId: string;
    readonly reason: "invalid" | "unavailable";
}

export interface PermissionsChangedEvent {
    readonly type: "permissions_changed";
    readonly requestId: string;
    readonly mode: ApprovalMode;
    readonly pending: boolean;
    readonly inspection?: PermissionInspection;
}

export interface PermissionsRejectedEvent {
    readonly type: "permissions_rejected";
    readonly requestId: string;
    readonly reason: "invalid" | "unavailable";
}

export interface ModelRequestEvent {
    readonly type: "model_request";
    readonly model: string;
    readonly maxTokens: number;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly systemPrompt: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ModelTool[];
    readonly projectInstructions?: ProjectInstructionMetadata;
    readonly promptContributions: readonly PromptContributionMetadata[];
}

export interface PromptPrefixDriftEvent {
    readonly type: "prompt_prefix_drift";
    readonly cause: PromptPrefixDrift["cause"];
    readonly changes: PromptPrefixDrift["changes"];
}

export interface ModelRetryScheduledEvent {
    readonly type: "model_retry_scheduled";
    readonly model: string;
    readonly nextAttempt: number;
    readonly delayMs: number;
    readonly failure: ProviderFailure;
}

export interface ModelFallbackSelectedEvent {
    readonly type: "model_fallback_selected";
    readonly fromModel: string;
    readonly toModel: string;
    readonly afterFailures: number;
    readonly failure: ProviderFailure;
}

export interface ModelLengthContinuationEvent {
    readonly type: "model_length_continuation";
    readonly model: string;
    readonly previousMaxTokens: number;
    readonly nextMaxTokens: number;
    readonly continuation: number;
    readonly maxContinuations: number;
}

export type ObservableModelStreamEvent = Exclude<
    ModelStreamEvent,
    StreamErrorEvent
>;

export interface ModelStreamObservedEvent {
    readonly type: "model_stream";
    readonly event: ObservableModelStreamEvent;
}

export interface ModelStreamErrorEvent {
    readonly type: "model_stream_error";
    readonly error: string;
    readonly message: AssistantMessage;
}

export interface ToolExecutionStartedEvent {
    readonly type: "tool_execution_started";
    readonly toolCall: ToolCallContent;
}

export interface ToolInputChangedEvent {
    readonly type: "tool_input_changed";
    readonly original: HookToolCall;
    readonly effective: HookToolCall;
}

export interface ToolExecutionReplacedEvent {
    readonly type: "tool_execution_replaced";
    readonly toolCall: HookToolCall;
    readonly result: ToolResultMessage;
}

export interface ToolHookFailedEvent {
    readonly type: "tool_hook_failed";
    readonly phase: "pre_tool_use" | "post_tool_use";
    readonly toolCall: HookToolCall;
    readonly error: string;
}

export interface ToolResultChangedEvent {
    readonly type: "tool_result_changed";
    readonly original: ToolResultMessage;
    readonly effective: ToolResultMessage;
}

export interface ToolReviewDecidedEvent {
    readonly type: "tool_review_decided";
    readonly toolCall: HookToolCall;
    readonly decision: "allow" | "deny" | "unavailable";
    readonly reason: string;
    /**
     * The reviewer's own scoring. Carried so a surprising decision can be
     * attributed to how the reviewer read the action rather than guessed at.
     */
    readonly riskLevel: ToolReviewRiskLevel;
    readonly userAuthorization: ToolReviewUserAuthorization;
}

export interface ToolExecutionFinishedEvent {
    readonly type: "tool_execution_finished";
    readonly toolCall: ToolCallContent;
    readonly result: ToolResultMessage;
    readonly durationMs: number;
}

export interface ToolPresentationReadyEvent {
    readonly type: "tool_presentation_ready";
    readonly tool: string;
    readonly presentation: ToolPresentation;
}

export interface TurnFinishedEvent {
    readonly type: "turn_finished";
    readonly message: AssistantMessage;
}

export type EngineEvent =
    | TurnStartedEvent
    | PromptQueuedEvent
    | AbortRequestedEvent
    | TaskNotificationEvent
    | UiRequestEvent
    | UiResponseEvent
    | UiRequestClosedEvent
    | ModelSettingsChangedEvent
    | ModelSettingsRejectedEvent
    | PermissionsChangedEvent
    | PermissionsRejectedEvent
    | ModelRequestEvent
    | PromptPrefixDriftEvent
    | ModelRetryScheduledEvent
    | ModelFallbackSelectedEvent
    | ModelLengthContinuationEvent
    | ModelStreamObservedEvent
    | ModelStreamErrorEvent
    | ToolInputChangedEvent
    | ToolExecutionReplacedEvent
    | ToolHookFailedEvent
    | ToolResultChangedEvent
    | ToolExecutionStartedEvent
    | ToolReviewDecidedEvent
    | ToolExecutionFinishedEvent
    | ToolPresentationReadyEvent
    | TurnFinishedEvent;

export type EngineEventSubscriber = (
    event: EngineEvent,
) => void;

export class EngineEventBus {
    private readonly subscribers = new Set<EngineEventSubscriber>();

    subscribe(subscriber: EngineEventSubscriber): () => void {
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }

    emit(event: EngineEvent): void {
        // Subscribers are synchronous so every observer sees the same order.
        for (const subscriber of this.subscribers) {
            try {
                subscriber(event);
            } catch {
                // Observation must never change the turn outcome.
            }
        }
    }
}

export interface JsonlEventLoggerOptions {
    readonly path: string;
    readonly sessionId: string;
    readonly now?: () => Date;
}

export function defaultEventLogPath(sessionId: string): string {
    return join(homedir(), ".vera", "logs", `${sessionId}.jsonl`);
}

export function createJsonlEventLogger(
    options: JsonlEventLoggerOptions,
): EngineEventSubscriber {
    const now = options.now ?? (() => new Date());
    let logPrepared = false;

    return (event): void => {
        if (!logPrepared) {
            prepareEventLog(options.path);
            logPrepared = true;
        }

        appendFileSync(
            options.path,
            `${JSON.stringify({
                timestamp: now().toISOString(),
                level: event.type === "model_stream_error"
                    ? "error"
                    : event.type === "prompt_prefix_drift"
                        ? "warn"
                        : "debug",
                sessionId: options.sessionId,
                ...event,
            })}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
    };
}

function prepareEventLog(path: string): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);

    const file = openSync(path, "a", 0o600);
    try {
        fchmodSync(file, 0o600);
    } finally {
        closeSync(file);
    }
}

import {
    appendFileSync,
    chmodSync,
    closeSync,
    fchmodSync,
    mkdirSync,
    openSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { workspaceKey } from "../workspace-key.ts";
import type { ContextMeasurement } from "./context-measurement.ts";
import type { ToolResultTruncation } from "../tools/tool-result-limit.ts";
import type {
    AssistantMessage,
    ModelMessage,
    ModelReasoningEffort,
    ModelStreamEvent,
    ModelSubstitution,
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
import type { SessionSettingOrigin } from "../store/session-store.ts";
import type { SettingsDestination } from "./settings-destination.ts";
import type { PromptQueueState } from "./prompt-queue.ts";
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
import { veraRuntimeDirectory } from "../profile-paths.ts";

export interface TurnStartedEvent {
    readonly type: "turn_started";
    readonly message: UserMessage;
}

export interface DeliveryTurnStartedEvent {
    readonly type: "delivery_turn_started";
}

export interface PromptQueuedEvent {
    readonly type: "prompt_queued";
    readonly content: string;
}

export interface PromptQueueChangedEvent {
    readonly type: "prompt_queue_changed";
    readonly queue: PromptQueueState;
}

export interface AbortRequestedEvent {
    readonly type: "abort_requested";
}

export interface TaskNotificationEvent {
    readonly type: "task_notification";
    readonly deliveryId: string;
    readonly sourceAgentId: string;
    readonly content: string;
    readonly kind?: "attention" | "completion" | "peer";
}

export interface NoticeEvent {
    readonly type: "notice";
    readonly key: string;
    readonly count: number;
}

export interface ToolApprovalUiRequest {
    readonly type: "tool_approval";
    readonly toolCall: HookToolCall;
    readonly reason: string;
    readonly warning: string;
    readonly sourceAgentId?: string;
    readonly sourceTask?: string;
    readonly permissionGrants?: readonly PermissionGrantProposal[];
}

export interface ToolApprovalUiResponse {
    readonly type: "tool_approval";
    readonly decision:
        | "allow_once"
        | "allow_similar"
        | "allow_always"
        | "deny";
}

export interface UserQuestionChoice {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly preview?: string;
    readonly recommended?: true;
}

export interface UserQuestionUiRequest {
    readonly type: "user_question";
    readonly question: string;
    readonly choices: readonly UserQuestionChoice[];
    readonly outOfBand?: true;
}

export interface UserQuestionSelectedUiResponse {
    readonly type: "user_question";
    readonly outcome: "selected";
    readonly choiceId: string;
    readonly notes?: string;
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

export interface ConfigurationRequiredUiRequest {
    readonly type: "configuration_required";
    readonly destination: SettingsDestination;
    readonly reason: string;
    readonly pendingAction: {
        readonly id: string;
        readonly kind: "subagent_launch";
        readonly count: number;
    };
}

export interface ConfigurationRequiredUiResponse {
    readonly type: "configuration_required";
    readonly outcome: "configured" | "cancelled" | "unavailable";
}

export type UiRequest =
    | ToolApprovalUiRequest
    | UserQuestionUiRequest
    | ConfigurationRequiredUiRequest;
export type UiResponse =
    | ToolApprovalUiResponse
    | UserQuestionUiResponse
    | ConfigurationRequiredUiResponse;

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
    readonly updatedDefaults?: true;
    readonly updatedSession?: true;
    readonly origin?: SessionSettingOrigin;
}

export interface SessionModelSettingsHistoryEvent {
    readonly type: "session_model_settings_history";
    readonly requestId: string;
    readonly entries: readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: SessionSettingOrigin;
        readonly timestamp: string;
    }[];
}

export interface ModelSettingsRejectedEvent {
    readonly type: "model_settings_rejected";
    readonly requestId: string;
    readonly reason: "invalid" | "unavailable";
}

export interface PoolAdmissionProgressEvent {
    readonly type: "pool_admission_progress";
    readonly requestId: string;
    readonly step: string;
    readonly label: string;
    readonly status: "running" | "passed" | "failed" | "skipped";
    readonly detail?: string;
}

export type PoolAdmissionVerdict =
    | "added"
    | "incompatible"
    | "unavailable"
    | "pool_write_refused";

export interface PoolAdmissionResultEvent {
    readonly type: "pool_admission_result";
    readonly requestId: string;
    readonly provider: string;
    readonly model: string;
    readonly verdict: PoolAdmissionVerdict;
    readonly reason?: string;
    readonly statusCode?: number;
}

export interface PermissionsChangedEvent {
    readonly type: "permissions_changed";
    readonly requestId: string;
    readonly mode: ApprovalMode;
    readonly pending: boolean;
    readonly inspection?: PermissionInspection;
    readonly origin?: SessionSettingOrigin;
    readonly warning?: string;
}

export type ToolDenialClass =
    | "agent-scope"
    | "permission-mode"
    | "reviewer"
    | "denial-breaker";

export interface ToolDeniedEvent {
    readonly type: "tool_denied";
    readonly toolCall: HookToolCall;
    readonly denialClass: ToolDenialClass;
    readonly reason: string;
}

export interface ToolBreakerTrippedEvent {
    readonly type: "tool_breaker_tripped";
    readonly tool: string;
    readonly denials: number;
    readonly action: "withheld" | "ended-turn";
}

export interface AgentSelectedEvent {
    readonly type: "agent_selected";
    readonly update: {
        readonly requestId: string;
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly notice?: string;
    };
}

export interface AgentCatalogEvent {
    readonly type: "agent_catalog";
    readonly update: {
        readonly requestId: string;
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
    };
}

export interface AgentRejectedEvent {
    readonly type: "agent_rejected";
    readonly requestId: string;
    readonly reason: string;
}

export interface SkillCatalogEvent {
    readonly type: "skill_catalog";
    readonly requestId: string;
    readonly skills: readonly {
        readonly name: string;
        readonly description: string;
        readonly disableModelInvocation: boolean;
    }[];
    readonly warnings: readonly string[];
}

export interface SkillInvocationAcceptedEvent {
    readonly type: "skill_invocation_accepted";
    readonly requestId: string;
    readonly name: string;
    readonly prompt: string;
    readonly queued: boolean;
}

export interface SkillInvocationRejectedEvent {
    readonly type: "skill_invocation_rejected";
    readonly requestId: string;
    readonly name: string;
    readonly reason: string;
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
    readonly toolResultBytes: number;
}

export interface ContextMeasuredEvent {
    readonly type: "context_measured";
    readonly model: string;
    readonly measurement: ContextMeasurement;
}

export interface CompactionStartedEvent {
    readonly type: "compaction_started";
    readonly strategy: string;
    readonly provider?: string;
    readonly model?: string;
    readonly warning?: string;
}

export interface CompactionFinishedEvent {
    readonly type: "compaction_finished";
    readonly strategy: string;
    readonly provider?: string;
    readonly model?: string;
    readonly outcome:
        | "compacted"
        | "not_needed"
        | "no_boundary"
        | "rejected"
        | "unavailable"
        | "cancelled"
        | "busy";
    readonly stoppedWithTurn?: boolean;
    readonly reason?: string;
    readonly before?: number;
    readonly after?: number;
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
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly failure: ProviderFailure;
    readonly replacesPartialAttempt?: true;
}

export interface ModelFallbackSelectedEvent {
    readonly type: "model_fallback_selected";
    readonly fromModel: string;
    readonly toModel: string;
    readonly afterFailures: number;
    readonly failure: ProviderFailure;
}

export interface ModelEffortCoarsenedEvent {
    readonly type: "model_effort_coarsened";
    readonly model: string;
    readonly requested: string;
    readonly using?: string;
    readonly reason: string;
}

export interface ModelSubstitutedEvent {
    readonly type: "model_substituted";
    readonly substitution: ModelSubstitution;
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
    readonly errorName: string;
    readonly stack?: string;
    readonly cause?: ModelStreamErrorCause;
    readonly failure?: ProviderFailure;
    readonly message: AssistantMessage;
}

export interface ModelStreamErrorCause {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
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

export interface TurnHookFailedEvent {
    readonly type: "turn_hook_failed";
    readonly phase: "pre_turn";
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
    readonly riskLevel: ToolReviewRiskLevel;
    readonly userAuthorization: ToolReviewUserAuthorization;
}

export interface ToolExecutionFinishedEvent {
    readonly type: "tool_execution_finished";
    readonly toolCall: ToolCallContent;
    readonly result: ToolResultMessage;
    readonly durationMs: number;
    readonly truncation?: ToolResultTruncation;
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
    | DeliveryTurnStartedEvent
    | PromptQueuedEvent
    | PromptQueueChangedEvent
    | AbortRequestedEvent
    | TaskNotificationEvent
    | NoticeEvent
    | UiRequestEvent
    | UiResponseEvent
    | UiRequestClosedEvent
    | ModelSettingsChangedEvent
    | SessionModelSettingsHistoryEvent
    | ToolDeniedEvent
    | ToolBreakerTrippedEvent
    | AgentSelectedEvent
    | AgentCatalogEvent
    | AgentRejectedEvent
    | SkillCatalogEvent
    | SkillInvocationAcceptedEvent
    | SkillInvocationRejectedEvent
    | ModelSettingsRejectedEvent
    | PoolAdmissionProgressEvent
    | PoolAdmissionResultEvent
    | PermissionsChangedEvent
    | PermissionsRejectedEvent
    | ModelRequestEvent
    | ContextMeasuredEvent
    | CompactionStartedEvent
    | CompactionFinishedEvent
    | PromptPrefixDriftEvent
    | ModelRetryScheduledEvent
    | ModelFallbackSelectedEvent
    | ModelEffortCoarsenedEvent
    | ModelSubstitutedEvent
    | ModelLengthContinuationEvent
    | ModelStreamObservedEvent
    | ModelStreamErrorEvent
    | ToolInputChangedEvent
    | ToolExecutionReplacedEvent
    | ToolHookFailedEvent
    | TurnHookFailedEvent
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
        for (const subscriber of this.subscribers) {
            try {
                subscriber(event);
            } catch {
            }
        }
    }
}

export interface JsonlEventLoggerOptions {
    readonly path: string;
    readonly sessionId: string;
    readonly now?: () => Date;
    readonly level?: EventLogLevel;
}

export function eventLogRoot(): string {
    return join(veraRuntimeDirectory(), "logs");
}

export function defaultEventLogPath(
    sessionId: string,
    cwd: string,
    root: string = eventLogRoot(),
): string {
    return join(root, workspaceKey(cwd), `${sessionId}.jsonl`);
}

export function legacyEventLogPath(
    sessionId: string,
    root: string = eventLogRoot(),
): string {
    return join(root, `${sessionId}.jsonl`);
}

export function modelRequestSnapshotPath(logPath: string): string {
    return logPath.endsWith(".jsonl")
        ? `${logPath.slice(0, -".jsonl".length)}.model-request.json`
        : `${logPath}.model-request.json`;
}

export type EventLogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<EventLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const EVENT_LEVELS: Record<EngineEvent["type"], EventLogLevel> = {
    abort_requested: "info",
    agent_catalog: "debug",
    agent_rejected: "error",
    agent_selected: "info",
    compaction_finished: "info",
    compaction_started: "info",
    context_measured: "debug",
    delivery_turn_started: "info",
    model_effort_coarsened: "warn",
    model_fallback_selected: "warn",
    model_length_continuation: "warn",
    model_request: "info",
    model_retry_scheduled: "warn",
    model_settings_changed: "info",
    model_settings_rejected: "error",
    model_stream: "debug",
    model_stream_error: "error",
    model_substituted: "warn",
    notice: "info",
    permissions_changed: "info",
    permissions_rejected: "error",
    pool_admission_progress: "debug",
    pool_admission_result: "info",
    prompt_prefix_drift: "warn",
    prompt_queue_changed: "debug",
    prompt_queued: "info",
    session_model_settings_history: "debug",
    skill_catalog: "debug",
    skill_invocation_accepted: "info",
    skill_invocation_rejected: "warn",
    task_notification: "info",
    tool_breaker_tripped: "warn",
    tool_denied: "warn",
    tool_execution_finished: "info",
    tool_execution_replaced: "info",
    tool_execution_started: "info",
    tool_hook_failed: "error",
    tool_input_changed: "debug",
    tool_presentation_ready: "debug",
    tool_result_changed: "debug",
    tool_review_decided: "info",
    turn_finished: "info",
    turn_hook_failed: "error",
    turn_started: "info",
    ui_request: "info",
    ui_request_closed: "info",
    ui_response: "info",
};

export function eventLogLevel(type: EngineEvent["type"]): EventLogLevel {
    return EVENT_LEVELS[type];
}

export function resolveEventLogLevel(
    env: Record<string, string | undefined> = process.env,
): EventLogLevel {
    const raw = env.VERA_LOG_LEVEL?.trim().toLowerCase();
    return raw !== undefined && raw in LEVEL_RANK
        ? raw as EventLogLevel
        : "info";
}

export interface JsonlEventLogger extends EngineEventSubscriber {
    flush(): void;
    close(): void;
}

const liveLoggers = new Set<() => void>();
let exitHandlerInstalled = false;

function drainOnExit(drain: () => void): void {
    liveLoggers.add(drain);
    if (exitHandlerInstalled) {
        return;
    }
    exitHandlerInstalled = true;
    process.on("exit", () => {
        for (const pending of liveLoggers) {
            pending();
        }
    });
}

export function createJsonlEventLogger(
    options: JsonlEventLoggerOptions,
): JsonlEventLogger {
    const now = options.now ?? (() => new Date());
    const threshold = LEVEL_RANK[options.level ?? resolveEventLogLevel()];
    let logPrepared = false;
    let pending: string[] = [];
    let scheduled: ReturnType<typeof setTimeout> | undefined;

    const drain = (quiet: boolean): void => {
        if (scheduled !== undefined) {
            clearTimeout(scheduled);
            scheduled = undefined;
        }
        if (pending.length === 0) {
            return;
        }
        const batch = pending.join("");
        pending = [];
        try {
            appendFileSync(options.path, batch, {
                encoding: "utf8",
                mode: 0o600,
            });
        } catch (error) {
            if (!quiet) {
                throw error;
            }
        }
    };

    const quietDrain = (): void => drain(true);

    const write = (event: EngineEvent): void => {
        const level = eventLogLevel(event.type);
        const timestamp = now().toISOString();

        if (event.type === "model_request") {
            if (!logPrepared) {
                prepareEventLog(options.path);
                logPrepared = true;
                drainOnExit(quietDrain);
            }
            writeModelRequestSnapshot(options.path, {
                timestamp,
                sessionId: options.sessionId,
                ...event,
            });
        }

        if (LEVEL_RANK[level] < threshold) {
            return;
        }

        if (!logPrepared) {
            prepareEventLog(options.path);
            logPrepared = true;
            drainOnExit(quietDrain);
        }

        pending.push(`${JSON.stringify({
            timestamp,
            level,
            sessionId: options.sessionId,
            ...(event.type === "model_request"
                ? summarizeModelRequest(event)
                : event),
        })}\n`);

        if (
            LEVEL_RANK[level] >= LEVEL_RANK.warn
            || event.type === "turn_finished"
        ) {
            drain(true);
            return;
        }
        if (scheduled === undefined) {
            const timer = setTimeout(quietDrain, 0);
            timer.unref?.();
            scheduled = timer;
        }
    };

    const logger: JsonlEventLogger = Object.assign(write, {
        flush: (): void => drain(false),
        close: (): void => {
            liveLoggers.delete(quietDrain);
            drain(true);
        },
    });
    return logger;
}

function summarizeModelRequest(
    event: ModelRequestEvent,
): Record<string, unknown> {
    const {
        systemPrompt,
        messages,
        tools,
        ...rest
    } = event;
    return {
        ...rest,
        systemPromptBytes: Buffer.byteLength(systemPrompt),
        messageCount: messages.length,
        toolNames: tools.map((tool) => tool.name),
    };
}

function writeModelRequestSnapshot(logPath: string, request: object): void {
    const path = modelRequestSnapshotPath(logPath);
    const pending = `${path}.pending`;
    writeFileSync(pending, `${JSON.stringify(request)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    renameSync(pending, path);
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

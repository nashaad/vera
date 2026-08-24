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
        /** Same predicate as `allow_similar`, stored durably instead. */
        | "allow_always"
        | "deny";
}

export interface UserQuestionChoice {
    readonly id: string;
    readonly label: string;
    /** One line under the label saying what picking this means. */
    readonly description?: string;
    /** Shown verbatim in a monospace box beside the choices. */
    readonly preview?: string;
}

export interface UserQuestionUiRequest {
    readonly type: "user_question";
    readonly question: string;
    readonly choices: readonly UserQuestionChoice[];
    /** A host question that does not block an in-flight or idle model turn. */
    readonly outOfBand?: true;
}

export interface UserQuestionSelectedUiResponse {
    readonly type: "user_question";
    readonly outcome: "selected";
    readonly choiceId: string;
    /** What the user typed alongside the choice, when they typed anything. */
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
    /** The human decision or resource a client should expose. */
    readonly destination: SettingsDestination;
    readonly reason: string;
    /** One coalesced workflow, which may stand for several waiting launches. */
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
    /** Present only when this edit also became the new-session default. */
    readonly updatedDefaults?: true;
    /** Present when the edit changed this session alone. Never with the above. */
    readonly updatedSession?: true;
    /** Where the session's setting now says it came from. */
    readonly origin?: SessionSettingOrigin;
}

/**
 * The session's model settings over time, in reply to a read.
 *
 * The dial strip's recents come from here. Derived rather than remembered:
 * there is no client-side list that could disagree with the session file.
 */
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

/**
 * `pool_write_refused` is the local half: the model was fine and the file the
 * entry would land in was not, which is a different thing to tell the user
 * than a provider that would not answer.
 */
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
    /** Where the session's posture came from, when the host has said. */
    readonly origin?: SessionSettingOrigin;
}

/**
 * A tool call the harness refused, and which rule refused it.
 *
 * The class is the point: an agent's nudge fires on the refusals the agent
 * could plausibly explain, and stays quiet on the ones somebody else already
 * explained. Without a class every denial would look the same from here.
 */
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

/**
 * The consecutive-denial breaker acted on a tool.
 *
 * Recorded so the reason a turn stopped offering a tool, or stopped entirely,
 * is recoverable from the event log after the fact and not only from the
 * transcript in the moment.
 */
export interface ToolBreakerTrippedEvent {
    readonly type: "tool_breaker_tripped";
    readonly tool: string;
    readonly denials: number;
    readonly action: "withheld" | "ended-turn";
}

/** The agent now in force, in the shape the wire update carries. */
export interface AgentWornEvent {
    readonly type: "agent_worn";
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
    };
}

export interface AgentRejectedEvent {
    readonly type: "agent_rejected";
    readonly requestId: string;
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
    /**
     * How much of this request is tool results. Recorded per request because
     * the share, not the total, is what says whether old results are worth
     * replacing with references to them.
     */
    readonly toolResultBytes: number;
}

/**
 * Emitted beside every `model_request`, carrying the size of that exact
 * request. The engine measures because only the engine holds the projection;
 * a client counting what it can see on screen would miss the system prompt,
 * the tool definitions and every internal message, and two clients watching
 * one session would disagree.
 */
export interface ContextMeasuredEvent {
    readonly type: "context_measured";
    /** The model the request was measured against, which a fallback changes. */
    readonly model: string;
    readonly measurement: ContextMeasurement;
}

export interface CompactionStartedEvent {
    readonly type: "compaction_started";
    readonly strategy: string;
    /** The first model in the bound summarizer route, when known. */
    readonly provider?: string;
    readonly model?: string;
    /** A configuration mismatch that makes this compaction wasteful. */
    readonly warning?: string;
}

/**
 * Compaction is its own accepted operation with a visible end, so every way it
 * can finish is reported, not only the one that worked. `outcome` carries the
 * failure kinds because a session that quietly declined to compact and a
 * session whose summarizer was unreachable look identical otherwise.
 */
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
    /**
     * A cancellation the compaction caught rather than was given: the turn it
     * was running inside was stopped, and that turn is still unwinding. A
     * client showing the user's stop keeps showing it until the turn reports.
     */
    readonly stoppedWithTurn?: boolean;
    readonly reason?: string;
    /** Estimated request size before and after, present only on success. */
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
}

export interface ModelFallbackSelectedEvent {
    readonly type: "model_fallback_selected";
    readonly fromModel: string;
    readonly toModel: string;
    readonly afterFailures: number;
    readonly failure: ProviderFailure;
}

/**
 * A reasoning effort that was asked for and not sent, plus the level that went
 * in its place. Covers a provider refusal answered by coarsening, a level the
 * pool already knows is unsupported, and a level the adapter could not place
 * against the model's own list. `using` is absent when no level was sent.
 */
export interface ModelEffortCoarsenedEvent {
    readonly type: "model_effort_coarsened";
    readonly model: string;
    readonly requested: string;
    readonly using?: string;
    readonly reason: string;
}

/**
 * A tool ran its work on a model other than the one it was asked to use.
 * Separate from the coarsening and fallback events because the turn's own
 * model did not change: the substitution happened inside a spawn, so it has
 * no message to ride on and reaches a client only as this event.
 */
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
    /**
     * Present when the result did not fit the model-visible ceiling. Original
     * versus retained bytes is what says whether the ceiling is costing the
     * session anything, which is the measurement the next stage of this work
     * is gated on.
     */
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
    | AgentWornEvent
    | AgentCatalogEvent
    | AgentRejectedEvent
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
    /** Defaults to the level the process is running with. */
    readonly level?: EventLogLevel;
}

/** The root every event log lives under, unless a caller names another. */
export function eventLogRoot(): string {
    return join(veraRuntimeDirectory(), "logs");
}

/**
 * Where a session's log lives when nobody names a path.
 *
 * Sharded by workspace so the directory stays readable: one flat directory
 * held 1754 files and told you nothing about which project produced them.
 */
export function defaultEventLogPath(
    sessionId: string,
    cwd: string,
    root: string = eventLogRoot(),
): string {
    return join(root, workspaceKey(cwd), `${sessionId}.jsonl`);
}

/**
 * Where sessions logged before the layout was sharded. Read-only: nothing
 * writes here any more, and the files are left in place rather than migrated,
 * because migrating means guessing each old session's workspace.
 */
export function legacyEventLogPath(
    sessionId: string,
    root: string = eventLogRoot(),
): string {
    return join(root, `${sessionId}.jsonl`);
}

/**
 * Where the most recent model request for a log is kept in full.
 *
 * A request carries the whole conversation, so appending each one to the log
 * writes the transcript again per turn and grows the file with the square of
 * the session length. One session reached 147MB that way. Only the latest
 * request is ever read back, so it is held in a slot the next request
 * overwrites and the log keeps a summary line in its place.
 */
export function modelRequestSnapshotPath(logPath: string): string {
    return logPath.endsWith(".jsonl")
        ? `${logPath.slice(0, -".jsonl".length)}.model-request.json`
        : `${logPath}.model-request.json`;
}

/**
 * How loud an event is. The log keeps every event at or above the level the
 * process is running with.
 */
export type EventLogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<EventLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

/**
 * The level each event is recorded at.
 *
 * Keyed by the whole event union, so a new event type fails the build until
 * it is placed here. Two questions decide a placement: would a reader
 * reconstructing the turn miss this line, and how many does one turn produce.
 * `model_stream` is one per chunk, which is what makes `debug` too loud to be
 * the default.
 */
const EVENT_LEVELS: Record<EngineEvent["type"], EventLogLevel> = {
    abort_requested: "info",
    agent_catalog: "debug",
    agent_rejected: "error",
    agent_worn: "info",
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
    prompt_queued: "info",
    session_model_settings_history: "debug",
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
    turn_started: "info",
    ui_request: "info",
    ui_request_closed: "info",
    ui_response: "info",
};

export function eventLogLevel(type: EngineEvent["type"]): EventLogLevel {
    return EVENT_LEVELS[type];
}

/**
 * The level the log runs at. `info` unless asked otherwise, so a session
 * records the shape of its turns rather than every token of them, and
 * `VERA_LOG_LEVEL=debug` brings the whole stream back while a bug is being
 * watched. An unreadable value falls back instead of throwing: losing the
 * session to a typo in a log setting is worse than logging the wrong amount.
 */
export function resolveEventLogLevel(
    env: Record<string, string | undefined> = process.env,
): EventLogLevel {
    const raw = env.VERA_LOG_LEVEL?.trim().toLowerCase();
    return raw !== undefined && raw in LEVEL_RANK
        ? raw as EventLogLevel
        : "info";
}

/**
 * A subscriber that also lets its owner force the queued lines out. `flush`
 * is for a caller about to read the file; `close` drops the exit handler that
 * guarantees the tail.
 */
export interface JsonlEventLogger extends EngineEventSubscriber {
    flush(): void;
    close(): void;
}

/**
 * The loggers with lines queued. One process handler drains all of them, so a
 * host that opens a logger per session does not accumulate exit listeners.
 */
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
        // Cleared before the write, so a write that throws drops the batch
        // rather than replaying it onto the next flush.
        pending = [];
        try {
            appendFileSync(options.path, batch, {
                encoding: "utf8",
                mode: 0o600,
            });
        } catch (error) {
            // A timed or at-exit drain has no caller to answer to, and
            // observation must never change the turn outcome. An asked-for
            // flush does have one, and it is about to read the file.
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
            // Ahead of the level check, and written straight through. The
            // slot is a reader's only copy of the latest request, so it is
            // kept at every level and survives a process that dies before the
            // queue drains.
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

        // A turn's worth of lines lands in one append. The exceptions go now:
        // a failure is what someone tails the file for, and the end of a turn
        // is the point a reader expects the file to be whole.
        if (
            LEVEL_RANK[level] >= LEVEL_RANK.warn
            || event.type === "turn_finished"
        ) {
            drain(true);
            return;
        }
        if (scheduled === undefined) {
            const timer = setTimeout(quietDrain, 0);
            // Never the reason a process stays alive.
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

/**
 * The log's stand-in for a request. It keeps the fields that describe the
 * request and replaces the three that carry its bulk with their sizes, so the
 * timeline still says what was sent and how big it was. Tool names stay whole:
 * which tools a request exposed is a fact readers ask for, and the schemas are
 * what made the list large.
 */
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
    // Written beside the slot and renamed over it, so a reader never sees a
    // request half replaced by the next one.
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

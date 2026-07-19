import type {
    EngineEventSubscriber,
    ToolApprovalUiRequest,
    ToolApprovalUiResponse,
} from "./events.ts";
import type {
    ModelMessage,
    ModelReasoningEffort,
} from "../model/types.ts";
import type {
    ModelSettingsPatch,
    ModelTurnSettings,
} from "./model-settings.ts";
import { isApprovalMode, type ApprovalMode } from "./permissions.ts";

export type AgentStatus = "idle" | "working" | "waiting";

export interface UserTranscriptEntry {
    readonly kind: "user";
    readonly text: string;
}

export interface AssistantTranscriptEntry {
    readonly kind: "assistant";
    readonly text: string;
}

export interface ToolTranscriptEntry {
    readonly kind: "tool";
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
}

export type TranscriptEntry =
    | UserTranscriptEntry
    | AssistantTranscriptEntry
    | ToolTranscriptEntry;

export interface PromptCommand {
    readonly type: "prompt";
    readonly content: string;
}

export interface AbortCommand {
    readonly type: "abort";
}

export interface UiResponseCommand {
    readonly type: "ui_response";
    readonly requestId: string;
    readonly response: ToolApprovalUiResponse;
}

export interface GetModelSettingsCommand {
    readonly type: "get_model_settings";
    readonly requestId: string;
}

export interface UpdateModelSettingsCommand {
    readonly type: "update_model_settings";
    readonly requestId: string;
    readonly patch: ModelSettingsPatch;
}

export interface GetPermissionsCommand {
    readonly type: "get_permissions";
    readonly requestId: string;
}

export interface UpdatePermissionsCommand {
    readonly type: "update_permissions";
    readonly requestId: string;
    readonly mode: ApprovalMode;
}

export type ClientCommand =
    | PromptCommand
    | AbortCommand
    | UiResponseCommand
    | GetModelSettingsCommand
    | UpdateModelSettingsCommand
    | GetPermissionsCommand
    | UpdatePermissionsCommand;

export interface HistoryUpdate {
    readonly type: "history";
    readonly entries: readonly TranscriptEntry[];
    readonly seq: number;
}

export interface UserPromptUpdate {
    readonly type: "user_prompt";
    readonly content: string;
    readonly seq: number;
}

export interface AssistantDeltaUpdate {
    readonly type: "assistant_delta";
    readonly text: string;
    readonly seq: number;
}

export interface ToolStartedUpdate {
    readonly type: "tool_started";
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly seq: number;
}

export interface ToolFinishedUpdate {
    readonly type: "tool_finished";
    readonly tool: string;
    readonly seq: number;
}

export interface TurnFinishedUpdate {
    readonly type: "turn_finished";
    readonly seq: number;
}

export interface StatusUpdate {
    readonly type: "status";
    readonly state: AgentStatus;
    readonly seq: number;
}

export interface TaskNotificationUpdate {
    readonly type: "task_notification";
    readonly deliveryId: string;
    readonly sourceAgentId: string;
    readonly content: string;
    readonly seq: number;
}

export interface UiRequestUpdate {
    readonly type: "ui_request";
    readonly requestId: string;
    readonly request: ToolApprovalUiRequest;
    readonly seq: number;
}

export interface UiRequestClosedUpdate {
    readonly type: "ui_request_closed";
    readonly requestId: string;
    readonly seq: number;
}

export interface ModelSettingsUpdate {
    readonly type: "model_settings";
    readonly requestId: string;
    readonly settings: ModelTurnSettings;
    readonly pending: boolean;
    readonly seq: number;
}

export interface ModelSettingsRejectedUpdate {
    readonly type: "model_settings_rejected";
    readonly requestId: string;
    readonly reason: "invalid" | "unavailable";
    readonly seq: number;
}

export interface PermissionsUpdate {
    readonly type: "permissions";
    readonly requestId: string;
    readonly mode: ApprovalMode;
    readonly pending: boolean;
    readonly seq: number;
}

export interface PermissionsRejectedUpdate {
    readonly type: "permissions_rejected";
    readonly requestId: string;
    readonly reason: "invalid" | "unavailable";
    readonly seq: number;
}

export type AgentUpdate =
    | HistoryUpdate
    | UserPromptUpdate
    | AssistantDeltaUpdate
    | ToolStartedUpdate
    | ToolFinishedUpdate
    | TurnFinishedUpdate
    | StatusUpdate
    | TaskNotificationUpdate
    | UiRequestUpdate
    | UiRequestClosedUpdate
    | ModelSettingsUpdate
    | ModelSettingsRejectedUpdate
    | PermissionsUpdate
    | PermissionsRejectedUpdate;

export interface AgentUpdateSender {
    send(update: AgentUpdate): void;
}

export interface ProtocolEncoder extends EngineEventSubscriber {
    checkpoint(messages: readonly ModelMessage[]): void;
}

export function parseClientCommand(value: unknown): ClientCommand | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const command = value as Record<string, unknown>;
    if (command.type === "prompt" && typeof command.content === "string") {
        return { type: "prompt", content: command.content };
    }
    if (command.type === "abort") {
        return { type: "abort" };
    }
    if (
        command.type === "ui_response"
        && typeof command.requestId === "string"
        && typeof command.response === "object"
        && command.response !== null
    ) {
        const response = command.response as Record<string, unknown>;
        if (
            response.type === "tool_approval"
            && (response.decision === "allow" || response.decision === "deny")
        ) {
            return {
                type: "ui_response",
                requestId: command.requestId,
                response: {
                    type: "tool_approval",
                    decision: response.decision,
                },
            };
        }
    }
    if (
        command.type === "get_model_settings"
        && isRequestId(command.requestId)
    ) {
        return {
            type: "get_model_settings",
            requestId: command.requestId,
        };
    }
    if (
        command.type === "update_model_settings"
        && isRequestId(command.requestId)
    ) {
        const patch = parseModelSettingsPatch(command.patch);
        if (patch !== undefined) {
            return {
                type: "update_model_settings",
                requestId: command.requestId,
                patch,
            };
        }
    }
    if (command.type === "get_permissions" && isRequestId(command.requestId)) {
        return {
            type: "get_permissions",
            requestId: command.requestId,
        };
    }
    if (
        command.type === "update_permissions"
        && isRequestId(command.requestId)
        && isApprovalMode(command.mode)
    ) {
        return {
            type: "update_permissions",
            requestId: command.requestId,
            mode: command.mode,
        };
    }
    return undefined;
}

function parseModelSettingsPatch(
    value: unknown,
): ModelSettingsPatch | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const source = value as Record<string, unknown>;
    const hasModel = Object.hasOwn(source, "model");
    const hasReasoningEffort = Object.hasOwn(source, "reasoningEffort");
    if (
        (!hasModel && !hasReasoningEffort)
        || (hasModel
            && (typeof source.model !== "string"
                || source.model.trim().length === 0))
        || (hasReasoningEffort
            && source.reasoningEffort !== null
            && !isModelReasoningEffort(source.reasoningEffort))
    ) {
        return undefined;
    }
    const model = hasModel ? source.model as string : undefined;
    const reasoningEffort = hasReasoningEffort
        ? source.reasoningEffort as ModelReasoningEffort | null
        : undefined;
    return {
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
}

function isRequestId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isModelReasoningEffort(
    value: unknown,
): value is ModelReasoningEffort {
    return value === "off"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "max";
}

export function createProtocolEncoder(
    sender: AgentUpdateSender,
): ProtocolEncoder {
    let seq = 0;

    const encode = (event: Parameters<EngineEventSubscriber>[0]): void => {
        if (event.type === "turn_started") {
            seq += 1;
            sender.send({
                type: "user_prompt",
                content: textContent(event.message.content),
                seq,
            });
            return;
        }
        if (event.type === "task_notification") {
            seq += 1;
            sender.send({
                type: "task_notification",
                deliveryId: event.deliveryId,
                sourceAgentId: event.sourceAgentId,
                content: event.content,
                seq,
            });
            return;
        }
        if (
            event.type === "model_stream"
            && event.event.type === "text_delta"
        ) {
            seq += 1;
            sender.send({
                type: "assistant_delta",
                text: event.event.text,
                seq,
            });
            return;
        }

        if (event.type === "tool_execution_started") {
            seq += 1;
            sender.send({
                type: "tool_started",
                tool: event.toolCall.name,
                args: event.toolCall.input,
                seq,
            });
            return;
        }

        if (event.type === "tool_execution_finished") {
            seq += 1;
            sender.send({
                type: "tool_finished",
                tool: event.toolCall.name,
                seq,
            });
            return;
        }

        if (event.type === "ui_request") {
            seq += 1;
            sender.send({
                type: "ui_request",
                requestId: event.requestId,
                request: event.request,
                seq,
            });
            return;
        }

        if (event.type === "ui_request_closed") {
            seq += 1;
            sender.send({
                type: "ui_request_closed",
                requestId: event.requestId,
                seq,
            });
            return;
        }

        if (event.type === "model_settings_changed") {
            seq += 1;
            sender.send({
                type: "model_settings",
                requestId: event.requestId,
                settings: event.settings,
                pending: event.pending,
                seq,
            });
            return;
        }

        if (event.type === "model_settings_rejected") {
            seq += 1;
            sender.send({
                type: "model_settings_rejected",
                requestId: event.requestId,
                reason: event.reason,
                seq,
            });
            return;
        }

        if (event.type === "permissions_changed") {
            seq += 1;
            sender.send({
                type: "permissions",
                requestId: event.requestId,
                mode: event.mode,
                pending: event.pending,
                seq,
            });
            return;
        }

        if (event.type === "permissions_rejected") {
            seq += 1;
            sender.send({
                type: "permissions_rejected",
                requestId: event.requestId,
                reason: event.reason,
                seq,
            });
            return;
        }

        if (event.type === "turn_finished") {
            seq += 1;
            sender.send({ type: "turn_finished", seq });
        }
    };

    return Object.assign(encode, {
        checkpoint(messages: readonly ModelMessage[]): void {
            sender.send({
                type: "history",
                entries: projectTranscript(messages),
                seq,
            });
        },
    });
}

export function projectTranscript(
    messages: readonly ModelMessage[],
): readonly TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];

    for (const message of messages) {
        if (message.role === "user") {
            if (message.internal === true) {
                continue;
            }
            entries.push({
                kind: "user",
                text: textContent(message.content),
            });
            continue;
        }
        if (message.role === "tool_result") {
            continue;
        }
        for (const content of message.content) {
            if (content.type === "text") {
                entries.push({ kind: "assistant", text: content.text });
            }
            if (content.type === "tool_call") {
                entries.push({
                    kind: "tool",
                    tool: content.name,
                    args: structuredClone(content.input),
                });
            }
        }
    }

    return entries;
}

function textContent(
    content: readonly { readonly text: string }[],
): string {
    return content.map((part) => part.text).join("\n");
}

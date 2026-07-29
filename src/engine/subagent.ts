import { randomUUID } from "node:crypto";

import type {
    AssistantMessage,
    ModelAdapter,
    ModelReasoningEffort,
} from "../model/types.ts";
import {
    defaultSessionPath,
    SessionStore,
} from "../store/session-store.ts";
import { EngineEventBus } from "./events.ts";
import { ToolHooks } from "./hooks.ts";
import { InboundCommandRouter } from "./inbound-command-router.ts";
import {
    createInProcessChannel,
    type InProcessChannel,
} from "./message-channel.ts";
import type { ApprovalMode } from "./permissions.ts";
import { sessionAttachmentName } from "../attachments/service.ts";
import {
    createProtocolEncoder,
    isToolApprovalUiRequestUpdate,
    type ToolApprovalUiRequestUpdate,
} from "./protocol.ts";
import { PromptPrefixTracker } from "./prompt-prefix-drift.ts";
import type { ModelFallbackPolicy } from "./recovery.ts";
import { runTurn, type RunTurnState } from "./run-turn.ts";
import { ToolRuntime } from "../tools/runtime.ts";
import type { ApplyToolEffect, RegisteredTool } from "../tools/types.ts";
import {
    DEFAULT_MAX_CONCURRENT_CHILD_AGENTS,
    validChildAgentLimit,
} from "./agent-limits.ts";

export interface CreateSubagentEffectApplierOptions {
    readonly adapter: ModelAdapter;
    readonly workspace: string;
    /** Shared with children: one session, one scratch space. */
    readonly scratchDir?: string;
    readonly disabledPromptContributions?: readonly string[];
    readonly modelFallback?: ModelFallbackPolicy;
    readonly sessionPathForId?: (sessionId: string) => string;
    readonly relayToolApproval?: ChildToolApprovalRelay;
    readonly maxConcurrentChildren?: number;
    readonly extensionTools?: readonly RegisteredTool[];
}

export interface RunSubagentOptions {
    readonly adapter: ModelAdapter;
    readonly provider?: string;
    readonly model: string;
    readonly description: string;
    readonly workspace: string;
    readonly scratchDir?: string;
    readonly disabledPromptContributions?: readonly string[];
    readonly approvalMode: ApprovalMode;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly sessionId?: string;
    readonly sessionPath?: string;
    readonly signal?: AbortSignal;
    readonly relayToolApproval?: ChildToolApprovalRelay;
    readonly extensionTools?: readonly RegisteredTool[];
}

export type ChildToolApprovalRelay = (
    update: ToolApprovalUiRequestUpdate,
    sourceAgentId: string,
    sourceTask: string,
    signal: AbortSignal,
) => Promise<"allow_once" | "deny">;

export interface SubagentResult {
    readonly text: string;
    readonly isError: boolean;
    readonly sessionId: string;
    readonly sessionPath: string;
}

export function createSubagentEffectApplier(
    options: CreateSubagentEffectApplierOptions,
): ApplyToolEffect {
    const maxConcurrentChildren = validChildAgentLimit(
        options.maxConcurrentChildren ?? DEFAULT_MAX_CONCURRENT_CHILD_AGENTS,
    );
    let activeChildren = 0;
    return async (effect, signal, context) => {
        if (effect.type !== "spawn_subagent") {
            throw new Error(`Unsupported subagent effect: ${effect.type}`);
        }
        if (activeChildren >= maxConcurrentChildren) {
            return {
                kind: "output",
                output:
                    `Subagent limit reached (${maxConcurrentChildren} running).`,
                isError: true,
            };
        }
        activeChildren += 1;
        const sessionId = randomUUID();
        // An override rides the parent's provider; the parent's effort is not
        // carried onto a different model, where it may not be supported.
        const model = effect.model ?? context.model;
        const reasoningEffort = effect.reasoningEffort
            ?? (effect.model === undefined ? context.reasoningEffort : undefined);
        try {
            const result = await runSubagent({
                adapter: options.adapter,
                ...(context.provider === undefined
                    ? {}
                    : { provider: context.provider }),
                model,
                description: effect.description,
                workspace: options.workspace,
                ...(options.scratchDir === undefined
                    ? {}
                    : { scratchDir: options.scratchDir }),
                ...(options.disabledPromptContributions === undefined ? {} : {
                    disabledPromptContributions:
                        options.disabledPromptContributions,
                }),
                approvalMode: context.approvalMode,
                extensionTools: options.extensionTools,
                signal,
                sessionId,
                ...(options.relayToolApproval === undefined
                    ? {}
                    : { relayToolApproval: options.relayToolApproval }),
                ...(reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort }),
                ...(options.modelFallback === undefined
                    ? {}
                    : { modelFallback: options.modelFallback }),
                ...(options.sessionPathForId === undefined
                    ? {}
                    : { sessionPath: options.sessionPathForId(sessionId) }),
            });
            return {
                kind: "output",
                output: result.text,
                isError: result.isError,
            };
        } finally {
            activeChildren -= 1;
        }
    };
}

export async function runSubagent(
    options: RunSubagentOptions,
): Promise<SubagentResult> {
    const channel = createInProcessChannel();
    const childSignal = options.signal ?? new AbortController().signal;
    const onAbort = (): void => channel.client.send({ type: "abort" });
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
        options.signal?.throwIfAborted();
        const sessionId = options.sessionId ?? randomUUID();
        const store = await SessionStore.create(
            options.sessionPath ?? defaultSessionPath(sessionId),
            { sessionId, cwd: options.workspace },
        );
        options.signal?.throwIfAborted();
        await store.appendApprovalMode(options.approvalMode);
        options.signal?.throwIfAborted();
        const events = new EngineEventBus();
        const protocol = createProtocolEncoder(
            channel.engine,
            sessionAttachmentName(store),
        );
        events.subscribe(protocol);
        const state: RunTurnState = {
            messages: [],
            store,
            toolRuntime: new ToolRuntime(options.workspace),
            inbound: new InboundCommandRouter(channel.engine, events),
            events,
            hooks: new ToolHooks(),
            approvalMode: options.approvalMode,
            extensionTools: options.extensionTools,
            promptPrefixTracker: new PromptPrefixTracker(),
            ...(options.scratchDir === undefined
                ? {}
                : { scratchDir: options.scratchDir }),
            ...(options.disabledPromptContributions === undefined ? {} : {
                disabledPromptContributions:
                    options.disabledPromptContributions,
            }),
            ...(options.modelFallback === undefined
                ? {}
                : { modelFallback: options.modelFallback }),
        };
        protocol.checkpoint(state.messages);
        channel.client.send({
            type: "prompt",
            content: options.description,
        });
        const updates = drainChildUpdates(
            channel.client,
            sessionId,
            options.description,
            childSignal,
            options.relayToolApproval,
        );
        const finalMessage = await runTurn(
            options.adapter,
            options.model,
            {
                ...state,
                readModelSettings: () => ({
                    ...(options.provider === undefined ? {} : { provider: options.provider }),
                    model: options.model,
                    ...(options.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: options.reasoningEffort }),
                }),
            },
            options.reasoningEffort,
        );
        await updates;
        options.signal?.throwIfAborted();
        return {
            text: finalText(finalMessage),
            isError: finalMessage.stopReason !== "stop",
            sessionId,
            sessionPath: store.path,
        };
    } finally {
        options.signal?.removeEventListener("abort", onAbort);
    }
}

async function drainChildUpdates(
    client: InProcessChannel["client"],
    sourceAgentId: string,
    sourceTask: string,
    signal: AbortSignal,
    relayToolApproval?: ChildToolApprovalRelay,
): Promise<void> {
    while (true) {
        const update = await client.receive();
        if (update.type === "ui_request") {
            const decision = isToolApprovalUiRequestUpdate(update)
                && relayToolApproval !== undefined
                ? await relayToolApproval(
                    update,
                    sourceAgentId,
                    sourceTask,
                    signal,
                )
                : "deny";
            client.send({
                type: "ui_response",
                requestId: update.requestId,
                response: update.request.type === "tool_approval"
                    ? { type: "tool_approval", decision }
                    : { type: "user_question", outcome: "cancelled" },
            });
        }
        if (update.type === "turn_finished") {
            return;
        }
    }
}

function finalText(message: AssistantMessage): string {
    const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    if (message.stopReason === "stop") {
        return text || "Subagent finished without a text summary.";
    }
    const error = message.errorMessage?.trim() ?? "";
    return [text, error].filter((value) => value.length > 0).join("\n")
        || `Subagent stopped with ${message.stopReason}.`;
}

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
import { newStashingToolRuntime } from "./preimage.ts";
import type {
    ApplyToolEffect,
    RegisteredTool,
    ToolEffectContext,
} from "../tools/types.ts";
import type { PooledModel } from "../model/catalog-view.ts";
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
    /** Makes the spawn tools' model override resolvable; absent, it is refused. */
    readonly readPool?: () => readonly PooledModel[];
    /** What a spawn with no model override runs on; absent, the parent model. */
    readonly subagentModel?: SpawnModelDefault;
}

export interface SpawnModelDefault {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export type SpawnModelResolution =
    | {
        readonly ok: true;
        readonly provider?: string;
        readonly model: string;
        readonly reasoningEffort?: ModelReasoningEffort;
        /** A transcript line about a request that fell through the pool. */
        readonly notice?: string;
    }
    | { readonly ok: false; readonly error: string };

/**
 * Turns a spawn tool's optional model override into runnable settings.
 *
 * An override must name a pooled model: the pool is the complete runtime set,
 * it carries its own provider, and it is short enough to hand back whole. A
 * request for an unpooled model is not an error: it falls through to what the
 * child would have run anyway, with one notice saying how to allow it. With
 * no override the child runs the configured subagent default when there is
 * one, and the parent's settings otherwise: inheriting silently multiplies
 * whatever the parent costs across the whole fan-out.
 */
export function resolveSpawnModelChoice(
    effect: { readonly model?: string; readonly reasoningEffort?: string },
    context: ToolEffectContext,
    readPool?: () => readonly PooledModel[],
    subagentModel?: SpawnModelDefault,
): SpawnModelResolution {
    const inherit = (notice?: string): SpawnModelResolution => {
        const inherited: SpawnModelDefault = subagentModel ?? {
            ...(context.provider === undefined
                ? {}
                : { provider: context.provider }),
            model: context.model,
            ...(context.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: context.reasoningEffort }),
        };
        const reasoningEffort = notice === undefined
            ? effect.reasoningEffort ?? inherited.reasoningEffort
            : inherited.reasoningEffort;
        return {
            ok: true,
            ...(inherited.provider === undefined
                ? {}
                : { provider: inherited.provider }),
            model: inherited.model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            ...(notice === undefined ? {} : { notice }),
        };
    };
    if (effect.model === undefined) {
        return inherit();
    }
    const pool = readPool?.() ?? [];
    const matches = pool.filter((candidate) =>
        `${candidate.provider}/${candidate.model}` === effect.model
        || candidate.model === effect.model);
    const entry = matches.length === 1
        ? matches[0]
        : matches.find((candidate) =>
            `${candidate.provider}/${candidate.model}` === effect.model);
    if (entry === undefined || entry.status !== "ready") {
        return inherit(
            `Requested model "${effect.model}" is not in the pool; `
                + "the subagent inherits its default model instead. "
                + "Add the model to the pool to allow this.",
        );
    }
    if (!entry.available) {
        return {
            ok: false,
            error: `Pooled model "${entry.model}" is not available right now.`,
        };
    }
    if (effect.reasoningEffort !== undefined) {
        const levels = entry.levels.map((level) => level.id);
        if (!levels.includes(effect.reasoningEffort)) {
            return {
                ok: false,
                error: levels.length === 0
                    ? `Model "${entry.model}" has no reasoning control; omit reasoning_effort.`
                    : `Model "${entry.model}" does not support reasoning_effort "${effect.reasoningEffort}". Available: ${levels.join(", ")}.`,
            };
        }
    }
    return {
        ok: true,
        provider: entry.provider,
        model: entry.model,
        ...(effect.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: effect.reasoningEffort }),
    };
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
        const resolved = resolveSpawnModelChoice(
            effect,
            context,
            options.readPool,
            options.subagentModel,
        );
        if (!resolved.ok) {
            return { kind: "output", output: resolved.error, isError: true };
        }
        const notice = resolved.notice;
        activeChildren += 1;
        const sessionId = randomUUID();
        try {
            const result = await runSubagent({
                adapter: options.adapter,
                ...(resolved.provider === undefined
                    ? {}
                    : { provider: resolved.provider }),
                model: resolved.model,
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
                ...(resolved.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: resolved.reasoningEffort }),
                ...(options.modelFallback === undefined
                    ? {}
                    : { modelFallback: options.modelFallback }),
                ...(options.sessionPathForId === undefined
                    ? {}
                    : { sessionPath: options.sessionPathForId(sessionId) }),
            });
            return {
                kind: "output",
                output: notice === undefined
                    ? result.text
                    : `${notice}\n\n${result.text}`,
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
            toolRuntime: newStashingToolRuntime(options.workspace, sessionId),
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

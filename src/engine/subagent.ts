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
import { createProtocolEncoder } from "./protocol.ts";
import type { ModelFallbackPolicy } from "./recovery.ts";
import { runTurn, type RunTurnState } from "./run-turn.ts";
import { ToolRuntime } from "../tools/runtime.ts";
import type { ApplyToolEffect } from "../tools/types.ts";

export interface CreateSubagentEffectApplierOptions {
    readonly adapter: ModelAdapter;
    readonly model: string;
    readonly workspace: string;
    readonly approvalMode: ApprovalMode;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly sessionPathForId?: (sessionId: string) => string;
}

export interface RunSubagentOptions {
    readonly adapter: ModelAdapter;
    readonly model: string;
    readonly description: string;
    readonly workspace: string;
    readonly approvalMode: ApprovalMode;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly sessionId?: string;
    readonly sessionPath?: string;
    readonly signal?: AbortSignal;
}

export interface SubagentResult {
    readonly text: string;
    readonly sessionId: string;
    readonly sessionPath: string;
}

export function createSubagentEffectApplier(
    options: CreateSubagentEffectApplierOptions,
): ApplyToolEffect {
    return async (effect, signal) => {
        if (effect.type !== "spawn_subagent") {
            throw new Error(`Unsupported subagent effect: ${effect.type}`);
        }
        const sessionId = randomUUID();
        const result = await runSubagent({
            adapter: options.adapter,
            model: options.model,
            description: effect.description,
            workspace: options.workspace,
            approvalMode: options.approvalMode,
            signal,
            sessionId,
            ...(options.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: options.reasoningEffort }),
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
            isError: false,
        };
    };
}

export async function runSubagent(
    options: RunSubagentOptions,
): Promise<SubagentResult> {
    options.signal?.throwIfAborted();
    const sessionId = options.sessionId ?? randomUUID();
    const store = await SessionStore.create(
        options.sessionPath ?? defaultSessionPath(sessionId),
        { sessionId, cwd: options.workspace },
    );
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const protocol = createProtocolEncoder(channel.engine);
    events.subscribe(protocol);
    const state: RunTurnState = {
        messages: [],
        store,
        toolRuntime: new ToolRuntime(options.workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: options.approvalMode,
        ...(options.modelFallback === undefined
            ? {}
            : { modelFallback: options.modelFallback }),
    };
    protocol.checkpoint(state.messages);

    channel.client.send({
        type: "prompt",
        content: options.description,
    });
    const onAbort = (): void => channel.client.send({ type: "abort" });
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
        const updates = drainChildUpdates(channel.client);
        const finalMessage = await runTurn(
            options.adapter,
            options.model,
            state,
            options.reasoningEffort,
        );
        await updates;
        options.signal?.throwIfAborted();
        return {
            text: finalText(finalMessage),
            sessionId,
            sessionPath: store.path,
        };
    } finally {
        options.signal?.removeEventListener("abort", onAbort);
    }
}

async function drainChildUpdates(
    client: InProcessChannel["client"],
): Promise<void> {
    while (true) {
        const update = await client.receive();
        if (update.type === "ui_request") {
            // The child has no attached UI, so it may never upgrade its
            // inherited permissions on its own.
            client.send({
                type: "ui_response",
                requestId: update.requestId,
                response: { type: "tool_approval", decision: "deny" },
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
    return text || "Subagent finished without a text summary.";
}

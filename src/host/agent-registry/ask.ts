import {
    hydrateImageAttachments,
    readSessionImageContent,
    sessionAttachmentSource,
} from "../../attachments/service.ts";
import type {
    AssistantMessage,
    ModelMessage,
    ModelRequest,
    ModelUsage,
} from "../../model/types.ts";
import { readModelRequestSnapshot } from "../../model-request-inspector.ts";
import {
    createFailedRequestCapture,
    type FailedRequestCapture,
} from "../../providers/failed-request-capture.ts";
import { ProviderRoutingAdapter } from "../../providers/routing.ts";
import type { ModelAdapterContext } from "../../sdk/model-middleware.ts";
import type { SessionStore } from "../../store/session-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";

export interface SessionAskCall {
    readonly question: string;
    readonly maxTokens?: number;
}

export interface SessionAskResult {
    readonly text: string;
    readonly model: string;
    readonly provider: string;
}

/** The session's provider chain, with every extension middleware applied. */
export function sessionModelAdapter(
    reg: AgentRegistry,
    store: SessionStore,
    notice: (text: string) => void,
    purpose: ModelAdapterContext["purpose"],
    captureFailedRequest: FailedRequestCapture,
): ProviderRoutingAdapter {
    return new ProviderRoutingAdapter(
        (provider) => {
            let created = reg.options.createAdapter(
                provider,
                store.header.cwd,
                captureFailedRequest,
            );
            for (const middleware of reg.options.modelMiddleware ?? []) {
                created = middleware(created, {
                    sessionId: store.header.id,
                    sessionPath: store.path,
                    ...(store.header.parentId === undefined ? {} : {
                        parentSessionId: store.header.parentId,
                    }),
                    workspace: store.header.cwd,
                    provider,
                    purpose,
                    notice,
                    // An ask runs behind the user's back, so it never stops to question them.
                    ...(purpose === "ask" ? {} : {
                        ask: async (request, signal) => {
                            const current = reg.agents.get(store.header.id);
                            if (current?.inbound === undefined || current.agent.closed) return { outcome: "cancelled" };
                            return current.inbound.requestUserQuestion(request,
                                { ...(signal === undefined ? {} : { signal }) });
                        },
                    }),
                });
            }
            return created;
        },
        reg.defaultProvider,
        reg.options.credentialFingerprint,
        reg.options.prepareModelRequest?.({
            sessionId: store.header.id,
            workspace: store.header.cwd,
        }),
    );
}

/**
 * Replays the session's last request with one question appended. Nothing the
 * model will see is written; the session file only gains a billing record.
 */
export async function askSession(
    reg: AgentRegistry,
    id: string,
    call: SessionAskCall,
    signal: AbortSignal,
): Promise<SessionAskResult> {
    const entry = reg.agents.get(id);
    if (
        entry === undefined
        || entry.ephemeral
        || entry.agent.closed
        || entry.agent.failed
    ) {
        throw new Error(`Session ${id} is not open`);
    }
    const saved = entry.eventLogPath === undefined
        ? undefined
        : await readModelRequestSnapshot(entry.eventLogPath, id);
    if (saved === undefined) {
        throw new Error(`Session ${id} has not sent a model request yet`);
    }
    signal.throwIfAborted();
    const provider = saved.provider
        ?? entry.modelSettings.provider
        ?? reg.defaultProvider;
    const capture = (
        reg.options.createFailedRequestCapture
            ?? ((sessionId) => createFailedRequestCapture({ sessionId }))
    )(id);
    const adapter = sessionModelAdapter(
        reg,
        entry.store,
        (text) => entry.events.emit({ type: "notice", key: "extension", count: 1, text }),
        "ask",
        capture,
    );
    const question: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: call.question }],
    };
    const messages = [...saved.messages, question];
    const carriesImage = messages.some((message) =>
        message.role === "user"
        && message.content.some((block) => block.type === "image_attachment")
    );
    const request: ModelRequest = {
        provider,
        model: saved.model,
        maxTokens: call.maxTokens ?? saved.maxTokens,
        ...(saved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: saved.reasoningEffort as ModelRequest["reasoningEffort"] }),
        systemPrompt: saved.systemPrompt,
        messages: await hydrateImageAttachments(
            messages,
            (attachmentId) => readSessionImageContent(entry.store, attachmentId),
            new Map(),
            carriesImage && !adapter.supportsImageInputFor(provider, saved.model),
            sessionAttachmentSource(entry.store),
        ),
        tools: saved.tools,
        signal,
    };
    let reply: AssistantMessage;
    try {
        reply = await adapter.stream(request).result();
    } catch (error) {
        signal.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${provider}/${saved.model} could not answer: ${reason}`);
    }
    if (billable(reply.usage)) {
        await entry.store.appendAskBilling({
            provider,
            model: saved.model,
            usage: reply.usage,
        });
    }
    return answerFrom(reply, id, provider, saved.model, signal);
}

function answerFrom(
    reply: AssistantMessage,
    id: string,
    provider: string,
    model: string,
    signal: AbortSignal,
): SessionAskResult {
    if (reply.stopReason === "aborted" || signal.aborted) {
        signal.throwIfAborted();
        throw new Error(`Asking session ${id} was cancelled`);
    }
    if (reply.stopReason === "error") {
        throw new Error(
            `${provider}/${model} could not answer: `
                + (reply.errorMessage ?? "the provider returned an error"),
        );
    }
    // The tools are offered only so the request prefix matches; none ever runs.
    if (reply.content.some((block) => block.type === "tool_call")) {
        throw new Error(
            `Session ${id} answered with a tool call instead of text`,
        );
    }
    const text = reply.content
        .flatMap((block) => block.type === "text" ? [block.text] : [])
        .join("");
    return { text, model, provider };
}

function billable(usage: ModelUsage): boolean {
    return usage.inputTokens > 0
        || usage.outputTokens > 0
        || (usage.cost !== undefined && usage.cost > 0);
}

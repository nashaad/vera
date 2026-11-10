import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import type { ModelNotice } from "../../src/sdk/model-middleware.ts";
import type { VeraClientExtensionApi, VeraExtensionApi } from "../../src/sdk/extensions.ts";
import { CacheMissSessions, cacheWarningOn, cacheWarningSettings } from "./cache-misses.ts";
import { cacheMissText } from "./cache-text.ts";

export function activate(vera: VeraExtensionApi): void {
    const settings = cacheWarningSettings(vera.config);
    if (!cacheWarningOn(settings)) return;
    const sessions = new CacheMissSessions(settings);
    vera.hooks.registerModelMiddleware((adapter, context) => {
        const notice = context.notice;
        if (context.purpose !== "turn" || notice === undefined) return adapter;
        return {
            ...(adapter.supportsImageInput === undefined ? {} : { supportsImageInput: adapter.supportsImageInput }),
            ...(adapter.imageInputSupport === undefined ? {} : { imageInputSupport: adapter.imageInputSupport.bind(adapter) }),
            ...(adapter.supportsImageInputFor === undefined ? {} : { supportsImageInputFor: adapter.supportsImageInputFor.bind(adapter) }),
            stream(request) {
                const output = new ModelEventStream();
                let terminal = false;
                const produce = async (): Promise<void> => {
                    request.signal?.throwIfAborted();
                    for await (const event of adapter.stream(request)) {
                        terminal ||= event.type === "done" || event.type === "error";
                        if (event.type === "done") observe(sessions, context.sessionId, event.message, notice);
                        output.push(event);
                    }
                    if (!terminal) throw new Error("Response ended without a result");
                };
                void produce().catch((cause: unknown) => {
                    if (terminal) return;
                    if (request.signal?.aborted) {
                        output.push({ type: "done", message: stoppedMessage() });
                        return;
                    }
                    const error = cause instanceof Error ? cause : new Error(String(cause));
                    output.push({ type: "error", error, message: {
                        ...stoppedMessage(), stopReason: "error", errorMessage: error.message,
                    } });
                });
                return output;
            },
        };
    });
}

function observe(
    sessions: CacheMissSessions,
    sessionId: string,
    message: AssistantMessage,
    notice: (notice: ModelNotice) => void,
): void {
    if (message.usage.inputTokens <= 0) return;
    try {
        const warning = sessions.tracker(sessionId).observe({
            provider: message.source.provider,
            model: message.source.model,
            inputTokens: message.usage.inputTokens,
            cachedInputTokens: message.usage.cachedInputTokens,
            at: Date.now(),
        });
        if (warning === undefined) return;
        notice({ key: "cache_miss", facts: {
            calls: warning.calls,
            reread_tokens: warning.rereadTokens,
            input_tokens: warning.inputTokens,
            provider: warning.provider,
            model: warning.model,
        } });
    } catch {
        // Cache accounting is advisory; a failure here must not end the model stream.
    }
}

function stoppedMessage(): AssistantMessage {
    return { role: "assistant", content: [],
        source: { provider: "local", api: "none", model: "none" },
        usage: emptyUsage(), stopReason: "aborted" };
}

export function activateClient(vera: VeraClientExtensionApi): void {
    vera.ui.registerNoticeRenderer(cacheMissText);
}

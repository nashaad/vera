import type {
    AssistantMessage,
    ModelRequest,
    ModelStreamEvent,
} from "../../../../src/model/types.ts";
import type { SessionEndHookPayload } from "../../../../src/sdk/hooks.ts";
import type { ModelAdapterContext, ModelMiddleware } from "../../../../src/sdk/model-middleware.ts";

import { CacheMissSessions, type CacheMissRule, type CacheMissSettings } from "./cache-rule.ts";
import {
    cutError,
    cacheMissEvent,
    modelCallEvent,
    sessionEndEvent,
    type EventContext,
    type PrefixPart,
    type SessionIdentity,
    type TelemetryEvent,
} from "./events.ts";
import { PrefixSessions, prefixParts, type PrefixParts } from "./prefix-hash.ts";

export interface TelemetryOptions {
    readonly context: EventContext;
    readonly cacheMiss: CacheMissSettings;
    readonly emit: (event: TelemetryEvent) => void;
}

export interface TelemetryHandlers {
    readonly middleware: ModelMiddleware;
    sessionEnded(payload: SessionEndHookPayload): void;
}

/** What a session last told us about itself, kept so `session_end` can repeat it. */
export class SessionFacts {
    private readonly last = new Map<string, SessionIdentity>();

    constructor(private readonly capacity = 64) {}

    remember(identity: SessionIdentity): void {
        this.last.delete(identity.session_id);
        this.last.set(identity.session_id, identity);
        if (this.last.size > this.capacity) {
            const oldest = this.last.keys().next().value;
            if (oldest !== undefined) this.last.delete(oldest);
        }
    }

    identityFor(sessionId: string): SessionIdentity {
        return this.last.get(sessionId)
            ?? { session_id: sessionId, provider: "", model: "", purpose: "turn" };
    }

    forget(sessionId: string): void {
        this.last.delete(sessionId);
    }
}

export function telemetryHandlers(options: TelemetryOptions): TelemetryHandlers {
    const prefixes = new PrefixSessions();
    const misses = new CacheMissSessions(options.cacheMiss);
    const facts = new SessionFacts();

    return {
        middleware(adapter, context) {
            return {
                ...(adapter.supportsImageInput === undefined
                    ? {}
                    : { supportsImageInput: adapter.supportsImageInput }),
                ...(adapter.imageInputSupport === undefined
                    ? {}
                    : { imageInputSupport: adapter.imageInputSupport.bind(adapter) }),
                ...(adapter.supportsImageInputFor === undefined
                    ? {}
                    : { supportsImageInputFor: adapter.supportsImageInputFor.bind(adapter) }),
                stream(request) {
                    const inner = adapter.stream(request);
                    const recorder = new CallRecorder(options, context, request, {
                        rule: misses.rule(context.sessionId),
                        facts,
                        prefix: prefixOf(prefixes, context.sessionId, request),
                    });
                    return {
                        result() {
                            let pending: Promise<AssistantMessage>;
                            try {
                                pending = inner.result();
                            } catch (cause) {
                                recorder.failed(cause, request.signal?.aborted === true);
                                throw cause;
                            }
                            return pending.then(
                                (message) => {
                                    recorder.finished(message);
                                    return message;
                                },
                                (cause: unknown) => {
                                    recorder.failed(cause, request.signal?.aborted === true);
                                    throw cause;
                                },
                            );
                        },
                        [Symbol.asyncIterator]() {
                            const iterator = inner[Symbol.asyncIterator]();
                            const wrapped: AsyncIterator<ModelStreamEvent> = {
                                async next() {
                                    try {
                                        const item = await iterator.next();
                                        if (item.done) {
                                            recorder.endedWithoutResult(request.signal?.aborted === true);
                                        } else {
                                            recorder.observe(item.value);
                                        }
                                        return item;
                                    } catch (cause) {
                                        recorder.failed(cause, request.signal?.aborted === true);
                                        throw cause;
                                    }
                                },
                            };
                            if (iterator.return !== undefined) {
                                wrapped.return = async (value?: ModelStreamEvent) => {
                                    if (request.signal?.aborted === true) recorder.aborted();
                                    return iterator.return!(value);
                                };
                            }
                            if (iterator.throw !== undefined) {
                                wrapped.throw = async (error?: unknown) => {
                                    recorder.failed(error, request.signal?.aborted === true);
                                    return iterator.throw!(error);
                                };
                            }
                            return wrapped;
                        },
                    };
                },
            };
        },
        sessionEnded(payload) {
            try {
                options.emit(sessionEndEvent(
                    facts.identityFor(payload.sessionId),
                    options.context,
                    payload.reason,
                    new Date().toISOString(),
                ));
            } catch {
                // Telemetry is an observer; a failed event must not affect the host.
            } finally {
                facts.forget(payload.sessionId);
            }
        },
    };
}

interface RecorderParts {
    readonly rule: CacheMissRule;
    readonly facts: SessionFacts;
    readonly prefix: PrefixedCall;
}

interface PrefixedCall {
    readonly parts: PrefixParts | undefined;
    readonly changed: PrefixPart | null;
}

function prefixOf(prefixes: PrefixSessions, sessionId: string, request: ModelRequest): PrefixedCall {
    try {
        const parts = prefixParts(request);
        return { parts, changed: prefixes.changed(sessionId, parts) };
    } catch {
        return { parts: undefined, changed: null };
    }
}

/** One finished or failed call. Every method is idempotent and none may throw. */
class CallRecorder {
    private settled = false;
    private readonly startedAt = performance.now();
    private readonly baseProvider: string;

    constructor(
        private readonly options: TelemetryOptions,
        private readonly context: ModelAdapterContext,
        private readonly request: ModelRequest,
        private readonly parts: RecorderParts,
    ) {
        this.baseProvider = request.provider ?? context.provider;
        this.rememberBase();
    }

    observe(event: ModelStreamEvent): void {
        if (event.type === "done") {
            this.finished(event.message);
        } else if (event.type === "error") {
            this.finished(event.message, errorWording(event.error, event.message, true));
        }
    }

    finished(message: AssistantMessage | undefined, failure?: string): void {
        this.record(message, failure, false);
    }

    failed(cause: unknown, aborted: boolean): void {
        if (aborted) {
            this.record(undefined, undefined, true);
        } else {
            this.record(undefined, causeWording(cause), false);
        }
    }

    aborted(): void {
        this.record(undefined, undefined, true);
    }

    endedWithoutResult(aborted: boolean): void {
        if (aborted) {
            this.record(undefined, undefined, true);
        } else {
            this.record(undefined, "model stream ended without a result", false);
        }
    }

    private record(
        message: AssistantMessage | undefined,
        failure: string | undefined,
        aborted: boolean,
    ): void {
        if (this.settled) return;
        this.settled = true;
        try {
            const identity = this.identity(message);
            const usage = message?.usage;
            const input = usage?.inputTokens ?? 0;
            const cached = usage?.cachedInputTokens ?? 0;
            const output = usage?.outputTokens ?? 0;
            const prefix = this.parts.prefix;
            const prefixChanged = prefix.changed;
            const time = new Date().toISOString();

            this.options.emit(modelCallEvent(identity, this.options.context, {
                input_tokens: input,
                cached_input_tokens: cached,
                output_tokens: output,
                latency_ms: Math.max(0, Math.round(performance.now() - this.startedAt)),
                stop_reason: aborted
                    ? "aborted"
                    : (message?.stopReason ?? (failure === undefined ? "stop" : "error")),
                ...(failure === undefined || aborted ? {} : { error: cutError(failure) }),
                cache_retention: this.request.cacheRetention ?? "short",
                has_cache_key: this.request.cacheKey !== undefined,
                message_count: this.request.messages.length,
                tool_count: this.request.tools?.length ?? 0,
                system_hash: prefix.parts?.system ?? "",
                tools_hash: prefix.parts?.tools ?? "",
                message_hashes: prefix.parts?.messages ?? [],
                prefix_changed: prefixChanged,
            }, time));

            this.parts.facts.remember(identity);

            const finding = this.parts.rule.observe({
                provider: identity.provider,
                model: identity.model,
                inputTokens: input,
                cachedInputTokens: cached,
                at: Date.now(),
            });
            if (finding !== undefined) {
                this.options.emit(cacheMissEvent(identity, this.options.context, {
                    input_tokens: input,
                    cached_input_tokens: cached,
                    previous_input_tokens: finding.previous_input_tokens,
                    previous_cached_input_tokens: finding.previous_cached_input_tokens,
                    reread_tokens: finding.reread_tokens,
                    gap_ms: finding.gap_ms,
                    prefix_changed: prefixChanged,
                }, time));
            }
        } catch {
            // A telemetry failure must not change, delay or end the model stream.
        }
    }

    private identity(message: AssistantMessage | undefined): SessionIdentity {
        return {
            session_id: this.context.sessionId,
            ...(this.context.parentSessionId === undefined
                ? {}
                : { parent_session_id: this.context.parentSessionId }),
            provider: message?.source?.provider ?? this.baseProvider,
            model: message?.source?.model ?? this.request.model,
            purpose: this.context.purpose,
        };
    }

    private rememberBase(): void {
        try {
            this.parts.facts.remember(this.identity(undefined));
        } catch {
            // Only a label for session_end; losing it costs nothing.
        }
    }
}

function causeWording(cause: unknown): string {
    if (cause instanceof Error) return errorWording(cause, undefined, false);
    if (typeof cause === "string" && cause.trim().length > 0) return cutError(cause);
    return "model call failed";
}

function errorWording(
    error: Error | undefined,
    message: AssistantMessage | undefined,
    preferMessage: boolean,
): string {
    const fromError = error?.message?.trim();
    const fromMessage = message?.errorMessage?.trim();
    const text = preferMessage
        ? (fromError !== undefined && fromError.length > 0 ? fromError : fromMessage)
        : (fromMessage !== undefined && fromMessage.length > 0 ? fromMessage : fromError);
    return text === undefined || text.length === 0 ? "model call failed" : cutError(text);
}

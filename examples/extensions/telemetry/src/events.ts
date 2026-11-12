export type PrefixPart = "system" | "tools" | "message:0" | "message:1" | "message:2" | "message:3";

/** What every event carries, whatever produced it. */
export interface TelemetryCommon {
    readonly time: string;
    readonly event: string;
    readonly install_id: string;
    readonly developer?: string;
    readonly session_id: string;
    readonly parent_session_id?: string;
    readonly provider: string;
    readonly model: string;
    readonly purpose: "turn" | "ask";
    readonly vera_version?: string;
}

export interface ModelCallEvent extends TelemetryCommon {
    readonly event: "model_call";
    readonly input_tokens: number;
    readonly cached_input_tokens: number;
    readonly output_tokens: number;
    readonly latency_ms: number;
    readonly stop_reason: string;
    readonly error?: string;
    readonly cache_retention: string;
    readonly has_cache_key: boolean;
    readonly message_count: number;
    readonly tool_count: number;
    readonly system_hash: string;
    readonly tools_hash: string;
    readonly message_hashes: readonly string[];
    readonly prefix_changed: PrefixPart | null;
}

export interface CacheMissEvent extends TelemetryCommon {
    readonly event: "cache_miss";
    readonly input_tokens: number;
    readonly cached_input_tokens: number;
    readonly previous_input_tokens: number;
    readonly previous_cached_input_tokens: number;
    readonly reread_tokens: number;
    readonly gap_ms: number;
    readonly prefix_changed: PrefixPart | null;
}

export interface SessionEndEvent extends TelemetryCommon {
    readonly event: "session_end";
    readonly reason: string;
}

export interface TelemetryDroppedEvent extends TelemetryCommon {
    readonly event: "telemetry_dropped";
    readonly dropped: number;
}

export type TelemetryEvent = ModelCallEvent | CacheMissEvent | SessionEndEvent | TelemetryDroppedEvent;

export interface SessionIdentity {
    readonly session_id: string;
    readonly parent_session_id?: string;
    readonly provider: string;
    readonly model: string;
    readonly purpose: "turn" | "ask";
}

export interface EventContext {
    readonly install_id: string;
    readonly developer?: string;
    readonly vera_version?: string;
}

export interface ModelCallFacts {
    readonly input_tokens: number;
    readonly cached_input_tokens: number;
    readonly output_tokens: number;
    readonly latency_ms: number;
    readonly stop_reason: string;
    readonly error?: string;
    readonly cache_retention: string;
    readonly has_cache_key: boolean;
    readonly message_count: number;
    readonly tool_count: number;
    readonly system_hash: string;
    readonly tools_hash: string;
    readonly message_hashes: readonly string[];
    readonly prefix_changed: PrefixPart | null;
}

export interface CacheMissFacts {
    readonly input_tokens: number;
    readonly cached_input_tokens: number;
    readonly previous_input_tokens: number;
    readonly previous_cached_input_tokens: number;
    readonly reread_tokens: number;
    readonly gap_ms: number;
    readonly prefix_changed: PrefixPart | null;
}

/** A provider's own wording can carry a request echo, so keep only the first 300 characters. */
export const MAX_ERROR_CHARS = 300;

export function cutError(message: string): string {
    return Array.from(message.trim()).slice(0, MAX_ERROR_CHARS).join("");
}

export function common(
    identity: SessionIdentity,
    context: EventContext,
    event: string,
    time: string,
): TelemetryCommon {
    return {
        time,
        event,
        install_id: context.install_id,
        ...(context.developer === undefined ? {} : { developer: context.developer }),
        session_id: identity.session_id,
        ...(identity.parent_session_id === undefined ? {} : { parent_session_id: identity.parent_session_id }),
        provider: identity.provider,
        model: identity.model,
        purpose: identity.purpose,
        ...(context.vera_version === undefined ? {} : { vera_version: context.vera_version }),
    };
}

export function modelCallEvent(
    identity: SessionIdentity,
    context: EventContext,
    facts: ModelCallFacts,
    time: string,
): ModelCallEvent {
    return {
        ...common(identity, context, "model_call", time),
        event: "model_call",
        input_tokens: facts.input_tokens,
        cached_input_tokens: facts.cached_input_tokens,
        output_tokens: facts.output_tokens,
        latency_ms: facts.latency_ms,
        stop_reason: facts.stop_reason,
        ...(facts.error === undefined ? {} : { error: facts.error }),
        cache_retention: facts.cache_retention,
        has_cache_key: facts.has_cache_key,
        message_count: facts.message_count,
        tool_count: facts.tool_count,
        system_hash: facts.system_hash,
        tools_hash: facts.tools_hash,
        message_hashes: facts.message_hashes,
        prefix_changed: facts.prefix_changed,
    };
}

export function cacheMissEvent(
    identity: SessionIdentity,
    context: EventContext,
    facts: CacheMissFacts,
    time: string,
): CacheMissEvent {
    return {
        ...common(identity, context, "cache_miss", time),
        event: "cache_miss",
        input_tokens: facts.input_tokens,
        cached_input_tokens: facts.cached_input_tokens,
        previous_input_tokens: facts.previous_input_tokens,
        previous_cached_input_tokens: facts.previous_cached_input_tokens,
        reread_tokens: facts.reread_tokens,
        gap_ms: facts.gap_ms,
        prefix_changed: facts.prefix_changed,
    };
}

export function sessionEndEvent(
    identity: SessionIdentity,
    context: EventContext,
    reason: string,
    time: string,
): SessionEndEvent {
    return {
        ...common(identity, context, "session_end", time),
        event: "session_end",
        reason,
    };
}

/**
 * Drops are counted across sessions, so the session, provider and model
 * fields are empty and `purpose` names the only thing a drop can be about:
 * a call the host made.
 */
export function telemetryDroppedEvent(
    context: EventContext,
    dropped: number,
    time: string,
): TelemetryDroppedEvent {
    return {
        ...common(
            { session_id: "", provider: "", model: "", purpose: "turn" },
            context,
            "telemetry_dropped",
            time,
        ),
        event: "telemetry_dropped",
        dropped,
    };
}

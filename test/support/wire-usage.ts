import type { AgentUpdate } from "../../src/engine/protocol.ts";

/** The update with its session usage removed, so assertions stay stable. */
export function withoutSessionUsage(update: AgentUpdate): AgentUpdate {
    if (update.type !== "history" && update.type !== "turn_finished") {
        return update;
    }
    const { usage: _usage, ...rest } = update;
    if (rest.type === "turn_finished") {
        const { turnTiming: _turnTiming, ...stable } = rest;
        return stable;
    }
    if (rest.type === "history") {
        return { ...rest, entries: rest.entries.map(({ turnTiming: _timing, ...entry }) => entry) };
    }
    return rest as AgentUpdate;
}

/**
 * The message with its wall-clock call duration removed. The provider's own
 * timing is real but never the same twice, so it cannot sit in an equality.
 */
export function withoutCallDuration<T extends { readonly role: string }>(
    message: T | undefined,
): T | undefined {
    if (message === undefined || message.role !== "assistant") {
        return message;
    }
    const { durationMs: _durationMs, turnTiming: _turnTiming, ...rest } = message as
        & T
        & { durationMs?: number; turnTiming?: unknown };
    return rest as unknown as T;
}

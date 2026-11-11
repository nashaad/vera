import type { ContextSizePolicy } from "./context-size-triggers.ts";

export const UNKNOWN_CONTEXT_CAPACITY_TOKENS = 100_000;

export const DEFAULT_TRIM_STEP_FRACTION = 0.1;

export const DEFAULT_ACTIVE_TURN_HIGH_FRACTION = 0.75;

export const DEFAULT_ACTIVE_TURN_LOW_FRACTION = 0.35;

export const DEFAULT_COMPACTION_TRIGGER_FRACTION = 0.82;

export const DEFAULT_COMPACTION_RETRY_GROWTH_TOKENS = 10_000;

export interface ContextSizeLimit {
    readonly fraction?: number;
    readonly tokens?: number;
}

export interface ContextSizeTriggerDefaults {
    readonly capacity: number | undefined;
    readonly trimGateFraction: number;
    readonly compactionTrigger?: ContextSizeLimit;
}

export function defaultContextSizePolicies(
    defaults: ContextSizeTriggerDefaults,
): readonly ContextSizePolicy[] {
    const window = defaults.capacity ?? UNKNOWN_CONTEXT_CAPACITY_TOKENS;
    const compactLevel = resolveCompactionTriggerTokens(
        defaults.capacity,
        defaults.compactionTrigger,
    );
    return [
        {
            kind: "every_n",
            id: "trim",
            from: window * defaults.trimGateFraction,
            step: Math.max(1, window * DEFAULT_TRIM_STEP_FRACTION),
            actions: ["trim"],
        },
        {
            kind: "high_low",
            id: "active_turn",
            high: window * DEFAULT_ACTIVE_TURN_HIGH_FRACTION,
            low: window * DEFAULT_ACTIVE_TURN_LOW_FRACTION,
            actions: ["stub_active_turn"],
        },
        {
            kind: "ladder",
            id: "compact",
            levels: compactLevel === undefined ? [] : [compactLevel],
            actions: ["compact"],
        },
    ];
}

export function resolveCompactionTriggerTokens(
    capacity: number | undefined,
    trigger?: ContextSizeLimit,
): number | undefined {
    const tokens = trigger?.tokens
        ?? (capacity === undefined ? UNKNOWN_CONTEXT_CAPACITY_TOKENS : undefined);
    if (capacity === undefined) {
        return tokens;
    }
    const share = capacity
        * (trigger?.fraction ?? DEFAULT_COMPACTION_TRIGGER_FRACTION);
    return tokens === undefined ? share : Math.min(tokens, share);
}

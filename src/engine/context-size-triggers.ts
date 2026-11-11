export type ContextSizeAction = "trim" | "stub_active_turn" | "compact";

export type ContextSizeTriggerReason =
    | "session_start"
    | "user_action"
    | "pressure"
    | "compacted";

export interface ContextSizeMeasurement {
    readonly tokens: number;
    readonly capacity?: number;
}

export interface LadderContextSizePolicy {
    readonly kind: "ladder";
    readonly id: string;
    readonly levels: readonly number[];
    readonly actions: readonly ContextSizeAction[];
}

export interface HighLowContextSizePolicy {
    readonly kind: "high_low";
    readonly id: string;
    readonly high: number;
    readonly low: number;
    readonly actions: readonly ContextSizeAction[];
}

export interface EveryNContextSizePolicy {
    readonly kind: "every_n";
    readonly id: string;
    readonly from: number;
    readonly step: number;
    readonly actions: readonly ContextSizeAction[];
}

export type ContextSizePolicy =
    | LadderContextSizePolicy
    | HighLowContextSizePolicy
    | EveryNContextSizePolicy;

export interface ContextSizeTrigger {
    readonly reason: ContextSizeTriggerReason;
    readonly tokens: number;
    readonly capacity?: number;
    readonly policy?: ContextSizePolicy;
}

/** What one fired action changed, after it finished. */
export interface ContextSizeTriggerReport {
    readonly trigger: ContextSizeTrigger;
    readonly action: ContextSizeAction;
    /** Measured when read, so a caller that drops the report pays nothing. */
    readonly tokensAfter: number;
    /**
     * The changed messages, joined in order: index, tool call id and resulting
     * bytes for trim, index and tool call id for an active-turn stub. Equal
     * strings mean two requests saw the same projection.
     */
    readonly fingerprint: string;
}

export interface ContextSizeTriggerSet {
    fire(
        action: ContextSizeAction,
        measurement: ContextSizeMeasurement,
    ): ContextSizeTrigger | undefined;
    observe(
        action: ContextSizeAction,
        measurement: ContextSizeMeasurement,
        changed: boolean,
    ): void;
    reset(action?: ContextSizeAction): void;
}

interface PolicyState {
    armed: boolean;
    last: number;
}

export function createContextSizeTriggerSet(
    policies: readonly ContextSizePolicy[],
): ContextSizeTriggerSet {
    const states = new Map<ContextSizePolicy, PolicyState>();
    for (const policy of policies) {
        states.set(policy, {
            armed: true,
            last: policy.kind === "every_n" ? policy.from - policy.step : 0,
        });
    }
    const reset = (action?: ContextSizeAction): void => {
        for (const policy of policies) {
            if (action !== undefined && !policy.actions.includes(action)) continue;
            const state = states.get(policy)!;
            state.armed = true;
            state.last = policy.kind === "every_n" ? policy.from - policy.step : 0;
        }
    };
    return {
        fire(action, measurement) {
            for (const policy of policies) {
                if (!policy.actions.includes(action)) continue;
                const state = states.get(policy)!;
                if (policy.kind === "ladder") {
                    if (highestLevelAtOrBelow(policy.levels, measurement.tokens)
                        === undefined) {
                        continue;
                    }
                } else if (policy.kind === "high_low") {
                    if (!state.armed) {
                        if (measurement.tokens > policy.low) continue;
                        state.armed = true;
                    }
                    if (measurement.tokens < policy.high) continue;
                } else {
                    if (!(policy.step > 0)) continue;
                    if (measurement.tokens < state.last + policy.step) continue;
                    const crossed = policy.from
                        + Math.floor((measurement.tokens - policy.from) / policy.step)
                            * policy.step;
                    state.last = Math.max(policy.from, crossed);
                }
                return {
                    reason: "pressure",
                    tokens: measurement.tokens,
                    ...(measurement.capacity === undefined
                        ? {}
                        : { capacity: measurement.capacity }),
                    policy,
                };
            }
            return undefined;
        },
        observe(action, measurement, changed) {
            if (!changed) return;
            for (const policy of policies) {
                if (policy.kind !== "high_low") continue;
                if (!policy.actions.includes(action)) continue;
                states.get(policy)!.armed = measurement.tokens <= policy.low;
            }
        },
        reset,
    };
}

function highestLevelAtOrBelow(
    levels: readonly number[],
    tokens: number,
): number | undefined {
    let highest: number | undefined;
    for (const level of levels) {
        if (level <= tokens && (highest === undefined || level > highest)) {
            highest = level;
        }
    }
    return highest;
}

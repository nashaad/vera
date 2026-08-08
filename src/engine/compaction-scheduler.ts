import type { ModelMessage } from "../model/types.ts";
import type {
    SessionCompactionDiagnostics,
    SessionMessageEntry,
    SessionStore,
} from "../store/session-store.ts";
import {
    CompactionRejectedError,
    validateProposal,
    type CompactionRequest,
    type CompactionStrategyDefinition,
} from "./compaction.ts";
import {
    CompletionUnavailableError,
    type CompleteText,
} from "./completion-service.ts";
import { measureMessages, type ContextMeasurement } from
    "./context-measurement.ts";

/**
 * The share of the window at which a session is compacted. Below the ceiling
 * on purpose: the trigger reading is usually an estimate, and a margin is what
 * keeps compaction from starting on a turn that has already overflowed.
 */
export const COMPACTION_TRIGGER_FRACTION = 0.82;

/**
 * What the request must be under afterwards. The gap between this and the
 * trigger is the whole value of compacting: land too close to the trigger and
 * the next turn compacts again.
 */
export const POST_COMPACTION_TARGET_FRACTION = 0.45;

/**
 * Share of the token trigger a session with no known window compacts down to.
 * Tighter than the ratio between the two fractions above, so a session that
 * has no window to measure against lands well clear of the trigger it crossed.
 */
export const UNKNOWN_CAPACITY_TARGET_FRACTION = 0.35;

/**
 * The token count a session with no known window compacts at when nothing else
 * bounds it. Without it such a session has no bound at all: it grows until the
 * provider rejects the request.
 */
export const UNKNOWN_CAPACITY_TRIGGER_TOKENS = 100_000;

/**
 * The absolute bound in force, which is the configured one when there is one
 * and otherwise the default that only a session with no known window gets.
 */
function effectiveTriggerTokens(
    capacity: number | undefined,
    trigger?: CompactionTrigger,
): number | undefined {
    if (trigger?.tokens !== undefined) {
        return trigger.tokens;
    }
    return capacity === undefined ? UNKNOWN_CAPACITY_TRIGGER_TOKENS : undefined;
}

/** A summary smaller than this cannot carry a session, so do not ask for one. */
export const MIN_SUMMARY_TOKENS = 400;

/** Complete user turns kept verbatim after the boundary. */
export const RETAINED_USER_TURNS = 2;

export type CompactionOutcome =
    | { readonly outcome: "not_needed" }
    /** Needed, but no boundary leaves room for a usable summary. */
    | { readonly outcome: "no_boundary"; readonly reason: string }
    | { readonly outcome: "rejected"; readonly reason: string }
    | { readonly outcome: "unavailable"; readonly reason: string }
    | { readonly outcome: "cancelled" }
    /** Asked for while a turn was running. Only a user can produce this. */
    | { readonly outcome: "busy" }
    | {
        readonly outcome: "compacted";
        readonly before: number;
        readonly after: number;
    };

/**
 * What a session compacts down to. Only consulted when the window is unknown:
 * with a window, the target is a share of it.
 */
export interface CompactionBudget {
    readonly trigger?: CompactionTrigger;
    /** Absolute token target, overriding the one derived from the trigger. */
    readonly targetTokens?: number;
}

export interface CompactionSchedulerOptions {
    readonly store: SessionStore;
    readonly strategy: CompactionStrategyDefinition;
    /** Slot name to bound model, already resolved from config routes. */
    readonly models: Readonly<Record<string, CompleteText>>;
    readonly diagnostics?: SessionCompactionDiagnostics;
    readonly trigger?: CompactionTrigger;
    readonly targetTokens?: number;
}

/**
 * The whole request budget a compaction has to land under, before the fixed
 * overhead and the retained turns are taken out of it.
 *
 * A session with no window is sized against its token trigger, which is the
 * default one when none is configured.
 */
export function compactionTargetBudget(
    measurement: ContextMeasurement,
    budget?: CompactionBudget,
): number | undefined {
    if (measurement.capacity !== undefined) {
        return Math.floor(
            measurement.capacity * POST_COMPACTION_TARGET_FRACTION,
        );
    }
    if (budget?.targetTokens !== undefined) {
        return budget.targetTokens;
    }
    const triggerTokens = effectiveTriggerTokens(
        measurement.capacity,
        budget?.trigger,
    );
    return triggerTokens === undefined
        ? undefined
        : Math.floor(triggerTokens * UNKNOWN_CAPACITY_TARGET_FRACTION);
}

/**
 * When a session compacts. Both bounds are optional and either one firing is
 * enough; `fraction` falls back to `COMPACTION_TRIGGER_FRACTION`.
 */
export interface CompactionTrigger {
    /** Share of a known window. */
    readonly fraction?: number;
    /** Absolute token count. The only bound a session with no known window has. */
    readonly tokens?: number;
}

export function shouldCompact(
    measurement: ContextMeasurement | undefined,
    trigger?: CompactionTrigger,
): boolean {
    if (measurement === undefined) {
        return false;
    }
    const triggerTokens = effectiveTriggerTokens(
        measurement.capacity,
        trigger,
    );
    if (triggerTokens !== undefined && measurement.tokens >= triggerTokens) {
        return true;
    }
    if (measurement.capacity === undefined) {
        // No window means no fraction to compare against, and the absolute
        // bound above is the only one such a session ever gets.
        return false;
    }
    const fraction = trigger?.fraction ?? COMPACTION_TRIGGER_FRACTION;
    return measurement.tokens >= measurement.capacity * fraction;
}

/**
 * Why a compaction about to run cannot pay for itself, or undefined when it
 * can. A target above the token trigger lands the request back above the
 * trigger, so the next turn asks for another one.
 */
export function compactionBudgetWarning(
    measurement: ContextMeasurement,
    budget?: CompactionBudget,
): string | undefined {
    const triggerTokens = effectiveTriggerTokens(
        measurement.capacity,
        budget?.trigger,
    );
    const target = compactionTargetBudget(measurement, budget);
    if (
        triggerTokens === undefined
        || target === undefined
        || target <= triggerTokens
    ) {
        return undefined;
    }
    return `Compaction targets ${target} tokens, above trigger_tokens`
        + ` (${triggerTokens}). A summary that fits the target can still sit`
        + ` above the trigger, so the next turn compacts again. Raise`
        + ` trigger_tokens above ${target}.`;
}

/**
 * Compacts the session in place, at a boundary the engine picks.
 *
 * Called between turns, never inside one: the span it compacts has to be
 * finished and durable, and a strategy running against a half-written turn
 * would summarize a tool call whose result does not exist yet.
 *
 * Nothing is announced before the append. Every failure leaves the previous
 * projection exactly as it was, because the alternative to a compacted session
 * is an uncompacted one, not a broken one.
 */
export async function compactSession(
    options: CompactionSchedulerOptions,
    measurement: ContextMeasurement,
    signal: AbortSignal,
): Promise<CompactionOutcome> {
    const capacity = measurement.capacity;
    const budget = compactionTargetBudget(measurement, options);
    if (budget === undefined) {
        return { outcome: "not_needed" };
    }
    const store = options.store;
    const active = store.activeEntries();
    const previous = store.latestCompaction();
    const previousProjection = previous?.projection ?? [];
    const previousBoundary = previous === undefined
        ? -1
        : active.findIndex((entry) => entry.id === previous.boundaryMessageId);

    const plan = planBoundary(active, previousBoundary);
    if (plan === undefined) {
        return {
            outcome: "no_boundary",
            reason: "There is not enough finished history to compact yet.",
        };
    }

    // What the request costs beyond its messages: the system prompt, the tool
    // definitions, the project instructions. Compaction cannot shrink any of
    // it, so it comes off the budget before the strategy is given a number.
    const modelContext = [
        ...previousProjection,
        ...active.slice(previousBoundary + 1).map((entry) => entry.message),
    ];
    const overhead = Math.max(
        0,
        measurement.tokens - measureMessages(modelContext),
    );
    const suffix = active.slice(plan.boundaryIndex + 1)
        .map((entry) => entry.message);
    const targetTokens = budget - overhead - measureMessages(suffix);
    if (targetTokens < MIN_SUMMARY_TOKENS) {
        return {
            outcome: "no_boundary",
            reason: "The kept turns and the system prompt already fill the "
                + "window, so a summary would have nowhere to go.",
        };
    }

    const span: readonly ModelMessage[] = [
        ...previousProjection,
        ...active.slice(previousBoundary + 1, plan.boundaryIndex + 1)
            .map((entry) => entry.message),
    ];
    const request: CompactionRequest = {
        // A copy, frozen through: the span aliases live store entries and the
        // previous projection, and a strategy write to either would change the
        // model context without a log append.
        messages: deepFreeze(structuredClone(span) as ModelMessage[]),
        targetTokens,
        models: options.models,
    };

    let projection: readonly ModelMessage[];
    try {
        const proposal = await options.strategy.compact(request, signal);
        if (signal.aborted) {
            return { outcome: "cancelled" };
        }
        projection = validateProposal(proposal, request);
    } catch (error) {
        if (signal.aborted) {
            return { outcome: "cancelled" };
        }
        if (error instanceof CompactionRejectedError) {
            return { outcome: "rejected", reason: error.message };
        }
        if (error instanceof CompletionUnavailableError) {
            return { outcome: "unavailable", reason: error.message };
        }
        return {
            outcome: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    // The no-progress guard. A projection that fits the target but does not
    // beat what it replaces has cost a model call to change nothing, and
    // accepting it would let the next turn ask again immediately.
    const before = measureMessages(modelContext) + overhead;
    const after = measureMessages([...projection, ...suffix]) + overhead;
    if (after >= before) {
        return {
            outcome: "rejected",
            reason: "The compacted context is no smaller than the one it "
                + "would replace.",
        };
    }

    try {
        await store.appendCompaction({
            boundaryMessageId: plan.boundaryId,
            firstRetainedMessageId: plan.firstRetainedId,
            projection,
            measured: {
                inputTokens: after,
                ...(capacity === undefined ? {} : { contextWindow: capacity }),
                estimated: measurement.estimated,
            },
            ...(options.diagnostics === undefined
                ? {}
                : { diagnostics: options.diagnostics }),
        });
    } catch (error) {
        return {
            outcome: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
        };
    }
    return { outcome: "compacted", before, after };
}

function deepFreeze<T>(value: T): T {
    if (typeof value === "object" && value !== null) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

interface BoundaryPlan {
    readonly boundaryIndex: number;
    readonly boundaryId: string;
    readonly firstRetainedId: string | null;
}

/**
 * The latest boundary that keeps `RETAINED_USER_TURNS` complete turns verbatim
 * and leaves something in front of it worth compacting.
 *
 * A boundary is only ever placed directly before a user message. Anywhere else
 * splits a turn: the suffix would open on an assistant message answering a
 * question the model can no longer see, or on a tool result whose call went
 * into the summary.
 */
function planBoundary(
    active: readonly SessionMessageEntry[],
    previousBoundary: number,
): BoundaryPlan | undefined {
    const userStarts = active.flatMap((entry, index) =>
        entry.message.role === "user" && index > previousBoundary ? [index] : []
    );
    const suffixStart = userStarts[userStarts.length - RETAINED_USER_TURNS];
    if (suffixStart === undefined || suffixStart === 0) {
        return undefined;
    }
    const boundaryIndex = suffixStart - 1;
    if (boundaryIndex <= previousBoundary) {
        // Nothing has been added since the last compaction that a new one
        // would cover.
        return undefined;
    }
    const boundary = active[boundaryIndex];
    const retained = active[suffixStart];
    if (boundary === undefined || retained === undefined) {
        return undefined;
    }
    return {
        boundaryIndex,
        boundaryId: boundary.id,
        firstRetainedId: retained.id,
    };
}

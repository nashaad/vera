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

/** Complete user turns kept verbatim after the boundary, when they fit. */
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
        readonly model?: string;
        readonly provider?: string;
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
    /** Model whose next request this measurement describes. */
    readonly model?: string;
    /** The current model-facing context, excluding pending messages. */
    readonly modelContext?: readonly ModelMessage[];
    /**
     * Projects a hypothetical compaction context with the same disposable
     * history policy the trigger used. Absent for older direct callers.
     */
    readonly projectModelContext?: (
        projection: readonly ModelMessage[],
        retained: readonly ModelMessage[],
    ) => readonly ModelMessage[];
    readonly diagnostics?: SessionCompactionDiagnostics;
    readonly trigger?: CompactionTrigger;
    readonly targetTokens?: number;
    /** Complete user turns preferred verbatim. `RETAINED_USER_TURNS` if unset. */
    readonly retainedUserTurns?: number;
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
 * What is wrong with the budget a compaction is about to run under, or
 * undefined when nothing is. Two things can be wrong at once, so every part
 * that applies is reported in one string.
 *
 * A target above the token trigger lands the request back above the trigger,
 * so the next turn asks for another one. A `target_tokens` set on a model
 * whose window is known is read and then never used, which looks like the
 * setting doing nothing.
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
    const parts = [
        ignoredTargetWarning(measurement, budget, target),
        targetAboveTriggerWarning(triggerTokens, target),
    ].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(" ");
}

/**
 * `target_tokens` only sizes a session with no known window. With a window the
 * target is a share of it, and there is no setting for that share.
 */
function ignoredTargetWarning(
    measurement: ContextMeasurement,
    budget: CompactionBudget | undefined,
    target: number | undefined,
): string | undefined {
    if (
        measurement.capacity === undefined
        || budget?.targetTokens === undefined
        || target === undefined
    ) {
        return undefined;
    }
    return `compaction.target_tokens (${budget.targetTokens}) is ignored:`
        + ` this model's context window is known (${measurement.capacity}`
        + ` tokens), so compaction targets a fixed share of it (${target}`
        + ` tokens). target_tokens only applies when the window is unknown,`
        + ` and the share is not configurable. Remove it, or use`
        + ` trigger_fraction and trigger_tokens to change when compaction`
        + ` fires.`;
}

function targetAboveTriggerWarning(
    triggerTokens: number | undefined,
    target: number | undefined,
): string | undefined {
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
 * Called only at durable boundaries: before a turn or after every tool call
 * and result in a model round has finished. A strategy must never run against
 * a half-written round, where it could summarize a call whose result does not
 * exist yet.
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

    // What the request costs beyond its messages: the system prompt, the tool
    // definitions, the project instructions. Compaction cannot shrink any of
    // it, so it comes off the budget before the strategy is given a number.
    const modelContext = options.modelContext ?? [
        ...previousProjection,
        ...active.slice(previousBoundary + 1).map((entry) => entry.message),
    ];
    // Stated by the measurer where it can be, because `measurement.tokens`
    // may be scaled into the provider's units while `measureMessages` and the
    // budget below are raw estimator units. Subtracting one from the other
    // would fold the whole transcript's calibration into the overhead.
    const overhead = Math.max(
        0,
        measurement.overheadTokens
            ?? measurement.tokens - measureMessages(modelContext),
    );

    const viable: { plan: BoundaryPlan; targetTokens: number }[] = [];
    let sawCandidate = false;
    for (
        const candidate of candidateBoundaries(
            active,
            previousBoundary,
            options.retainedUserTurns ?? RETAINED_USER_TURNS,
        )
    ) {
        sawCandidate = true;
        const kept = active.slice(candidate.boundaryIndex + 1)
            .map((entry) => entry.message);
        const keptContext = options.projectModelContext === undefined
            ? kept
            : options.projectModelContext(previousProjection, kept);
        const room = budget - overhead - measureMessages(keptContext);
        if (room < MIN_SUMMARY_TOKENS) {
            continue;
        }
        const previousRoom = viable[viable.length - 1]?.targetTokens;
        // Only rungs that pose a materially easier problem than the last one
        // are worth a second call: adjacent seams differ by one message, so
        // retrying on those would burn calls to ask the same question again.
        if (
            previousRoom !== undefined
            && room < previousRoom + MIN_SUMMARY_TOKENS
        ) {
            continue;
        }
        viable.push({ plan: candidate, targetTokens: room });
    }
    // The last rung has the most room and is the ladder's failsafe, so the cap
    // takes rungs off the front, never off the end. Trimming the end would
    // leave the retry unable to reach the boundary most likely to fit.
    const attempts = viable.length > MAX_COMPACTION_ATTEMPTS
        ? [
            ...viable.slice(0, MAX_COMPACTION_ATTEMPTS - 1),
            ...viable.slice(-1),
        ]
        : viable;
    if (attempts.length === 0) {
        return {
            outcome: "no_boundary",
            reason: sawCandidate
                ? "No boundary leaves room for a usable summary: what must "
                    + "be kept verbatim plus the fixed request overhead "
                    + "already fills the compaction target."
                : "There is not enough finished history to compact yet.",
        };
    }

    // A rejection is not the end. The rung had room by measurement and the
    // summarizer overshot it anyway, which the next turn would reproduce
    // exactly, so the session would never compact again. Dropping to a looser
    // rung costs one more call and is the only thing here that recovers.
    let retryable: CompactionOutcome | undefined;
    for (const attempt of attempts) {
        if (signal.aborted) {
            return { outcome: "cancelled" };
        }
        const outcome = await attemptCompaction({
            attempt,
            active,
            previousProjection,
            previousBoundary,
            modelContext,
            overhead,
            capacity,
            measurement,
            options,
            store,
            signal,
        });
        // A fault no extra room would change: every further rung would spend a
        // call to collect the same answer. Success says the same thing for a
        // happier reason.
        if (!outcome.retry) {
            return outcome.result;
        }
        retryable = outcome.result;
    }
    return retryable ?? { outcome: "cancelled" };
}

/** How many boundaries one compaction may spend a summarizer call on. */
export const MAX_COMPACTION_ATTEMPTS = 3;

interface AttemptOptions {
    readonly attempt: { plan: BoundaryPlan; targetTokens: number };
    readonly active: readonly SessionMessageEntry[];
    readonly previousProjection: readonly ModelMessage[];
    readonly previousBoundary: number;
    readonly modelContext: readonly ModelMessage[];
    readonly overhead: number;
    readonly capacity: number | undefined;
    readonly measurement: ContextMeasurement;
    readonly options: CompactionSchedulerOptions;
    readonly store: SessionStore;
    readonly signal: AbortSignal;
}

/** A rung's result, and whether a rung with more room could do better. */
interface AttemptResult {
    readonly result: CompactionOutcome;
    readonly retry: boolean;
}

/** One rung: summarize the span before it, check it, append it. */
async function attemptCompaction(
    input: AttemptOptions,
): Promise<AttemptResult> {
    const {
        active,
        capacity,
        measurement,
        modelContext,
        options,
        overhead,
        previousBoundary,
        previousProjection,
        signal,
        store,
    } = input;
    const { plan, targetTokens } = input.attempt;
    const suffix = active.slice(plan.boundaryIndex + 1)
        .map((entry) => entry.message);

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
    let proposalModel: string | undefined;
    let proposalProvider: string | undefined;
    try {
        const proposal = await options.strategy.compact(request, signal);
        // Checked here as well as in the catch, for the abort that lands as
        // the call resolves: a cached or already buffered answer returns
        // normally rather than throwing, and applying it would rewrite the
        // context of a session that asked to be left alone.
        if (signal.aborted) {
            return { result: { outcome: "cancelled" }, retry: false };
        }
        projection = validateProposal(proposal, request);
        proposalModel = proposal.model;
        proposalProvider = proposal.provider;
    } catch (error) {
        if (signal.aborted) {
            return { result: { outcome: "cancelled" }, retry: false };
        }
        if (error instanceof CompactionRejectedError) {
            return {
                result: { outcome: "rejected", reason: error.message },
                retry: error.roomRelated,
            };
        }
        if (error instanceof CompletionUnavailableError) {
            // A route that had somewhere to go and could not reach it for want
            // of room is the case a shorter span fixes, which is what the next
            // rung is.
            return {
                result: { outcome: "unavailable", reason: error.message },
                retry: error.roomRelated,
            };
        }
        return {
            result: {
                outcome: "unavailable",
                reason: error instanceof Error ? error.message : String(error),
            },
            retry: false,
        };
    }

    // The no-progress guard. A projection that fits the target but does not
    // beat what it replaces has cost a model call to change nothing, and
    // accepting it would let the next turn ask again immediately.
    const before = measureMessages(modelContext) + overhead;
    const afterContext = options.projectModelContext === undefined
        ? [...projection, ...suffix]
        : options.projectModelContext(projection, suffix);
    const after = measureMessages(afterContext) + overhead;
    if (after >= before) {
        return {
            result: {
                outcome: "rejected",
                reason: "The compacted context is no smaller than the one it "
                    + "would replace.",
            },
            // A boundary further along replaces more of the transcript, so
            // this is one a looser rung can beat.
            retry: true,
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
                ...(options.model === undefined ? {} : { model: options.model }),
                estimated: measurement.estimated,
            },
            ...(options.diagnostics === undefined
                ? {}
                : {
                    diagnostics: {
                        ...options.diagnostics,
                        ...(proposalModel === undefined
                            ? {}
                            : { model: proposalModel }),
                        ...(proposalProvider === undefined
                            ? {}
                            : { provider: proposalProvider }),
                    },
                }),
        });
    } catch (error) {
        return {
            result: {
                outcome: "unavailable",
                reason: error instanceof Error ? error.message : String(error),
            },
            retry: false,
        };
    }
    return {
        result: {
            outcome: "compacted",
            before,
            after,
            ...(proposalModel === undefined ? {} : { model: proposalModel }),
            ...(proposalProvider === undefined
                ? {}
                : { provider: proposalProvider }),
        },
        retry: false,
    };
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
 * Boundary candidates in order of preference, each keeping less verbatim than
 * the one before it. The caller takes the first whose kept tail leaves room
 * for a usable summary, so a session whose newest turn alone outgrows the
 * budget degrades to a tighter cut instead of silently declining forever.
 *
 * The rungs:
 *
 * 1. Directly before a user message, keeping the preferred number of complete
 *    turns, then fewer, down to one.
 * 2. Directly before an assistant message inside the newest turn, splitting
 *    the turn at a finished model round. Never before a tool result: its call
 *    would be in the summary and the pair would be broken.
 * 3. After the last message, keeping nothing verbatim.
 *
 * A `compactionBarrier` message caps the ladder: everything from the barrier
 * on is kept verbatim, so the barrier is the only cut offered and rungs past
 * it never come up.
 */
function* candidateBoundaries(
    active: readonly SessionMessageEntry[],
    previousBoundary: number,
    retainedUserTurns: number,
): Generator<BoundaryPlan> {
    const barrierIndex = active.findIndex((entry, index) =>
        index > previousBoundary
        && entry.message.role === "user"
        && entry.message.compactionBarrier === true
    );
    if (barrierIndex !== -1) {
        const plan = planAt(active, previousBoundary, barrierIndex);
        if (plan !== undefined) {
            yield plan;
        }
        return;
    }
    const userStarts = active.flatMap((entry, index) =>
        entry.message.role === "user" && index > previousBoundary
            ? [index]
            : []
    );
    for (
        let keep = Math.min(retainedUserTurns, userStarts.length);
        keep >= 1;
        keep -= 1
    ) {
        const suffixStart = userStarts[userStarts.length - keep];
        const plan = suffixStart === undefined
            ? undefined
            : planAt(active, previousBoundary, suffixStart);
        if (plan !== undefined) {
            yield plan;
        }
    }
    // From the previous boundary when it already sits inside the newest turn,
    // which is where a second compaction during one long turn starts. Anchoring
    // on the user message instead would offer no seam at all there, and the
    // turn would go straight to keeping nothing.
    const seamStart = Math.max(
        previousBoundary,
        userStarts[userStarts.length - 1] ?? previousBoundary,
    );
    if (retainedUserTurns > 0) {
        for (let index = seamStart + 1; index < active.length; index += 1) {
            if (active[index]?.message.role !== "assistant") {
                continue;
            }
            const plan = planAt(active, previousBoundary, index);
            if (plan !== undefined) {
                yield plan;
            }
        }
    }
    const last = active[active.length - 1];
    if (last !== undefined && active.length - 1 > previousBoundary) {
        yield {
            boundaryIndex: active.length - 1,
            boundaryId: last.id,
            firstRetainedId: null,
        };
    }
}

/** The boundary directly before `suffixStart`, when it covers anything new. */
function planAt(
    active: readonly SessionMessageEntry[],
    previousBoundary: number,
    suffixStart: number,
): BoundaryPlan | undefined {
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

import type { ModelMessage, ModelUsage } from "../model/types.ts";
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

export const COMPACTION_TRIGGER_FRACTION = 0.82;

export const POST_COMPACTION_TARGET_FRACTION = 0.45;

export const UNKNOWN_CAPACITY_TARGET_FRACTION = 0.35;

export const UNKNOWN_CAPACITY_TRIGGER_TOKENS = 100_000;

function effectiveTriggerTokens(
    capacity: number | undefined,
    trigger?: CompactionTrigger,
): number | undefined {
    if (trigger?.tokens !== undefined) {
        return trigger.tokens;
    }
    return capacity === undefined ? UNKNOWN_CAPACITY_TRIGGER_TOKENS : undefined;
}

export const MIN_SUMMARY_TOKENS = 400;

export const RETAINED_USER_TURNS = 2;

export type CompactionOutcome =
    | { readonly outcome: "not_needed" }
    | { readonly outcome: "no_boundary"; readonly reason: string }
    | { readonly outcome: "rejected"; readonly reason: string }
    | { readonly outcome: "unavailable"; readonly reason: string }
    | { readonly outcome: "cancelled" }
    | { readonly outcome: "busy" }
    | {
        readonly outcome: "compacted";
        readonly before: number;
        readonly after: number;
        readonly model?: string;
        readonly provider?: string;
    };

export interface CompactionBudget {
    readonly trigger?: CompactionTrigger;
    readonly targetTokens?: number;
    readonly postCompactionTargetFraction?: number;
}

export interface CompactionSchedulerOptions {
    readonly store: SessionStore;
    readonly strategy: CompactionStrategyDefinition;
    readonly models: Readonly<Record<string, CompleteText>>;
    readonly model?: string;
    readonly modelContext?: readonly ModelMessage[];
    readonly projectModelContext?: (
        projection: readonly ModelMessage[],
        retained: readonly ModelMessage[],
    ) => readonly ModelMessage[];
    readonly diagnostics?: SessionCompactionDiagnostics;
    readonly trigger?: CompactionTrigger;
    readonly targetTokens?: number;
    readonly postCompactionTargetFraction?: number;
    readonly summaryWordCap?: number;
    readonly retainedUserTurns?: number;
}

export function compactionTargetBudget(
    measurement: ContextMeasurement,
    budget?: CompactionBudget,
): number | undefined {
    if (measurement.capacity !== undefined) {
        return Math.floor(
            measurement.capacity
                * (budget?.postCompactionTargetFraction
                    ?? POST_COMPACTION_TARGET_FRACTION),
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

export interface CompactionTrigger {
    readonly fraction?: number;
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
        return false;
    }
    const fraction = trigger?.fraction ?? COMPACTION_TRIGGER_FRACTION;
    return measurement.tokens >= measurement.capacity * fraction;
}

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

    const modelContext = options.modelContext ?? [
        ...previousProjection,
        ...active.slice(previousBoundary + 1).map((entry) => entry.message),
    ];
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
        if (
            previousRoom !== undefined
            && room < previousRoom + MIN_SUMMARY_TOKENS
        ) {
            continue;
        }
        viable.push({ plan: candidate, targetTokens: room });
    }
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
        if (!outcome.retry) {
            return outcome.result;
        }
        retryable = outcome.result;
    }
    return retryable ?? { outcome: "cancelled" };
}

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

interface AttemptResult {
    readonly result: CompactionOutcome;
    readonly retry: boolean;
}

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
        messages: deepFreeze(structuredClone(span) as ModelMessage[]),
        targetTokens,
        models: options.models,
        ...(options.summaryWordCap === undefined
            ? {}
            : { summaryWordCap: options.summaryWordCap }),
    };

    let projection: readonly ModelMessage[];
    let proposalModel: string | undefined;
    let proposalProvider: string | undefined;
    let proposalUsage: ModelUsage | undefined;
    try {
        const proposal = await options.strategy.compact(request, signal);
        if (signal.aborted) {
            return { result: { outcome: "cancelled" }, retry: false };
        }
        projection = validateProposal(proposal, request);
        proposalModel = proposal.model;
        proposalProvider = proposal.provider;
        proposalUsage = proposal.usage;
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
            ...(proposalUsage === undefined
                    || proposalModel === undefined
                    || proposalProvider === undefined
                ? {}
                : {
                    billed: {
                        provider: proposalProvider,
                        model: proposalModel,
                        usage: proposalUsage,
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

function planAt(
    active: readonly SessionMessageEntry[],
    previousBoundary: number,
    suffixStart: number,
): BoundaryPlan | undefined {
    const boundaryIndex = suffixStart - 1;
    if (boundaryIndex <= previousBoundary) {
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

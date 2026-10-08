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
    // The correction already applied to measurement.tokens; kept messages must be sized in the same units.
    readonly estimateScale?: number;
    // A prompt not yet in the store, already counted in the measurement's overhead.
    readonly pendingPrompt?: boolean;
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
    const triggerTokens = compactionTriggerTokens(measurement.capacity, trigger);
    return triggerTokens !== undefined && measurement.tokens >= triggerTokens;
}

function compactionTriggerTokens(
    capacity: number | undefined,
    trigger?: CompactionTrigger,
): number | undefined {
    const tokens = effectiveTriggerTokens(capacity, trigger);
    if (capacity === undefined) {
        return tokens;
    }
    const share = capacity * (trigger?.fraction ?? COMPACTION_TRIGGER_FRACTION);
    return tokens === undefined ? share : Math.min(tokens, share);
}

function noBoundaryReason(
    hasCandidate: boolean,
    leanestKeptTokens: number | undefined,
    overhead: number,
    triggerTokens: number | undefined,
    capacity: number | undefined,
): string {
    if (!hasCandidate) {
        return "There is not enough finished history to compact yet.";
    }
    if (triggerTokens === undefined) {
        return "The compaction target is too small for a summary.";
    }
    const count = (tokens: number): string =>
        Math.round(tokens).toLocaleString("en-US");
    const raise = capacity === undefined
        ? "Raise compaction.trigger_tokens."
        : "Raise the context limit, or use a model with a larger window.";
    if (overhead >= triggerTokens) {
        return `Instructions and tool definitions take ${count(overhead)}`
            + ` tokens, more than the ${count(triggerTokens)}-token compaction`
            + ` trigger. ${raise}`;
    }
    if (leanestKeptTokens === undefined) {
        return `What must stay word for word plus instructions and tool`
            + ` definitions (${count(overhead)} tokens) leave no room for a`
            + ` summary under the ${count(triggerTokens)}-token compaction`
            + ` trigger. ${raise}`;
    }
    if (overhead + leanestKeptTokens + MIN_SUMMARY_TOKENS >= triggerTokens) {
        return `Instructions and tool definitions (${count(overhead)} tokens)`
            + ` plus the latest messages, which stay word for word`
            + ` (${count(leanestKeptTokens)} tokens), leave no room for a`
            + ` summary under the ${count(triggerTokens)}-token compaction`
            + ` trigger. ${raise}`;
    }
    return "The compaction target is too small for a summary.";
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
        measurement.overheadTokens === undefined
            ? measurement.tokens - contextTokens(modelContext, options)
            : scaledTokens(measurement.overheadTokens, options),
    );

    const viable: { plan: BoundaryPlan; targetTokens: number }[] = [];
    let leanest: { plan: BoundaryPlan; keptTokens: number } | undefined;
    let hasCandidate = false;
    for (
        const candidate of candidateBoundaries(
            active,
            previousBoundary,
            options.retainedUserTurns ?? RETAINED_USER_TURNS,
        )
    ) {
        const kept = active.slice(candidate.boundaryIndex + 1)
            .map((entry) => entry.message);
        const keptContext = options.projectModelContext === undefined
            ? kept
            : options.projectModelContext(previousProjection, kept);
        const keptTokens = contextTokens(keptContext, options);
        hasCandidate = true;
        // Missing the target is only worth it if the prompt being worked on stays word for word.
        const firstKept = active[candidate.boundaryIndex + 1]?.message;
        const keepsTurn = options.pendingPrompt === true
            || (firstKept?.role === "user" && firstKept.internal !== true);
        if (keepsTurn && (leanest === undefined || keptTokens <= leanest.keptTokens)) {
            leanest = { plan: candidate, keptTokens };
        }
        const room = budget - overhead - keptTokens;
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
    const triggerTokens = compactionTriggerTokens(capacity, options.trigger);
    // Overhead or a large prompt can fill the target by itself. Keeping as little as possible still helps if it lands under the trigger.
    if (
        attempts.length === 0
        && leanest !== undefined
        && budget >= MIN_SUMMARY_TOKENS
        && triggerTokens !== undefined
        && overhead + leanest.keptTokens + MIN_SUMMARY_TOKENS < triggerTokens
    ) {
        attempts.push({ plan: leanest.plan, targetTokens: MIN_SUMMARY_TOKENS });
    }
    if (attempts.length === 0) {
        return {
            outcome: "no_boundary",
            reason: noBoundaryReason(
                hasCandidate,
                leanest?.keptTokens,
                overhead,
                triggerTokens,
                capacity,
            ),
        };
    }

    let retryable: CompactionOutcome | undefined;
    for (const [index, attempt] of attempts.entries()) {
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
            lastAttempt: index === attempts.length - 1,
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
    readonly lastAttempt: boolean;
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
    const carried = options.pendingPrompt === true
        ? undefined
        : carriedMessage(active, plan, targetTokens);
    const request: CompactionRequest = {
        messages: deepFreeze(structuredClone(span) as ModelMessage[]),
        targetTokens: carried === undefined
            ? targetTokens
            : targetTokens - measureMessages([carried]),
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
        if (carried !== undefined) {
            projection = [...projection, carried];
        }
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

    const before = contextTokens(modelContext, options) + overhead;
    const afterContext = options.projectModelContext === undefined
        ? [...projection, ...suffix]
        : options.projectModelContext(projection, suffix);
    const after = contextTokens(afterContext, options) + overhead;
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
    // The last rung is kept even over the trigger: an unreachable trigger would otherwise block compaction for good.
    if (!input.lastAttempt && shouldCompact(
        {
            tokens: after,
            ...(capacity === undefined ? {} : { capacity }),
            estimated: measurement.estimated,
        },
        options.trigger,
    )) {
        return {
            result: {
                outcome: "rejected",
                reason: "The compacted context would still be over the "
                    + "compaction trigger, so the next step would compact "
                    + "again.",
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

// While a turn runs, its latest user message stays word for word if the plan would summarize it and a summary still fits beside it.
function carriedMessage(
    active: readonly SessionMessageEntry[],
    plan: BoundaryPlan,
    targetTokens: number,
): ModelMessage | undefined {
    let latest: SessionMessageEntry | undefined;
    let latestIndex = -1;
    for (let index = active.length - 1; index >= 0; index -= 1) {
        const message = active[index]?.message;
        if (
            message?.role === "user"
            && message.internal !== true
            && message.compactionBarrier !== true
            && message.contextSource === undefined
        ) {
            latest = active[index];
            latestIndex = index;
            break;
        }
    }
    if (latest === undefined || latestIndex > plan.boundaryIndex) {
        return undefined;
    }
    // An answered prompt is the summary's to carry; a copy would only make the result bigger.
    const answered = active.slice(latestIndex + 1).some((entry) =>
        entry.message.role === "assistant"
        && entry.message.stopReason === "stop"
    );
    if (answered) {
        return undefined;
    }
    const message = latest.message;
    if (message.role !== "user") {
        return undefined;
    }
    // A projection cannot carry attachment references, so only the words survive.
    const content = message.content.filter((block) => block.type === "text");
    if (content.length === 0) {
        return undefined;
    }
    const copy: ModelMessage = {
        role: "user",
        content: structuredClone(content),
        ...(message.arrivedDuringTurn === true ? { arrivedDuringTurn: true } : {}),
    };
    return targetTokens - measureMessages([copy]) >= MIN_SUMMARY_TOKENS
        ? copy
        : undefined;
}

function contextTokens(
    messages: readonly ModelMessage[],
    options: CompactionSchedulerOptions,
): number {
    return scaledTokens(measureMessages(messages, options.model), options);
}

function scaledTokens(
    tokens: number,
    options: CompactionSchedulerOptions,
): number {
    const scale = options.estimateScale;
    return scale === undefined || !(scale > 1)
        ? tokens
        : Math.ceil(tokens * scale);
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
    // Reminders, attachments and continuations ride inside a turn; counting them would let the real prompt be summarized.
    const userStarts = active.flatMap((entry, index) =>
        entry.message.role === "user"
            && entry.message.internal !== true
            && index > previousBoundary
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

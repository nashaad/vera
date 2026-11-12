import type { ModelMessage, ModelUsage, UserMessage } from "../model/types.ts";
import type {
    SessionCompactionDiagnostics,
    SessionMessageEntry,
    SessionStore,
} from "../store/session-store.ts";
import {
    CompactionRejectedError,
    projectionHoldsPrompt,
    promptWords,
    startsTurn,
    validateProposal,
    workingPrompt,
    type CompactionRequest,
    type CompactionStrategyDefinition,
} from "./compaction.ts";
import {
    CompletionUnavailableError,
    type CompleteText,
} from "./completion-service.ts";
import { measureMessages, type ContextMeasurement } from
    "./context-measurement.ts";
import { resolveCompactionTriggerTokens } from
    "./context-size-trigger-defaults.ts";

export {
    DEFAULT_COMPACTION_TRIGGER_FRACTION as COMPACTION_TRIGGER_FRACTION,
    UNKNOWN_CONTEXT_CAPACITY_TOKENS as UNKNOWN_CAPACITY_TRIGGER_TOKENS,
} from "./context-size-trigger-defaults.ts";

export const POST_COMPACTION_TARGET_FRACTION = 0.45;

export const UNKNOWN_CAPACITY_TARGET_FRACTION = 0.35;

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
    readonly hardLimitTokens?: number;
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
    // The window a request must fit. The target is its share, the result must land under it, and no trigger applies.
    readonly hardLimitTokens?: number;
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
    if (budget?.hardLimitTokens !== undefined) {
        return Math.floor(
            budget.hardLimitTokens
                * (budget.postCompactionTargetFraction
                    ?? POST_COMPACTION_TARGET_FRACTION),
        );
    }
    const target = configuredTargetBudget(measurement, budget);
    const triggerTokens = compactionTriggerTokens(
        measurement.capacity,
        budget?.trigger,
    );
    if (target === undefined || triggerTokens === undefined) {
        return target;
    }
    // A summary sized to a target at or above the trigger fires the trigger again on the next step.
    return target < triggerTokens
        ? target
        : Math.floor(triggerTokens * UNKNOWN_CAPACITY_TARGET_FRACTION);
}

function configuredTargetBudget(
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
    const triggerTokens = compactionTriggerTokens(
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
    return resolveCompactionTriggerTokens(capacity, trigger);
}

interface Ceiling {
    readonly tokens: number | undefined;
    readonly name: "compaction trigger" | "context limit";
}

function noBoundaryReason(
    hasCandidate: boolean,
    leanestKeptTokens: number | undefined,
    overhead: number,
    ceiling: Ceiling,
    capacity: number | undefined,
): string {
    if (!hasCandidate) {
        return "There is not enough finished history to compact yet.";
    }
    const ceilingTokens = ceiling.tokens;
    if (ceilingTokens === undefined) {
        return "The compaction target is too small for a summary.";
    }
    const count = (tokens: number): string =>
        Math.round(tokens).toLocaleString("en-US");
    const limit = `${count(ceilingTokens)}-token ${ceiling.name}`;
    const raise = capacity === undefined
        ? "Raise compaction.trigger_tokens."
        : "Raise the context limit, or use a model with a larger window.";
    if (overhead >= ceilingTokens) {
        return `Instructions and tool definitions take ${count(overhead)}`
            + ` tokens, more than the ${limit}. ${raise}`;
    }
    if (leanestKeptTokens === undefined) {
        return `What must stay word for word plus instructions and tool`
            + ` definitions (${count(overhead)} tokens) leave no room for a`
            + ` summary under the ${limit}. ${raise}`;
    }
    if (overhead + leanestKeptTokens + MIN_SUMMARY_TOKENS >= ceilingTokens) {
        return `Instructions and tool definitions (${count(overhead)} tokens)`
            + ` plus the latest messages, which stay word for word`
            + ` (${count(leanestKeptTokens)} tokens), leave no room for a`
            + ` summary under the ${limit}. ${raise}`;
    }
    return "The compaction target is too small for a summary.";
}

export function compactionBudgetWarning(
    measurement: ContextMeasurement,
    budget?: CompactionBudget,
): string | undefined {
    const target = compactionTargetBudget(measurement, budget);
    return ignoredTargetWarning(measurement, budget, target);
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
    const previous = store.latestCompaction();
    const prefix = previous === undefined ? [] : await carriedPrefix(store, previous.boundaryMessageId);
    const active = [...prefix, ...store.liveMessageEntries()];
    const previousProjection = previous?.projection ?? [];
    const previousBoundary = prefix.length - 1;

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

    const ceiling: Ceiling = options.hardLimitTokens === undefined
        ? {
            tokens: compactionTriggerTokens(capacity, options.trigger),
            name: "compaction trigger",
        }
        : { tokens: options.hardLimitTokens, name: "context limit" };
    const planInput = {
        active,
        previousBoundary,
        previousProjection,
        overhead,
        ceiling,
        options,
    };
    let planned = planAttempts(planInput, budget);
    const unpulled = configuredTargetBudget(measurement, options);
    // A trigger too small to land under is a request to compact anyway, at the target as configured.
    // A hard limit has no trigger, so its budget is already the configured one.
    if (
        planned.attempts.length === 0
        && options.hardLimitTokens === undefined
        && unpulled !== undefined
        && unpulled !== budget
    ) {
        planned = planAttempts(planInput, unpulled);
    }
    const { attempts, leanest, hasCandidate } = planned;
    if (attempts.length === 0) {
        return {
            outcome: "no_boundary",
            reason: noBoundaryReason(
                hasCandidate,
                leanest?.keptTokens,
                overhead,
                ceiling,
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

async function carriedPrefix(store: SessionStore, boundaryId: string): Promise<SessionMessageEntry[]> {
    let answer: SessionMessageEntry | undefined;
    for await (const entry of store.walkMessageAncestors(boundaryId)) {
        const message = entry.message;
        if (answer === undefined && message.role === "assistant" && message.stopReason === "stop") {
            answer = { ...entry, message: { ...message, content: [] } };
        }
        if (message.role === "user" && message.internal !== true
            && message.compactionBarrier !== true && message.contextSource === undefined) {
            return answer === undefined ? [entry] : [entry, answer];
        }
    }
    return [];
}

interface PlanInput {
    readonly active: readonly SessionMessageEntry[];
    readonly previousBoundary: number;
    readonly previousProjection: readonly ModelMessage[];
    readonly overhead: number;
    readonly ceiling: Ceiling;
    readonly options: CompactionSchedulerOptions;
}

interface PlannedAttempts {
    readonly attempts: readonly { plan: BoundaryPlan; targetTokens: number }[];
    readonly leanest: { plan: BoundaryPlan; keptTokens: number } | undefined;
    readonly hasCandidate: boolean;
}

function planAttempts(input: PlanInput, budget: number): PlannedAttempts {
    const {
        active,
        previousBoundary,
        previousProjection,
        overhead,
        ceiling,
        options,
    } = input;
    const viable: { plan: BoundaryPlan; targetTokens: number }[] = [];
    let leanest: { plan: BoundaryPlan; keptTokens: number } | undefined;
    let hasCandidate = false;
    // A prompt-keeping strategy makes its own cut inside its span, so the span's end is the only boundary offered.
    const retainedUserTurns = options.strategy.keepsPrompt === true
        ? 0
        : (options.retainedUserTurns ?? RETAINED_USER_TURNS);
    for (
        const candidate of candidateBoundaries(
            active,
            previousBoundary,
            retainedUserTurns,
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
    // Overhead or a large prompt can fill the target by itself. Keeping as little as possible still helps if it lands under the ceiling.
    if (
        attempts.length === 0
        && leanest !== undefined
        && budget >= MIN_SUMMARY_TOKENS
        && ceiling.tokens !== undefined
        && overhead + leanest.keptTokens + MIN_SUMMARY_TOKENS < ceiling.tokens
    ) {
        attempts.push({ plan: leanest.plan, targetTokens: MIN_SUMMARY_TOKENS });
    }
    return { attempts, leanest, hasCandidate };
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
    // A strategy that keeps the prompt itself gets no carried copy and reserves no room for one.
    const flagged = options.strategy.keepsPrompt === true;
    const carried = options.pendingPrompt === true || flagged
        ? undefined
        : carriedMessage(active, plan, previousBoundary, targetTokens, options);
    const request: CompactionRequest = {
        messages: deepFreeze(structuredClone(span) as ModelMessage[]),
        targetTokens: rawTokens(
            carried === undefined
                ? targetTokens
                : targetTokens - contextTokens([carried], options),
            options,
        ),
        models: options.models,
        previousProjectionCount: previousProjection.length,
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
        const prompt = flagged ? workingPrompt(request.messages)?.message : undefined;
        if (prompt !== undefined && !projectionHoldsPrompt(projection, prompt)) {
            throw new CompactionRejectedError(
                "The compacted context does not hold the prompt being worked on.",
            );
        }
        // A projection that already holds the prompt gets no second copy.
        if (carried !== undefined && !projectionHoldsPrompt(projection, carried)) {
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
    if (options.hardLimitTokens !== undefined && after > options.hardLimitTokens) {
        return {
            result: {
                outcome: "rejected",
                reason: "The compacted context would still be over the "
                    + "context limit.",
            },
            retry: true,
        };
    }
    // The last boundary attempt is kept even over the trigger: an unreachable trigger would otherwise block compaction for good.
    if (options.hardLimitTokens === undefined && !input.lastAttempt && shouldCompact(
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

// While a turn runs, its prompt stays word for word if the plan compacts it and MIN_SUMMARY_TOKENS still fit beside it.
// While an unanswered steer is in the span, the latest user message is carried instead of the prompt.
function carriedMessage(
    active: readonly SessionMessageEntry[],
    plan: BoundaryPlan,
    previousBoundary: number,
    targetTokens: number,
    options: CompactionSchedulerOptions,
): UserMessage | undefined {
    const held = unansweredSteerInSpan(
        active,
        previousBoundary,
        plan.boundaryIndex,
    );
    const chosen = held ? latestCarriable(active) : runningPrompt(active);
    if (chosen === undefined || chosen.index > plan.boundaryIndex) {
        return undefined;
    }
    // An answered prompt is the summary's to carry; a copy would only make the result bigger.
    if (answeredAfter(active, chosen.index)) {
        return undefined;
    }
    const copy = promptWords(chosen.message);
    if (copy === undefined) {
        return undefined;
    }
    return targetTokens - contextTokens([copy], options) >= MIN_SUMMARY_TOKENS
        ? copy
        : undefined;
}

// The newest turn start of the running turn, skipping extension barriers. Undefined once an assistant stop follows it.
function runningPrompt(
    active: readonly SessionMessageEntry[],
): { readonly index: number; readonly message: UserMessage } | undefined {
    for (let index = active.length - 1; index >= 0; index -= 1) {
        const message = active[index]?.message;
        if (message === undefined) {
            continue;
        }
        if (message.role === "assistant" && message.stopReason === "stop") {
            return undefined;
        }
        if (startsTurn(message) && message.compactionBarrier !== true) {
            return { index, message };
        }
    }
    return undefined;
}

// The newest user message that is not extension context.
function latestCarriable(
    active: readonly SessionMessageEntry[],
): { readonly index: number; readonly message: UserMessage } | undefined {
    for (let index = active.length - 1; index >= 0; index -= 1) {
        const message = active[index]?.message;
        if (
            message?.role === "user"
            && message.internal !== true
            && message.compactionBarrier !== true
            && message.contextSource === undefined
        ) {
            return { index, message };
        }
    }
    return undefined;
}

// A steer inside the span that no assistant stop follows.
function unansweredSteerInSpan(
    active: readonly SessionMessageEntry[],
    previousBoundary: number,
    boundaryIndex: number,
): boolean {
    for (let index = previousBoundary + 1; index <= boundaryIndex; index += 1) {
        const message = active[index]?.message;
        if (
            message?.role === "user"
            && message.arrivedDuringTurn === true
            && !answeredAfter(active, index)
        ) {
            return true;
        }
    }
    return false;
}

function answeredAfter(
    active: readonly SessionMessageEntry[],
    index: number,
): boolean {
    return active.slice(index + 1).some((entry) =>
        entry.message.role === "assistant"
        && entry.message.stopReason === "stop"
    );
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

// validateProposal measures raw tokens, so a room in scaled units is handed over in raw units.
function rawTokens(
    tokens: number,
    options: CompactionSchedulerOptions,
): number {
    const scale = options.estimateScale;
    return scale === undefined || !(scale > 1)
        ? tokens
        : Math.floor(tokens / scale);
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
    // Reminders, attachments, continuations and steers ride inside a turn; counting them would let the real prompt be summarized.
    const userStarts = active.flatMap((entry, index) =>
        index > previousBoundary && turnStart(active, index)
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

// A queued user message starts a turn once an assistant stop answers it.
function turnStart(
    active: readonly SessionMessageEntry[],
    index: number,
): boolean {
    const message = active[index]?.message;
    if (
        message === undefined
        || message.role !== "user"
        || message.internal === true
    ) {
        return false;
    }
    if (message.arrivedDuringTurn !== true) {
        return true;
    }
    for (let after = index + 1; after < active.length; after += 1) {
        const next = active[after]?.message;
        if (next?.role === "user" && next.internal !== true) {
            return false;
        }
        if (next?.role === "assistant" && next.stopReason === "stop") {
            return true;
        }
    }
    return false;
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

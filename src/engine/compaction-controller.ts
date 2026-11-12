import { join } from "node:path";

import type { ModelMessage } from "../model/types.ts";
import {
    SessionStore,
    type SessionMessageStore,
} from "../store/session-store.ts";
import {
    compactionBudgetWarning,
    compactSession,
    COMPACTION_TRIGGER_FRACTION,
    UNKNOWN_CAPACITY_TRIGGER_TOKENS,
    type CompactionOutcome,
    type CompactionTrigger,
} from "./compaction-scheduler.ts";
import {
    createContextSizeTriggerSet,
    type ContextSizeTrigger,
    type ContextSizeTriggerReport,
} from "./context-size-triggers.ts";
import {
    defaultContextSizePolicies,
    DEFAULT_COMPACTION_RETRY_GROWTH_TOKENS,
} from "./context-size-trigger-defaults.ts";
import {
    measureMessages,
    type ContextMeasurement,
} from "./context-measurement.ts";
import type { EngineEventBus } from "./events.ts";
import type { HistoryLineage } from "./prompt-history-drift.ts";
import type { LoopCompactionState } from "./host-protocol.ts";
import type { InboundCommandRouter } from "./inbound-command-router.ts";
import {
    availableModels,
    budgetContextWindow,
    contextWindowForModel,
    type ModelTurnSettings,
} from "./model-settings.ts";
import type {
    CompactionContext,
    CompactionTurnLink,
    ContextWatch,
    SessionCompactionOptions,
    SessionCompactionRung,
    WindowCheck,
    WindowStop,
} from "./run-turn.ts";
import {
    assembleAgedToolResults,
    toolResultAgingGateFraction,
    toolResultTotalBudgetBytes,
    type ToolResultAgingPolicy,
    type ToolResultLimits,
} from "./tool-result-history.ts";
import { SPILL_DIRECTORY_NAME } from "./tool-result-spill.ts";

export {
    DEFAULT_COMPACTION_RETRY_GROWTH_TOKENS as COMPACTION_RETRY_GROWTH_TOKENS,
} from "./context-size-trigger-defaults.ts";

// Stop texts for a request held at the context limit. The rung lines follow WINDOW_FAILED.
const WINDOW_FAILED = "Compaction failed, so the request was not sent.";
const WINDOW_UNBOUND = "Compaction could not run, so the request was not sent. No compaction strategy is bound for this session.";
const WINDOW_STILL_OVER = "Compaction ran, but the context is still over the context limit, so the request was not sent.";

export interface CompactionControllerOptions {
    readonly store: SessionStore;
    readonly model: string;
    readonly scratchDir: string;
    readonly events: EngineEventBus;
    readonly readCompaction: () => SessionCompactionOptions | undefined;
    readonly readToolResults: () => ToolResultLimits | undefined;
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly readAnnouncedCompaction?: () => LoopCompactionState | undefined;
    readonly inbound: Pick<
        InboundCommandRouter,
        "beginAutomaticCompaction" | "endAutomaticCompaction"
    >;
    // Puts back context the summary may have dropped; true when it added a message.
    readonly afterCompacted: () => Promise<boolean>;
}

export interface CompactionController {
    readonly contextWatch: ContextWatch;
    modelContext(context?: CompactionContext): readonly ModelMessage[];
    historyLineage(): HistoryLineage;
    compact(
        signal: AbortSignal,
        force?: boolean,
        pendingMessages?: readonly ModelMessage[],
        context?: CompactionContext,
        turn?: CompactionTurnLink,
    ): Promise<void>;
    // Runs the ladder when the context is over the effective window. Undefined sends the request; landed builds it again.
    enforceWindow(
        signal: AbortSignal,
        context?: CompactionContext,
        turn?: CompactionTurnLink,
    ): Promise<WindowCheck | undefined>;
}

type CompactedOutcome = Extract<CompactionOutcome, { readonly outcome: "compacted" }>;

interface LadderRun {
    readonly signal: AbortSignal;
    readonly force: boolean;
    readonly measurement: ContextMeasurement;
    readonly announced: LoopCompactionState | undefined;
    readonly compactionModel: string;
    readonly modelContext: readonly ModelMessage[];
    readonly estimateScale: number | undefined;
    readonly hasPendingUserTurn: boolean;
    readonly pendingMessages: readonly ModelMessage[];
    readonly context: CompactionContext | undefined;
    readonly turn: CompactionTurnLink | undefined;
    // Set by the window check: the request must fit this limit, and the trigger does not apply.
    readonly hardLimitTokens?: number;
}

export function createCompactionController(
    options: CompactionControllerOptions,
): CompactionController {
    const { store, model, events, readModelSettings } = options;
    const contextWatch: ContextWatch = {};
    // The same projection on a later request reports nothing again.
    const reportedTriggers = new Map<string, string>();
    const reportTrigger = (report: ContextSizeTriggerReport): void => {
        const key = `${report.action}:${report.trigger.policy?.id ?? ""}`;
        if (reportedTriggers.get(key) === report.fingerprint) return;
        reportedTriggers.set(key, report.fingerprint);
        events.emit({
            type: "context_size_trigger",
            reason: report.trigger.reason,
            ...(report.trigger.policy === undefined
                ? {}
                : {
                    policy: {
                        id: report.trigger.policy.id,
                        kind: report.trigger.policy.kind,
                    },
                }),
            actions: [report.action],
            tokens: report.trigger.tokens,
            tokensAfter: report.tokensAfter,
            ...(report.trigger.capacity === undefined
                ? {}
                : { capacity: report.trigger.capacity }),
        });
    };
    // A failed automatic compaction must not turn every later tool boundary into another request to the same unavailable route.
    let automaticCompactionBlocked = false;
    let automaticCompactionBlockedAt: number | undefined;
    let latchedAssignmentKey: string | undefined;
    let latchedCapacity: number | undefined;
    const compactionCapacity = (
        context?: CompactionContext,
    ): number | undefined => {
        if (context?.capacity !== undefined) {
            return context.capacity;
        }
        const settings = readModelSettings?.();
        const declared = settings?.contextWindow
            ?? contextWindowForModel(
                settings?.provider,
                settings?.model ?? model,
                settings?.availableModels,
                availableModels(),
            );
        return budgetContextWindow(declared, settings?.contextLimit);
    };
    const fixedOverhead = (): number => {
        if (contextWatch.overheadTokens === undefined) {
            contextWatch.overheadTokens = recordedOverhead(store);
        }
        return contextWatch.overheadTokens;
    };
    const spillDirectory = join(options.scratchDir, SPILL_DIRECTORY_NAME);
    const agingPolicy = (
        context?: CompactionContext,
        pendingMessages: readonly ModelMessage[] = [],
    ): ToolResultAgingPolicy => {
        const capacity = compactionCapacity(context);
        const pendingUserTurns = pendingMessages.filter((message) =>
            message.role === "user" && message.internal !== true
        ).length;
        const limits = options.readToolResults();
        return {
            overheadTokens: fixedOverhead() + measureMessages(pendingMessages),
            spillDirectory,
            ...(capacity === undefined ? {} : { capacity }),
            ...(pendingUserTurns === 0 ? {} : { pendingUserTurns }),
            ...(limits?.agingLevel === undefined
                ? {}
                : { level: limits.agingLevel }),
            ...(limits?.stubAfterTurns === undefined
                ? {}
                : { ageAfterTurns: limits.stubAfterTurns }),
            budgetBytes: limits?.totalBudgetBytes
                ?? toolResultTotalBudgetBytes(capacity),
        };
    };
    let lastRawEstimate = 0;
    const measureContextNow = (
        pendingMessages: readonly ModelMessage[] = [],
        context?: CompactionContext,
    ): ContextMeasurement => {
        const capacity = compactionCapacity(context);
        const modelContext = store.modelContext(
            agingPolicy(context, pendingMessages),
        );
        const measuredModel = context?.model ?? readModelSettings?.().model ?? model;
        // Pending messages are not in the store yet, so a compaction plan can only budget for them as overhead.
        const overheadTokens = fixedOverhead()
            + measureMessages(pendingMessages, measuredModel);
        const estimate = measureMessages(modelContext, measuredModel)
            + overheadTokens;
        lastRawEstimate = estimate;
        return {
            overheadTokens,
            tokens: Math.ceil(estimate * (watchedScale(contextWatch, measuredModel) ?? 1)),
            ...(capacity === undefined ? {} : { capacity }),
            estimated: true,
        };
    };
    let budgetWarned = false;
    const budgetWarning = (
        measurement: ContextMeasurement,
        compaction: SessionCompactionOptions,
    ): { readonly warning: string } | undefined => {
        if (budgetWarned) {
            return undefined;
        }
        const warning = compactionBudgetWarning(measurement, compaction);
        if (warning === undefined) {
            return undefined;
        }
        budgetWarned = true;
        return { warning };
    };
    const attemptRung = async (
        compaction: SessionCompactionOptions,
        rung: SessionCompactionRung,
        index: number,
        run: LadderRun,
    ): Promise<CompactionOutcome> => {
        // The loop's announced model describes rung 0 only.
        const summarizerModel = (index === 0 ? run.announced?.model : undefined)
            ?? rung.diagnostics?.model
            ?? run.compactionModel;
        const summarizerProvider = (index === 0
            ? run.announced?.provider
            : undefined) ?? rung.diagnostics?.provider;
        events.emit({
            type: "compaction_started",
            strategy: rung.strategy.id,
            ...(summarizerProvider === undefined
                ? {}
                : { provider: summarizerProvider }),
            model: summarizerModel,
            ...(budgetWarning(run.measurement, compaction) ?? {}),
            trigger: run.force ? "manual" : "automatic",
            tokens: run.measurement.tokens,
            ...(run.measurement.capacity === undefined
                ? {}
                : { capacity: run.measurement.capacity }),
        });
        const request: Parameters<typeof compactSession>[0] = {
            store,
            strategy: rung.strategy,
            models: rung.models,
            model: run.compactionModel,
            modelContext: run.modelContext,
            projectModelContext: (projection, retained) =>
                assembleAgedToolResults(
                    [...projection, ...retained].map((message) => ({
                        message,
                    })),
                    agingPolicy(run.context, run.pendingMessages),
                ),
            ...(rung.diagnostics === undefined
                ? {}
                : { diagnostics: rung.diagnostics }),
            ...(compaction.trigger === undefined
                ? {}
                : { trigger: compaction.trigger }),
            ...(compaction.targetTokens === undefined
                ? {}
                : { targetTokens: compaction.targetTokens }),
            ...(compaction.postCompactionTargetFraction === undefined
                ? {}
                : {
                    postCompactionTargetFraction:
                        compaction.postCompactionTargetFraction,
                }),
            ...(compaction.summaryWordCap === undefined
                ? {}
                : { summaryWordCap: compaction.summaryWordCap }),
            ...(compaction.retainedUserTurns === undefined
                ? {}
                : { retainedUserTurns: compaction.retainedUserTurns }),
            ...(run.estimateScale === undefined
                ? {}
                : { estimateScale: run.estimateScale }),
            ...(run.hardLimitTokens === undefined
                ? {}
                : { hardLimitTokens: run.hardLimitTokens }),
            ...(run.hasPendingUserTurn ? { pendingPrompt: true } : {}),
        };
        if (run.turn !== undefined) {
            options.inbound.beginAutomaticCompaction(run.turn.controller);
        }
        let result: Awaited<ReturnType<typeof compactSession>>;
        try {
            result = await compactSession(request, run.measurement, run.signal);
        } finally {
            if (run.turn !== undefined) {
                options.inbound.endAutomaticCompaction(run.turn.controller);
            }
        }
        const resultModel = result.outcome === "compacted"
            ? result.model
            : undefined;
        const resultProvider = result.outcome === "compacted"
            ? result.provider
            : undefined;
        const reportedProvider = resultProvider ?? summarizerProvider;
        events.emit({
            type: "compaction_finished",
            strategy: rung.strategy.id,
            ...(reportedProvider === undefined
                ? {}
                : { provider: reportedProvider }),
            model: resultModel ?? summarizerModel,
            outcome: result.outcome,
            ...(result.outcome === "cancelled"
                    && run.turn?.turnSignal.aborted === true
                ? { stoppedWithTurn: true }
                : {}),
            ...("reason" in result ? { reason: result.reason } : {}),
            ...(result.outcome === "compacted"
                ? { before: result.before, after: result.after }
                : {}),
        });
        return result;
    };
    // The first rung that lands ends the walk. Cancelled and not_needed end it without a handover.
    const runLadder = async (
        compaction: SessionCompactionOptions,
        run: LadderRun,
    ): Promise<readonly CompactionOutcome[]> => {
        const attempts: CompactionOutcome[] = [];
        for (const [index, rung] of compaction.rungs.entries()) {
            const outcome = await attemptRung(compaction, rung, index, run);
            attempts.push(outcome);
            if (
                outcome.outcome === "compacted"
                || outcome.outcome === "cancelled"
                || outcome.outcome === "not_needed"
            ) {
                break;
            }
        }
        return attempts;
    };
    // Clears the latch, puts back context the summary dropped, and reports the size after the compaction.
    const landCompaction = async (
        compaction: SessionCompactionOptions,
        landed: CompactedOutcome,
        measurement: ContextMeasurement,
        compactionModel: string,
        pendingMessages: readonly ModelMessage[],
        context: CompactionContext | undefined,
    ): Promise<ContextMeasurement> => {
        automaticCompactionBlocked = false;
        automaticCompactionBlockedAt = undefined;
        latchedAssignmentKey = undefined;
        latchedCapacity = undefined;
        const contextAdded = await options.afterCompacted();
        const refreshedMeasurement: ContextMeasurement = {
            ...(contextAdded ? measureContextNow(pendingMessages, context) : {
                tokens: landed.after,
                ...(measurement.capacity === undefined
                    ? {}
                    : { capacity: measurement.capacity }),
                estimated: measurement.estimated,
            }),
            compaction: contextCompactionPolicy(
                compaction.trigger,
                measurement.capacity,
            ),
        };
        events.emit({
            type: "context_measured",
            model: compactionModel,
            measurement: refreshedMeasurement,
        });
        return refreshedMeasurement;
    };
    const compact = async (
        signal: AbortSignal,
        force = false,
        pendingMessages: readonly ModelMessage[] = [],
        context?: CompactionContext,
        turn?: CompactionTurnLink,
    ): Promise<void> => {
        const compaction = options.readCompaction();
        if (compaction === undefined) {
            return;
        }
        const hasPendingUserTurn = pendingMessages.some((message) =>
            message.role === "user" && message.internal !== true
        );
        const measurement = measureContextNow(pendingMessages, context);
        const announced = options.readAnnouncedCompaction?.();
        const assignmentKey = compactionAssignmentKey(compaction, announced);
        // Over the effective window, the hard check before each request runs the ladder instead.
        if (!force && isOverWindow(measurement)) {
            return;
        }
        // A failed automatic compaction stops the retry loop, but it must not stop compaction for the rest of the session.
        // Below the window, a failed attempt is retried after the context grows by DEFAULT_COMPACTION_RETRY_GROWTH_TOKENS, or when the route or window changes.
        if (!force && automaticCompactionBlocked) {
            const assignmentChanged = latchedAssignmentKey !== assignmentKey;
            const capacityChanged = latchedCapacity !== measurement.capacity;
            if (
                !assignmentChanged
                && !capacityChanged
                && !contextWatch.refusedForSize
                && (automaticCompactionBlockedAt === undefined
                    || lastRawEstimate < automaticCompactionBlockedAt
                        + DEFAULT_COMPACTION_RETRY_GROWTH_TOKENS)
            ) {
                return;
            }
            automaticCompactionBlocked = false;
            automaticCompactionBlockedAt = undefined;
            latchedAssignmentKey = undefined;
            latchedCapacity = undefined;
        }
        const compactionModel = context?.model
            ?? readModelSettings?.().model
            ?? model;
        let firedPolicy: ContextSizeTrigger | undefined;
        if (!force && !contextWatch.refusedForSize) {
            const triggers = createContextSizeTriggerSet(
                defaultContextSizePolicies({
                    capacity: measurement.capacity,
                    trimGateFraction: toolResultAgingGateFraction(
                        measurement.capacity,
                        options.readToolResults()?.agingLevel,
                    ),
                    ...(compaction.trigger === undefined
                        ? {}
                        : { compactionTrigger: compaction.trigger }),
                }),
            );
            const fired = triggers.fire("compact", {
                tokens: measurement.tokens,
                ...(measurement.capacity === undefined
                    ? {}
                    : { capacity: measurement.capacity }),
            });
            if (fired === undefined) {
                return;
            }
            firedPolicy = fired;
        }
        contextWatch.refusedForSize = false;
        const attempts = await runLadder(compaction, {
            signal,
            force,
            measurement,
            announced,
            compactionModel,
            modelContext: store.modelContext(
                agingPolicy(context, pendingMessages),
            ),
            estimateScale: watchedScale(contextWatch, compactionModel),
            hasPendingUserTurn,
            pendingMessages,
            context,
            turn,
        });
        const landed = attempts.at(-1);
        if (landed?.outcome === "compacted") {
            await landCompaction(
                compaction,
                landed,
                measurement,
                compactionModel,
                pendingMessages,
                context,
            );
            if (firedPolicy !== undefined) {
                reportTrigger({
                    trigger: firedPolicy,
                    action: "compact",
                    tokensAfter: landed.after,
                    fingerprint: `compacted:${store.latestCompaction()?.id ?? landed.after}`,
                });
            }
            return;
        }
        const turnStopped = turn?.turnSignal.aborted === true;
        if (
            !force
            && attempts.some((outcome) =>
                latchesAutomatic(outcome, hasPendingUserTurn, turnStopped)
            )
        ) {
            // Cancelled attempts latch unless the turn itself was stopped.
            automaticCompactionBlocked = true;
            automaticCompactionBlockedAt = lastRawEstimate;
            latchedAssignmentKey = assignmentKey;
            latchedCapacity = measurement.capacity;
        }
    };
    // Runs before every model request. Unlike the automatic path, it ignores the latch and the trigger, and sets no latch.
    const enforceWindow = async (
        signal: AbortSignal,
        context?: CompactionContext,
        turn?: CompactionTurnLink,
    ): Promise<WindowCheck | undefined> => {
        const measurement = measureContextNow([], context);
        const capacity = measurement.capacity;
        if (capacity === undefined || measurement.tokens <= capacity) {
            return undefined;
        }
        const compaction = options.readCompaction();
        if (compaction === undefined) {
            return { outcome: "failed", message: WINDOW_UNBOUND };
        }
        const compactionModel = context?.model
            ?? readModelSettings?.().model
            ?? model;
        // A size refusal is consumed by the next compaction attempt, as on the automatic path.
        contextWatch.refusedForSize = false;
        const attempts = await runLadder(compaction, {
            signal,
            force: false,
            measurement,
            announced: options.readAnnouncedCompaction?.(),
            compactionModel,
            modelContext: store.modelContext(agingPolicy(context)),
            estimateScale: watchedScale(contextWatch, compactionModel),
            hasPendingUserTurn: false,
            pendingMessages: [],
            context,
            turn,
            hardLimitTokens: capacity,
        });
        const landed = attempts.at(-1);
        if (landed?.outcome === "compacted") {
            const refreshed = await landCompaction(
                compaction,
                landed,
                measurement,
                compactionModel,
                [],
                context,
            );
            return refreshed.tokens <= capacity
                ? { outcome: "landed" }
                : { outcome: "failed", message: WINDOW_STILL_OVER };
        }
        if (landed?.outcome === "cancelled") {
            return { outcome: "cancelled" };
        }
        return {
            outcome: "failed",
            message: windowFailureMessage(compaction.rungs, attempts),
        };
    };
    return {
        contextWatch,
        modelContext: (context) => store.modelContext({
            ...agingPolicy(context),
            reportTrigger,
        }),
        historyLineage: () => {
            const compactionId = store.latestCompaction()?.id;
            return {
                ...(compactionId === undefined ? {} : { compactionId }),
                messageIds: store.liveMessageEntries().map((entry) => entry.id),
            };
        },
        compact,
        enforceWindow,
    };
}

function latchesAutomatic(
    outcome: CompactionOutcome,
    hasPendingUserTurn: boolean,
    turnStopped: boolean,
): boolean {
    switch (outcome.outcome) {
        case "compacted":
        case "not_needed":
            return false;
        case "cancelled":
            return !turnStopped;
        case "no_boundary":
            return !hasPendingUserTurn;
        case "rejected":
        case "unavailable":
        case "busy":
            return true;
    }
}

// Each rung that ran reports its failure in rung order, so the rung at index i is the one that produced attempt i.
function windowFailureMessage(
    rungs: readonly SessionCompactionRung[],
    attempts: readonly CompactionOutcome[],
): string {
    const failures = attempts.map((attempt, index) =>
        `${rungs[index]?.strategy.id ?? "compaction"}: ${outcomeSentence(attempt)}`
    );
    return [WINDOW_FAILED, ...failures].join(" ");
}

function outcomeSentence(outcome: CompactionOutcome): string {
    switch (outcome.outcome) {
        case "no_boundary":
        case "rejected":
        case "unavailable":
            return outcome.reason.endsWith(".")
                ? outcome.reason
                : `${outcome.reason}.`;
        case "busy":
            return "Another compaction was already running.";
        case "cancelled":
            return "Cancelled.";
        case "not_needed":
        case "compacted":
            return "Did not compact.";
    }
}

function isOverWindow(measurement: ContextMeasurement): boolean {
    return measurement.capacity !== undefined
        && measurement.tokens > measurement.capacity;
}

function compactionAssignmentKey(
    compaction: SessionCompactionOptions,
    announced: LoopCompactionState | undefined,
): string {
    return compaction.rungs.map((rung, index) => {
        const named = index === 0 ? announced : undefined;
        return [
            named?.strategy ?? rung.strategy.id,
            named?.provider ?? rung.diagnostics?.provider ?? "",
            named?.model ?? rung.diagnostics?.model ?? "",
            rung.diagnostics?.catalogEntry ?? "",
        ].join("\0");
    }).join("\u0001");
}

// A resumed session has made no request yet, so the last recorded request stands in for the system prompt and tools.
function recordedOverhead(store: SessionMessageStore): number {
    if (!(store instanceof SessionStore)) {
        return 0;
    }
    const components = store.latestContextMeasurement()?.projection?.components ?? [];
    return components
        .filter((component) => component.kind !== "message")
        .reduce((total, component) => total + component.estimatedTokens, 0);
}

export function contextCompactionPolicy(
    trigger: CompactionTrigger | undefined,
    capacity: number | undefined,
): {
    readonly triggerFraction: number;
    readonly triggerTokens?: number;
} {
    return {
        triggerFraction: trigger?.fraction ?? COMPACTION_TRIGGER_FRACTION,
        ...(trigger?.tokens === undefined && capacity !== undefined
            ? {}
            : {
                triggerTokens: trigger?.tokens
                    ?? UNKNOWN_CAPACITY_TRIGGER_TOKENS,
            }),
    };
}

export function watchedScale(
    watch: ContextWatch | undefined,
    model: string,
): number | undefined {
    return watch?.scaleModel === model ? watch.scale : undefined;
}

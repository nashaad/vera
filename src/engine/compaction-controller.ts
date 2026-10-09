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
    shouldCompact,
    type CompactionTrigger,
} from "./compaction-scheduler.ts";
import {
    measureMessages,
    type ContextMeasurement,
} from "./context-measurement.ts";
import type { EngineEventBus } from "./events.ts";
import type { LoopCompactionState } from "./host-protocol.ts";
import type { InboundCommandRouter } from "./inbound-command-router.ts";
import {
    budgetContextWindow,
    contextWindowForModel,
    type ModelTurnSettings,
} from "./model-settings.ts";
import type {
    CompactionContext,
    CompactionTurnLink,
    ContextWatch,
    SessionCompactionOptions,
} from "./run-turn.ts";
import {
    assembleAgedToolResults,
    type ToolResultAgingPolicy,
    type ToolResultLimits,
} from "./tool-result-history.ts";
import { SPILL_DIRECTORY_NAME } from "./tool-result-spill.ts";

// How far the context must grow past a failed automatic compaction before another one is tried.
export const COMPACTION_RETRY_GROWTH_TOKENS = 10_000;

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
    compact(
        signal: AbortSignal,
        force?: boolean,
        pendingMessages?: readonly ModelMessage[],
        context?: CompactionContext,
        turn?: CompactionTurnLink,
    ): Promise<void>;
}

export function createCompactionController(
    options: CompactionControllerOptions,
): CompactionController {
    const { store, model, events, readModelSettings } = options;
    const contextWatch: ContextWatch = {};
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
            ...(limits?.totalBudgetBytes === undefined
                ? {}
                : { budgetBytes: limits.totalBudgetBytes }),
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
        // A failed automatic compaction stops the retry loop, but it must not stop compaction for the rest of the session.
        // Being over the window is not a change: it is what failed, and retrying it at every tool step is the loop.
        if (!force && automaticCompactionBlocked) {
            const assignmentChanged = latchedAssignmentKey !== assignmentKey;
            const capacityChanged = latchedCapacity !== measurement.capacity;
            if (
                !assignmentChanged
                && !capacityChanged
                && !contextWatch.refusedForSize
                && (automaticCompactionBlockedAt === undefined
                    || lastRawEstimate < automaticCompactionBlockedAt
                        + COMPACTION_RETRY_GROWTH_TOKENS)
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
        const summarizerModel = announced?.model
            ?? compaction.diagnostics?.model
            ?? compactionModel;
        const summarizerProvider = announced?.provider
            ?? compaction.diagnostics?.provider;
        if (
            !force
            && !contextWatch.refusedForSize
            && !shouldCompact(measurement, compaction.trigger)
        ) {
            return;
        }
        contextWatch.refusedForSize = false;
        events.emit({
            type: "compaction_started",
            strategy: compaction.strategy.id,
            ...(summarizerProvider === undefined
                ? {}
                : { provider: summarizerProvider }),
            model: summarizerModel,
            ...(budgetWarning(measurement, compaction) ?? {}),
            trigger: force ? "manual" : "automatic",
            tokens: measurement.tokens,
            ...(measurement.capacity === undefined
                ? {}
                : { capacity: measurement.capacity }),
        });
        const modelContext = store.modelContext(
            agingPolicy(context, pendingMessages),
        );
        const estimateScale = watchedScale(contextWatch, compactionModel);
        const compactionRequest:
            Parameters<typeof compactSession>[0] = {
            store,
            strategy: compaction.strategy,
            models: compaction.models,
            model: compactionModel,
            modelContext,
            projectModelContext: (projection, retained) =>
                assembleAgedToolResults(
                    [...projection, ...retained].map((message) => ({
                        message,
                    })),
                    agingPolicy(context, pendingMessages),
                ),
            ...(compaction.diagnostics === undefined
                ? {}
                : { diagnostics: compaction.diagnostics }),
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
            ...(estimateScale === undefined ? {} : { estimateScale }),
            ...(hasPendingUserTurn ? { pendingPrompt: true } : {}),
        };
        if (turn !== undefined) {
            options.inbound.beginAutomaticCompaction(turn.controller);
        }
        let result: Awaited<ReturnType<typeof compactSession>>;
        try {
            result = await compactSession(
                compactionRequest,
                measurement,
                signal,
            );
        } finally {
            if (turn !== undefined) {
                options.inbound.endAutomaticCompaction(turn.controller);
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
            strategy: compaction.strategy.id,
            ...(reportedProvider === undefined
                ? {}
                : { provider: reportedProvider }),
            model: resultModel ?? summarizerModel,
            outcome: result.outcome,
            ...(result.outcome === "cancelled"
                    && turn?.turnSignal.aborted === true
                ? { stoppedWithTurn: true }
                : {}),
            ...("reason" in result ? { reason: result.reason } : {}),
            ...(result.outcome === "compacted"
                ? { before: result.before, after: result.after }
                : {}),
        });
        const stoppedWithTurn = result.outcome === "cancelled"
            && turn?.turnSignal.aborted === true;
        if (
            !force
            && result.outcome !== "compacted"
            && result.outcome !== "not_needed"
            && !stoppedWithTurn
            && !(result.outcome === "no_boundary" && hasPendingUserTurn)
        ) {
            // Cancelled latches with the failures. Without this the next tool boundary opens another compaction and the user is pressing escape every few seconds.
            automaticCompactionBlocked = true;
            automaticCompactionBlockedAt = lastRawEstimate;
            latchedAssignmentKey = assignmentKey;
            latchedCapacity = measurement.capacity;
        }
        if (result.outcome === "compacted") {
            automaticCompactionBlocked = false;
            automaticCompactionBlockedAt = undefined;
            latchedAssignmentKey = undefined;
            latchedCapacity = undefined;
            const contextAdded = await options.afterCompacted();
            const refreshedMeasurement: ContextMeasurement = {
                ...(contextAdded ? measureContextNow(pendingMessages, context) : {
                    tokens: result.after,
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
        }
    };
    return {
        contextWatch,
        modelContext: (context) => store.modelContext(agingPolicy(context)),
        compact,
    };
}

function compactionAssignmentKey(
    compaction: SessionCompactionOptions,
    announced: LoopCompactionState | undefined,
): string {
    return [
        announced?.strategy ?? compaction.strategy.id,
        announced?.provider ?? compaction.diagnostics?.provider ?? "",
        announced?.model ?? compaction.diagnostics?.model ?? "",
        compaction.diagnostics?.catalogEntry ?? "",
    ].join("\0");
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

import type {
    ModelAdapter,
    ModelReasoningEffort,
} from "../model/types.ts";
import type {
    ResolvedCompactionProfile,
    ResolvedCompactionRung,
    VeraCatalogModel,
} from "../config/model-catalog.ts";
import type { CompactionStrategyDefinition } from "./compaction.ts";
import type { CompactionTrigger } from "./compaction-scheduler.ts";
import {
    FULL_SUMMARY_STRATEGY_ID,
    fullSummaryStrategy,
} from "./compaction-full-summary.ts";
import {
    DROP_OLDEST_STRATEGY_ID,
    dropOldestStrategy,
} from "./compaction-drop-oldest.ts";
import {
    createRoutedCompletionService,
    type CompleteText,
    type CompletionModel,
} from "./completion-service.ts";
import {
    availableModels,
    contextWindowForModel,
    type ModelWindowEntry,
} from "./model-settings.ts";
import type {
    SessionCompactionOptions,
    SessionCompactionRung,
} from "./run-turn.ts";
import type { SessionCompactionDiagnostics } from "../store/session-store.ts";

type NonEmptyRungs = readonly [
    SessionCompactionRung,
    ...SessionCompactionRung[],
];

export const BUNDLED_COMPACTION_STRATEGIES:
    readonly CompactionStrategyDefinition[] = [
        fullSummaryStrategy,
        dropOldestStrategy,
    ];

export const COMPACTION_MAX_OUTPUT_TOKENS = 32_768;

export const DEFAULT_COMPACTION_STRATEGY_ID = FULL_SUMMARY_STRATEGY_ID;

/** The rungs used when a config declares no ladder, in the order they are tried. */
export const DEFAULT_COMPACTION_LADDER: readonly string[] = [
    FULL_SUMMARY_STRATEGY_ID,
    DROP_OLDEST_STRATEGY_ID,
];

export interface SessionModel {
    readonly provider?: string;
    readonly model: string;
}

export function bindCompaction(
    profile: ResolvedCompactionProfile | undefined,
    adapter: ModelAdapter,
    sessionModel: SessionModel | undefined,
    strategies: readonly CompactionStrategyDefinition[],
    slotModels?: readonly VeraCatalogModel[],
    overrides?: CompactionOverrides,
    windows: readonly ModelWindowEntry[] = availableModels(),
): SessionCompactionOptions | undefined {
    const assignment = slotModels !== undefined && slotModels.length > 0
        ? slotModels
        : undefined;
    if (profile === undefined && assignment === undefined) {
        return sessionModel === undefined
            ? undefined
            : withOverrides(
                bindDefault(adapter, sessionModel, strategies),
                overrides,
            );
    }
    const ladder = profile?.ladder ?? DEFAULT_COMPACTION_LADDER.map(
        (strategy): ResolvedCompactionRung => ({
            strategy,
            slots: {},
            routes: {},
        }),
    );
    // A rung that does not bind fails the whole binding.
    const bound: SessionCompactionRung[] = [];
    for (const rung of ladder) {
        const rungBinding = bindRung(
            adapter,
            rung,
            assignment,
            strategies,
            windows,
        );
        if (rungBinding === undefined) {
            return undefined;
        }
        bound.push(rungBinding);
    }
    const rungs = nonEmpty(bound);
    if (rungs === undefined) {
        return undefined;
    }
    const trigger = triggerBounds(
        profile?.trigger_fraction,
        profile?.trigger_tokens,
    );
    const targetTokens = profile?.target_tokens;
    const retainedUserTurns = profile?.retained_user_turns;
    return withOverrides({
        rungs,
        ...(Object.keys(trigger).length === 0 ? {} : { trigger }),
        ...(targetTokens === undefined ? {} : { targetTokens }),
        ...(retainedUserTurns === undefined ? {} : { retainedUserTurns }),
    }, overrides);
}

function bindRung(
    adapter: ModelAdapter,
    rung: ResolvedCompactionRung,
    assignment: readonly VeraCatalogModel[] | undefined,
    strategies: readonly CompactionStrategyDefinition[],
    windows: readonly ModelWindowEntry[],
): SessionCompactionRung | undefined {
    const strategy = strategies.find(
        (candidate) => candidate.id === rung.strategy,
    );
    if (strategy === undefined) {
        return undefined;
    }
    const models: Record<string, CompleteText> = {};
    for (const slot of strategy.models) {
        const route = assignment ?? rung.slots[slot];
        if (route === undefined || route.length === 0) {
            return undefined;
        }
        models[slot] = createRoutedCompletionService(adapter, {
            maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
            retryFailures: true,
            models: route.map((model) =>
                routedModel(model, rung.reasoning_effort, windows)
            ),
            ...(rung.timeout_ms === undefined
                ? {}
                : { timeoutMs: rung.timeout_ms }),
        });
    }
    const primary = strategy.models[0];
    const route = primary === undefined || assignment !== undefined
        ? undefined
        : rung.routes[primary];
    const firstModel = primary === undefined
        ? undefined
        : (assignment?.[0] ?? rung.slots[primary]?.[0]);
    return {
        strategy,
        models,
        diagnostics: {
            strategy: strategy.id,
            ...(route === undefined ? {} : { route }),
            ...(firstModel === undefined ? {} : {
                catalogEntry: firstModel.name,
                provider: firstModel.provider,
                model: firstModel.model,
            }),
        },
        ...(rung.reasoning_effort === undefined
            ? {}
            : { reasoningEffort: rung.reasoning_effort }),
        ...(rung.timeout_ms === undefined
            ? {}
            : { timeoutMs: rung.timeout_ms }),
    };
}

/** A rung's effort overrides the catalog entry's effort for that rung's calls only. */
function routedModel(
    model: VeraCatalogModel,
    rungEffort: ModelReasoningEffort | undefined,
    windows: readonly ModelWindowEntry[],
): CompletionModel {
    const window = contextWindowForModel(model.provider, model.model, windows);
    const reasoningEffort = rungEffort ?? model.reasoning_effort;
    return {
        provider: model.provider,
        model: model.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(window === undefined ? {} : { contextWindow: window }),
    };
}

function triggerBounds(
    fraction: number | undefined,
    tokens: number | undefined,
): CompactionTrigger {
    return {
        ...(fraction === undefined ? {} : { fraction }),
        ...(tokens === undefined ? {} : { tokens }),
    };
}

function nonEmpty(
    rungs: readonly SessionCompactionRung[],
): NonEmptyRungs | undefined {
    const [first, ...rest] = rungs;
    return first === undefined ? undefined : [first, ...rest];
}

/**
 * Numbers that ride over whatever compaction the session bound, whether that
 * came from a configured profile or from the default binding. A session with
 * no compaction profile still has compaction, so these have to reach both.
 */
export interface CompactionOverrides {
    readonly triggerFraction?: number;
    readonly triggerTokens?: number;
    readonly targetTokens?: number;
    readonly postCompactionTargetFraction?: number;
    readonly summaryWordCap?: number;
    readonly retainedUserTurns?: number;
}

function withOverrides(
    bound: SessionCompactionOptions | undefined,
    overrides: CompactionOverrides | undefined,
): SessionCompactionOptions | undefined {
    if (bound === undefined || overrides === undefined) {
        return bound;
    }
    const trigger: CompactionTrigger = {
        ...bound.trigger,
        ...(overrides.triggerFraction === undefined
            ? {}
            : { fraction: overrides.triggerFraction }),
        ...(overrides.triggerTokens === undefined
            ? {}
            : { tokens: overrides.triggerTokens }),
    };
    return {
        ...bound,
        ...(Object.keys(trigger).length === 0 ? {} : { trigger }),
        ...(overrides.targetTokens === undefined
            ? {}
            : { targetTokens: overrides.targetTokens }),
        ...(overrides.postCompactionTargetFraction === undefined ? {} : {
            postCompactionTargetFraction:
                overrides.postCompactionTargetFraction,
        }),
        ...(overrides.summaryWordCap === undefined
            ? {}
            : { summaryWordCap: overrides.summaryWordCap }),
        ...(overrides.retainedUserTurns === undefined
            ? {}
            : { retainedUserTurns: overrides.retainedUserTurns }),
    };
}

/** One rung of the ladder as it crosses to a worker. */
export interface CompactionWireRung {
    readonly strategyId: string;
    readonly slots: readonly string[];
    readonly diagnostics?: SessionCompactionDiagnostics;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly timeoutMs?: number;
}

export interface CompactionWireSpec {
    readonly strategyId: string;
    readonly slots: readonly string[];
    readonly diagnostics?: SessionCompactionDiagnostics;
    /** The full ladder in order. Absent means the top-level fields are the only rung. */
    readonly rungs?: readonly CompactionWireRung[];
    readonly trigger?: CompactionTrigger;
    readonly targetTokens?: number;
    readonly postCompactionTargetFraction?: number;
    readonly summaryWordCap?: number;
    readonly retainedUserTurns?: number;
}

/** The top level is rung 0, which is all a worker without `rungs` binds. */
export function compactionWireSpec(
    bound: SessionCompactionOptions,
): CompactionWireSpec {
    const [first] = bound.rungs;
    return {
        strategyId: first.strategy.id,
        slots: first.strategy.models,
        ...(first.diagnostics === undefined
            ? {}
            : { diagnostics: first.diagnostics }),
        rungs: bound.rungs.map(compactionWireRung),
        ...(bound.trigger === undefined ? {} : { trigger: bound.trigger }),
        ...(bound.targetTokens === undefined
            ? {}
            : { targetTokens: bound.targetTokens }),
        ...(bound.postCompactionTargetFraction === undefined
            ? {}
            : {
                postCompactionTargetFraction: bound.postCompactionTargetFraction,
            }),
        ...(bound.summaryWordCap === undefined
            ? {}
            : { summaryWordCap: bound.summaryWordCap }),
        ...(bound.retainedUserTurns === undefined
            ? {}
            : { retainedUserTurns: bound.retainedUserTurns }),
    };
}

function compactionWireRung(rung: SessionCompactionRung): CompactionWireRung {
    return {
        strategyId: rung.strategy.id,
        slots: rung.strategy.models,
        ...(rung.diagnostics === undefined
            ? {}
            : { diagnostics: rung.diagnostics }),
        ...(rung.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: rung.reasoningEffort }),
        ...(rung.timeoutMs === undefined ? {} : { timeoutMs: rung.timeoutMs }),
    };
}

export function bindRemoteCompaction(
    spec: CompactionWireSpec,
    complete: (rung: number, slot: string) => CompleteText,
    strategies: readonly CompactionStrategyDefinition[] =
        BUNDLED_COMPACTION_STRATEGIES,
): SessionCompactionOptions | undefined {
    const bound: SessionCompactionRung[] = [];
    for (const [index, wire] of wireRungs(spec).entries()) {
        const rung = bindWireRung(
            wire,
            (slot) => complete(index, slot),
            strategies,
        );
        if (rung === undefined) {
            return undefined;
        }
        bound.push(rung);
    }
    const rungs = nonEmpty(bound);
    if (rungs === undefined) {
        return undefined;
    }
    return {
        rungs,
        ...(spec.trigger === undefined ? {} : { trigger: spec.trigger }),
        ...(spec.targetTokens === undefined
            ? {}
            : { targetTokens: spec.targetTokens }),
        ...(spec.postCompactionTargetFraction === undefined
            ? {}
            : {
                postCompactionTargetFraction: spec.postCompactionTargetFraction,
            }),
        ...(spec.summaryWordCap === undefined
            ? {}
            : { summaryWordCap: spec.summaryWordCap }),
        ...(spec.retainedUserTurns === undefined
            ? {}
            : { retainedUserTurns: spec.retainedUserTurns }),
    };
}

/** A spec from a host that predates `rungs` has only the top level, which is rung 0. */
function wireRungs(spec: CompactionWireSpec): readonly CompactionWireRung[] {
    return spec.rungs ?? [{
        strategyId: spec.strategyId,
        slots: spec.slots,
        ...(spec.diagnostics === undefined
            ? {}
            : { diagnostics: spec.diagnostics }),
    }];
}

/** The first wire rung whose strategy this build cannot bind, for the start error. */
export function unboundWireStrategy(
    spec: CompactionWireSpec,
    strategies: readonly CompactionStrategyDefinition[] =
        BUNDLED_COMPACTION_STRATEGIES,
): string | undefined {
    return wireRungs(spec).find((wire) =>
        wireStrategy(wire, strategies) === undefined
    )?.strategyId;
}

function wireStrategy(
    wire: CompactionWireRung,
    strategies: readonly CompactionStrategyDefinition[],
): CompactionStrategyDefinition | undefined {
    const strategy = strategies.find(
        (candidate) => candidate.id === wire.strategyId,
    );
    if (strategy === undefined) {
        return undefined;
    }
    return strategy.models.every((slot) => wire.slots.includes(slot))
        ? strategy
        : undefined;
}

function bindWireRung(
    wire: CompactionWireRung,
    complete: (slot: string) => CompleteText,
    strategies: readonly CompactionStrategyDefinition[],
): SessionCompactionRung | undefined {
    const strategy = wireStrategy(wire, strategies);
    if (strategy === undefined) {
        return undefined;
    }
    const models: Record<string, CompleteText> = {};
    for (const slot of strategy.models) {
        models[slot] = complete(slot);
    }
    return {
        strategy,
        models,
        ...(wire.diagnostics === undefined
            ? {}
            : { diagnostics: wire.diagnostics }),
        ...(wire.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: wire.reasoningEffort }),
        ...(wire.timeoutMs === undefined ? {} : { timeoutMs: wire.timeoutMs }),
    };
}

function bindDefault(
    adapter: ModelAdapter,
    sessionModel: SessionModel,
    strategies: readonly CompactionStrategyDefinition[],
): SessionCompactionOptions | undefined {
    const complete = createRoutedCompletionService(adapter, {
        maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
        retryFailures: true,
        models: [{
            ...(sessionModel.provider === undefined
                ? {}
                : { provider: sessionModel.provider }),
            model: sessionModel.model,
        }],
    });
    const bound: SessionCompactionRung[] = [];
    for (const id of DEFAULT_COMPACTION_LADDER) {
        const strategy = strategies.find((candidate) => candidate.id === id);
        if (strategy === undefined) {
            return undefined;
        }
        const models: Record<string, CompleteText> = {};
        for (const slot of strategy.models) {
            models[slot] = complete;
        }
        bound.push({
            strategy,
            models,
            diagnostics: sessionDiagnostics(strategy, sessionModel),
        });
    }
    const rungs = nonEmpty(bound);
    return rungs === undefined ? undefined : { rungs };
}

/** A rung that runs no model reports no model, so the session model is not shown for it. */
function sessionDiagnostics(
    strategy: CompactionStrategyDefinition,
    sessionModel: SessionModel,
): SessionCompactionDiagnostics {
    if (strategy.models.length === 0) {
        return { strategy: strategy.id };
    }
    return {
        strategy: strategy.id,
        ...(sessionModel.provider === undefined
            ? {}
            : { provider: sessionModel.provider }),
        model: sessionModel.model,
    };
}

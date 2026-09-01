import type { ModelAdapter } from "../model/types.ts";
import type {
    ResolvedCompactionProfile,
    VeraCatalogModel,
} from "../config/model-catalog.ts";
import type { CompactionStrategyDefinition } from "./compaction.ts";
import type { CompactionTrigger } from "./compaction-scheduler.ts";
import {
    FULL_SUMMARY_STRATEGY_ID,
    fullSummaryStrategy,
} from "./compaction-full-summary.ts";
import {
    createRoutedCompletionService,
    type CompleteText,
} from "./completion-service.ts";
import { contextWindowForModel } from "./model-settings.ts";
import type { SessionCompactionOptions } from "./run-turn.ts";
import type { SessionCompactionDiagnostics } from "../store/session-store.ts";

export const BUNDLED_COMPACTION_STRATEGIES:
    readonly CompactionStrategyDefinition[] = [fullSummaryStrategy];

export const COMPACTION_MAX_OUTPUT_TOKENS = 32_768;

export const DEFAULT_COMPACTION_STRATEGY_ID = FULL_SUMMARY_STRATEGY_ID;

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
): SessionCompactionOptions | undefined {
    const assignment = slotModels !== undefined && slotModels.length > 0
        ? slotModels
        : undefined;
    const resolved = profile ?? (assignment === undefined
        ? undefined
        : {
            strategy: DEFAULT_COMPACTION_STRATEGY_ID,
            routes: {},
            slots: {},
        });
    if (resolved === undefined) {
        return sessionModel === undefined
            ? undefined
            : withOverrides(
                bindDefault(adapter, sessionModel, strategies),
                overrides,
            );
    }
    const strategy = strategies.find(
        (candidate) => candidate.id === resolved.strategy,
    );
    if (strategy === undefined) {
        return undefined;
    }
    const models: Record<string, CompleteText> = {};
    for (const slot of strategy.models) {
        const named = resolved.slots[slot];
        const route = assignment ?? named;
        if (route === undefined || route.length === 0) {
            return undefined;
        }
        models[slot] = createRoutedCompletionService(adapter, {
            maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
            models: route.map((model) => {
                const window = contextWindowForModel(
                    model.provider,
                    model.model,
                );
                return {
                    provider: model.provider,
                    model: model.model,
                    ...(model.reasoning_effort === undefined
                        ? {}
                        : { reasoningEffort: model.reasoning_effort }),
                    ...(window === undefined ? {} : { contextWindow: window }),
                };
            }),
            ...(resolved.timeout_ms === undefined
                ? {}
                : { timeoutMs: resolved.timeout_ms }),
        });
    }
    const primary = strategy.models[0];
    const route = primary === undefined || assignment !== undefined
        ? undefined
        : resolved.routes[primary];
    const firstModel = primary === undefined
        ? undefined
        : (assignment?.[0] ?? resolved.slots[primary]?.[0]);
    const trigger: CompactionTrigger = {
        ...(resolved.trigger_fraction === undefined
            ? {}
            : { fraction: resolved.trigger_fraction }),
        ...(resolved.trigger_tokens === undefined
            ? {}
            : { tokens: resolved.trigger_tokens }),
    };
    return withOverrides({
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
        ...(Object.keys(trigger).length === 0 ? {} : { trigger }),
        ...(resolved.target_tokens === undefined
            ? {}
            : { targetTokens: resolved.target_tokens }),
        ...(resolved.retained_user_turns === undefined
            ? {}
            : { retainedUserTurns: resolved.retained_user_turns }),
    }, overrides);
}

export interface CompactionOverrides {
    readonly triggerFraction?: number;
    readonly postCompactionTargetFraction?: number;
    readonly summaryWordCap?: number;
}

function withOverrides(
    bound: SessionCompactionOptions | undefined,
    overrides: CompactionOverrides | undefined,
): SessionCompactionOptions | undefined {
    if (bound === undefined || overrides === undefined) {
        return bound;
    }
    return {
        ...bound,
        ...(overrides.triggerFraction === undefined ? {} : {
            trigger: {
                ...bound.trigger,
                fraction: overrides.triggerFraction,
            },
        }),
        ...(overrides.postCompactionTargetFraction === undefined ? {} : {
            postCompactionTargetFraction:
                overrides.postCompactionTargetFraction,
        }),
        ...(overrides.summaryWordCap === undefined
            ? {}
            : { summaryWordCap: overrides.summaryWordCap }),
    };
}

export interface CompactionWireSpec {
    readonly strategyId: string;
    readonly slots: readonly string[];
    readonly diagnostics?: SessionCompactionDiagnostics;
    readonly trigger?: CompactionTrigger;
    readonly targetTokens?: number;
    readonly postCompactionTargetFraction?: number;
    readonly summaryWordCap?: number;
    readonly retainedUserTurns?: number;
}

export function compactionWireSpec(
    bound: SessionCompactionOptions,
): CompactionWireSpec {
    return {
        strategyId: bound.strategy.id,
        slots: bound.strategy.models,
        ...(bound.diagnostics === undefined
            ? {}
            : { diagnostics: bound.diagnostics }),
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

export function bindRemoteCompaction(
    spec: CompactionWireSpec,
    complete: (slot: string) => CompleteText,
    strategies: readonly CompactionStrategyDefinition[] =
        BUNDLED_COMPACTION_STRATEGIES,
): SessionCompactionOptions | undefined {
    const strategy = strategies.find(
        (candidate) => candidate.id === spec.strategyId,
    );
    if (strategy === undefined) {
        return undefined;
    }
    const models: Record<string, CompleteText> = {};
    for (const slot of strategy.models) {
        if (!spec.slots.includes(slot)) {
            return undefined;
        }
        models[slot] = complete(slot);
    }
    return {
        strategy,
        models,
        ...(spec.diagnostics === undefined
            ? {}
            : { diagnostics: spec.diagnostics }),
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

function bindDefault(
    adapter: ModelAdapter,
    sessionModel: SessionModel,
    strategies: readonly CompactionStrategyDefinition[],
): SessionCompactionOptions | undefined {
    const strategy = strategies.find(
        (candidate) => candidate.id === DEFAULT_COMPACTION_STRATEGY_ID,
    );
    if (strategy === undefined) {
        return undefined;
    }
    const complete = createRoutedCompletionService(adapter, {
        maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
        models: [{
            ...(sessionModel.provider === undefined
                ? {}
                : { provider: sessionModel.provider }),
            model: sessionModel.model,
        }],
    });
    const models: Record<string, CompleteText> = {};
    for (const slot of strategy.models) {
        models[slot] = complete;
    }
    return {
        strategy,
        models,
        diagnostics: {
            strategy: strategy.id,
            ...(sessionModel.provider === undefined
                ? {}
                : { provider: sessionModel.provider }),
            model: sessionModel.model,
        },
    };
}

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

/**
 * Strategies Vera ships. The host passes these into `bindCompaction` the same
 * way it will pass extension-registered ones: binding takes whatever registry
 * the host assembled, and holds no list of its own.
 */
export const BUNDLED_COMPACTION_STRATEGIES:
    readonly CompactionStrategyDefinition[] = [fullSummaryStrategy];

/**
 * Output ceiling for a summarizer call. A note of `MAX_SUMMARY_WORDS` is a few
 * thousand tokens; the rest is room for reasoning, which providers count
 * against the same limit.
 */
export const COMPACTION_MAX_OUTPUT_TOKENS = 32_768;

/** What an unconfigured session compacts with. */
export const DEFAULT_COMPACTION_STRATEGY_ID = FULL_SUMMARY_STRATEGY_ID;

/**
 * The model a session summarizes itself on when config says nothing: the one
 * it is already running. A catalog route is the better answer once there is a
 * cheaper model to name, but a session that fills its window has to compact
 * whether or not anyone configured it to.
 */
export interface SessionModel {
    readonly provider?: string;
    readonly model: string;
}

/**
 * Binds a configured profile to the adapter the agent is running on.
 *
 * A strategy may declare several model slots, and a profile need not name a
 * route for each. `slotModels` is the compaction assignment, and it binds every
 * slot when set; a route the profile names for a slot is only read when no
 * assignment resolves.
 *
 * Returns undefined rather than a partly bound profile when the strategy is
 * unknown, or a slot it declared has neither a route nor a fallback: a session
 * that cannot compact correctly should not compact at all, and the alternative
 * is discovering the missing model at the moment the window fills.
 */
export function bindCompaction(
    profile: ResolvedCompactionProfile | undefined,
    adapter: ModelAdapter,
    sessionModel: SessionModel | undefined,
    strategies: readonly CompactionStrategyDefinition[],
    slotModels?: readonly VeraCatalogModel[],
): SessionCompactionOptions | undefined {
    if (profile === undefined) {
        return sessionModel === undefined
            ? undefined
            : bindDefault(adapter, sessionModel, strategies);
    }
    const strategy = strategies.find(
        (candidate) => candidate.id === profile.strategy,
    );
    if (strategy === undefined) {
        return undefined;
    }
    const models: Record<string, CompleteText> = {};
    for (const slot of strategy.models) {
        const named = profile.slots[slot];
        const route = slotModels !== undefined && slotModels.length > 0
            ? slotModels
            : named;
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
            ...(profile.timeout_ms === undefined
                ? {}
                : { timeoutMs: profile.timeout_ms }),
        });
    }
    const primary = strategy.models[0];
    const assigned = slotModels !== undefined && slotModels.length > 0;
    const route = primary === undefined || assigned
        ? undefined
        : profile.routes[primary];
    const firstModel = primary === undefined
        ? undefined
        : (assigned ? slotModels[0] : profile.slots[primary]?.[0]);
    const trigger: CompactionTrigger = {
        ...(profile.trigger_fraction === undefined
            ? {}
            : { fraction: profile.trigger_fraction }),
        ...(profile.trigger_tokens === undefined
            ? {}
            : { tokens: profile.trigger_tokens }),
    };
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
        ...(Object.keys(trigger).length === 0 ? {} : { trigger }),
        ...(profile.target_tokens === undefined
            ? {}
            : { targetTokens: profile.target_tokens }),
        ...(profile.retained_user_turns === undefined
            ? {}
            : { retainedUserTurns: profile.retained_user_turns }),
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

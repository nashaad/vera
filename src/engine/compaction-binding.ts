import type { ModelAdapter } from "../model/types.ts";
import type { ResolvedCompactionProfile } from "../config/model-catalog.ts";
import type { CompactionStrategyDefinition } from "./compaction.ts";
import {
    FULL_SUMMARY_STRATEGY_ID,
    fullSummaryStrategy,
} from "./compaction-full-summary.ts";
import {
    createRoutedCompletionService,
    type CompleteText,
} from "./completion-service.ts";
import type { SessionCompactionOptions } from "./run-turn.ts";

/**
 * Strategies Vera ships. The host passes these into `bindCompaction` the same
 * way it will pass extension-registered ones: binding takes whatever registry
 * the host assembled, and holds no list of its own.
 */
export const BUNDLED_COMPACTION_STRATEGIES:
    readonly CompactionStrategyDefinition[] = [fullSummaryStrategy];

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
 * Returns undefined rather than a partly bound profile when the strategy is
 * unknown or a slot it declared has no route: a session that cannot compact
 * correctly should not compact at all, and the alternative is discovering the
 * missing model at the moment the window fills.
 */
export function bindCompaction(
    profile: ResolvedCompactionProfile | undefined,
    adapter: ModelAdapter,
    sessionModel: SessionModel | undefined,
    strategies: readonly CompactionStrategyDefinition[],
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
        const route = profile.slots[slot];
        if (route === undefined || route.length === 0) {
            return undefined;
        }
        models[slot] = createRoutedCompletionService(adapter, {
            models: route.map((model) => ({
                provider: model.provider,
                model: model.model,
                ...(model.reasoning_effort === undefined
                    ? {}
                    : { reasoningEffort: model.reasoning_effort }),
            })),
            ...(profile.timeout_ms === undefined
                ? {}
                : { timeoutMs: profile.timeout_ms }),
        });
    }
    const primary = strategy.models[0];
    const route = primary === undefined ? undefined : profile.routes[primary];
    const entry = primary === undefined
        ? undefined
        : profile.slots[primary]?.[0]?.name;
    return {
        strategy,
        models,
        diagnostics: {
            strategy: strategy.id,
            ...(route === undefined ? {} : { route }),
            ...(entry === undefined ? {} : { catalogEntry: entry }),
        },
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
        diagnostics: { strategy: strategy.id },
    };
}

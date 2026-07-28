import type { ModelAdapter } from "../model/types.ts";
import type { ResolvedCompactionProfile } from "../config/model-catalog.ts";
import type { CompactionStrategyDefinition } from "./compaction.ts";
import { fullSummaryStrategy } from "./compaction-full-summary.ts";
import {
    createRoutedCompletionService,
    type CompleteText,
} from "./completion-service.ts";
import type { SessionCompactionOptions } from "./run-turn.ts";

/**
 * Strategies Vera ships. An extension-supplied strategy registers into the
 * same shape, so nothing downstream of here knows which kind it got.
 */
export const BUNDLED_COMPACTION_STRATEGIES:
    readonly CompactionStrategyDefinition[] = [fullSummaryStrategy];

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
    strategies: readonly CompactionStrategyDefinition[] =
        BUNDLED_COMPACTION_STRATEGIES,
): SessionCompactionOptions | undefined {
    if (profile === undefined) {
        return undefined;
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

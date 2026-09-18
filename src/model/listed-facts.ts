/** Join WA Score onto the client projections and stamp P from one front over the union. */

import type { AvailableModel, PooledModel } from "./catalog-view.ts";
import {
    joinWaScore,
    loadWebDevArenaAliases,
    type WebDevArenaAliases,
} from "./webdev-arena-join.ts";
import {
    webDevArenaSnapshotDate,
    type WebDevArenaSnapshot,
} from "./webdev-arena.ts";
import { paretoKeys } from "./webdev-pareto.ts";

export interface ListedFactsResult {
    readonly available: readonly AvailableModel[];
    readonly pooled: readonly PooledModel[];
    readonly webdevArenaSnapshot?: string;
}

export interface ListedFactsOptions {
    readonly snapshot?: WebDevArenaSnapshot;
    readonly aliases?: WebDevArenaAliases;
}

export function withListedFacts(
    available: readonly AvailableModel[],
    pooled: readonly PooledModel[],
    options: ListedFactsOptions = {},
): ListedFactsResult {
    const aliases = options.aliases ?? loadAliases();
    const scoredAvailable = available.map((model) =>
        withScore(model, options.snapshot, aliases)
    );
    const scoredPooled = pooled.map((model) =>
        withScore(model, options.snapshot, aliases)
    );
    const keys = paretoKeys(unionCandidates(scoredAvailable, scoredPooled));
    const date = webDevArenaSnapshotDate(options.snapshot);
    return {
        available: scoredAvailable.map((model) => stampPareto(model, keys)),
        pooled: scoredPooled.map((model) => stampPareto(model, keys)),
        ...(date === undefined ? {} : { webdevArenaSnapshot: date }),
    };
}

function loadAliases(): WebDevArenaAliases {
    try {
        return loadWebDevArenaAliases();
    } catch {
        return { schema_version: 1, aliases: {} };
    }
}

function withScore<T extends AvailableModel | PooledModel>(
    model: T,
    snapshot: WebDevArenaSnapshot | undefined,
    aliases: WebDevArenaAliases,
): T {
    const waScore = joinWaScore({
        provider: model.provider,
        model: model.model,
    }, snapshot, aliases);
    return waScore === undefined ? model : { ...model, waScore };
}

function unionCandidates(
    available: readonly AvailableModel[],
    pooled: readonly PooledModel[],
): readonly {
    readonly key: string;
    readonly score: number;
    readonly output: number;
}[] {
    const byKey = new Map<string, {
        readonly key: string;
        readonly score: number;
        readonly output: number;
    }>();
    for (const model of [...available, ...pooled]) {
        const candidate = asCandidate(model);
        if (candidate !== undefined && !byKey.has(candidate.key)) {
            byKey.set(candidate.key, candidate);
        }
    }
    return [...byKey.values()];
}

function stampPareto<T extends AvailableModel | PooledModel>(
    model: T,
    keys: ReadonlySet<string>,
): T {
    return keys.has(`${model.provider}/${model.model}`)
        ? { ...model, onPareto: true }
        : model;
}

function asCandidate(
    model: AvailableModel | PooledModel,
): {
    readonly key: string;
    readonly score: number;
    readonly output: number;
} | undefined {
    if (model.waScore === undefined || model.pricing === undefined) {
        return undefined;
    }
    return {
        key: `${model.provider}/${model.model}`,
        score: model.waScore,
        output: model.pricing.output,
    };
}

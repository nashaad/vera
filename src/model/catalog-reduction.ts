
import { versionChain } from "./model-version-chain.ts";

export type ReductionReason = "batch" | "alias" | "old" | "superseded";

export interface ReducibleModel {
    readonly id: string;
    readonly created?: number;
}

export interface ReductionOptions {
    readonly maxAgeMonths?: number;
    readonly now: number;
    readonly keep?: ReadonlySet<string>;
    readonly collapseVersions?: boolean;
}

export const DEFAULT_MAX_AGE_MONTHS = 6;

const SECONDS_PER_MONTH = 30.44 * 24 * 60 * 60;

export function reduceModels(
    models: readonly ReducibleModel[],
    options: ReductionOptions,
): ReadonlyMap<string, ReductionReason> {
    const concrete = concreteIds(models);
    const hidden = new Map<string, ReductionReason>();
    const maxAgeMonths = options.maxAgeMonths ?? DEFAULT_MAX_AGE_MONTHS;
    // A cutoff of zero months would otherwise hide everything dated, which is the opposite of what asking for no age limit means.
    const cutoff = maxAgeMonths <= 0
        ? undefined
        : options.now - maxAgeMonths * SECONDS_PER_MONTH;
    for (const model of models) {
        if (options.keep?.has(model.id) === true) {
            continue;
        }
        const reason = reductionReason(model, concrete, cutoff);
        if (reason !== undefined) {
            hidden.set(model.id, reason);
        }
    }
    if (options.collapseVersions === true) {
        for (const id of supersededIds(models, options, hidden)) {
            hidden.set(id, "superseded");
        }
    }
    return hidden;
}

function supersededIds(
    models: readonly ReducibleModel[],
    options: ReductionOptions,
    hidden: ReadonlyMap<string, ReductionReason>,
): readonly string[] {
    const chains = new Map<string, ReducibleModel[]>();
    for (const model of models) {
        if (hidden.has(model.id) || options.keep?.has(model.id) === true
            || model.created === undefined) {
            continue;
        }
        const chain = versionChain(model.id);
        if (chain === undefined) {
            continue;
        }
        const members = chains.get(chain.stem);
        if (members === undefined) {
            chains.set(chain.stem, [model]);
        } else {
            members.push(model);
        }
    }

    const superseded: string[] = [];
    for (const members of chains.values()) {
        if (members.length < 2) {
            continue;
        }
        const newest = members.reduce((left, right) =>
            (right.created ?? 0) > (left.created ?? 0) ? right : left
        );
        for (const model of members) {
            if (model.id !== newest.id) {
                superseded.push(model.id);
            }
        }
    }
    return superseded;
}

function reductionReason(
    model: ReducibleModel,
    concrete: ReadonlySet<string>,
    cutoff: number | undefined,
): ReductionReason | undefined {
    if (isBatchId(model.id)) {
        return "batch";
    }
    if (isAliasId(model.id) && concrete.has(aliasTarget(model.id))) {
        return "alias";
    }
    if (
        cutoff !== undefined && model.created !== undefined
        && model.created < cutoff
    ) {
        return "old";
    }
    return undefined;
}

export function isBatchId(id: string): boolean {
    return id.endsWith(":batch");
}

export function isAliasId(id: string): boolean {
    return id.startsWith("~") || id.endsWith("-latest");
}

function aliasTarget(id: string): string {
    return id.replace(/^~/, "").replace(/-latest$/, "");
}

function concreteIds(models: readonly ReducibleModel[]): ReadonlySet<string> {
    const prefixes = new Set<string>();
    for (const model of models) {
        if (isBatchId(model.id) || isAliasId(model.id)) {
            continue;
        }
        for (let end = model.id.length; end > 0; end -= 1) {
            prefixes.add(model.id.slice(0, end));
        }
    }
    return prefixes;
}

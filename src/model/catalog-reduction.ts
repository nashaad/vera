/**
 * Which rows a provider group shows before the user asks for the rest.
 *
 * Reduction is a view, never a filter on what Vera holds: every model stays in
 * the snapshot and every hidden row is one keypress away. That is what lets
 * the picker default to a short list without the short list becoming a claim
 * that the other models do not exist.
 *
 * The rules are ordered by how sure they are. Batch and alias rows are hidden
 * on what the id says, which is a fact. Age is hidden on a date, which can be
 * missing, so a model with no date is kept.
 */

import { versionChain } from "./model-version-chain.ts";

/** Why a row is not shown by default. Absent means it is shown. */
export type ReductionReason = "batch" | "alias" | "old" | "superseded";

export interface ReducibleModel {
    readonly id: string;
    readonly created?: number;
}

export interface ReductionOptions {
    /**
     * How old a model may be and still be shown, in months. Absent means
     * `DEFAULT_MAX_AGE_MONTHS`; `0` shows every model whatever its age.
     * Set by `model_picker_max_age_months` in the Vera config.
     */
    readonly maxAgeMonths?: number;
    /** Seconds since the epoch. Passed in so this stays a pure function. */
    readonly now: number;
    /**
     * Ids that are shown whatever the rules say. The pool and the curation are
     * deliberate choices, by the user and by Vera, and a heuristic does not
     * overrule either.
     */
    readonly keep?: ReadonlySet<string>;
    /**
     * Fold a model away when a later version of the same model is listed. Off
     * unless asked for: it is the only rule here that can hide a model on a
     * reading of its name rather than on a fact about it.
     */
    readonly collapseVersions?: boolean;
    /**
     * Family per model id, from models.dev. A chain is folded only where this
     * agrees that both ids are the same model line. An id the map does not
     * cover is not folded, so a models.dev that is stale or unreachable makes
     * the list longer and never wrong.
     */
    readonly families?: ReadonlyMap<string, string>;
}

/**
 * The cutoff when the config names none. Deliberately tight: the picker is a
 * shortlist, and a model older than this is reachable by search or by the
 * reveal key rather than gone.
 */
export const DEFAULT_MAX_AGE_MONTHS = 6;

const SECONDS_PER_MONTH = 30.44 * 24 * 60 * 60;

/**
 * The reason each id is hidden, or absent from the map when it is shown.
 *
 * Returning reasons rather than a filtered list keeps the caller able to say
 * what it hid and why, which the group header needs.
 */
export function reduceModels(
    models: readonly ReducibleModel[],
    options: ReductionOptions,
): ReadonlyMap<string, ReductionReason> {
    const concrete = concreteIds(models);
    const hidden = new Map<string, ReductionReason>();
    const maxAgeMonths = options.maxAgeMonths ?? DEFAULT_MAX_AGE_MONTHS;
    // A cutoff of zero months would otherwise hide everything dated, which is
    // the opposite of what asking for no age limit means.
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

/**
 * Every model that a later version of itself has replaced.
 *
 * Ordering is by listing date, never by version number: `grok-4.20` reads as
 * higher than `grok-4.6` on the digits and was listed four months earlier, so
 * comparing versions would fold the newer model away. An undated model is not
 * ordered against anything and so is never folded and never folds another.
 */
function supersededIds(
    models: readonly ReducibleModel[],
    options: ReductionOptions,
    hidden: ReadonlyMap<string, ReductionReason>,
): readonly string[] {
    const chains = new Map<string, ReducibleModel[]>();
    for (const model of models) {
        // A row already folded, or held open by the pool or the curation, takes
        // no part: it can neither replace another row nor be replaced, and
        // letting it win its chain would fold the whole chain behind a row that
        // is not on screen.
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
        if (members.length < 2 || !sameFamily(members, options.families)) {
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

/**
 * Whether models.dev puts every member of a chain in one family. An id the map
 * does not cover answers no, which leaves the chain unfolded.
 */
function sameFamily(
    members: readonly ReducibleModel[],
    families: ReadonlyMap<string, string> | undefined,
): boolean {
    if (families === undefined) {
        return false;
    }
    const first = families.get(members[0]!.id);
    return first !== undefined
        && members.every((model) => families.get(model.id) === first);
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
    // No date is not evidence of age. Keeping the model is the answer that
    // cannot hide something wanted on the strength of a missing field.
    if (
        cutoff !== undefined && model.created !== undefined
        && model.created < cutoff
    ) {
        return "old";
    }
    return undefined;
}

/**
 * A batch id names a submission mode, not a model: the same model, queued
 * instead of answered. Nothing in the picker chats with one.
 */
export function isBatchId(id: string): boolean {
    return id.endsWith(":batch");
}

/**
 * An alias id points at whichever concrete model the vendor currently calls
 * latest. It is only a duplicate while the model it resolves to is also
 * listed, so the target is checked before the row is hidden.
 */
export function isAliasId(id: string): boolean {
    return id.startsWith("~") || id.endsWith("-latest");
}

/**
 * The prefix a concrete row must share for the alias to be a duplicate of it.
 * `~anthropic/claude-opus-latest` yields `anthropic/claude-opus`, which
 * `anthropic/claude-opus-4.8` starts with.
 */
function aliasTarget(id: string): string {
    return id.replace(/^~/, "").replace(/-latest$/, "");
}

function concreteIds(models: readonly ReducibleModel[]): ReadonlySet<string> {
    const prefixes = new Set<string>();
    for (const model of models) {
        if (isBatchId(model.id) || isAliasId(model.id)) {
            continue;
        }
        // Every prefix the id can stand in for, so an alias target is a set
        // lookup rather than a scan over every concrete row per alias.
        for (let end = model.id.length; end > 0; end -= 1) {
            prefixes.add(model.id.slice(0, end));
        }
    }
    return prefixes;
}

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

/** Why a row is not shown by default. Absent means it is shown. */
export type ReductionReason = "batch" | "alias" | "old";

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
    return hidden;
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

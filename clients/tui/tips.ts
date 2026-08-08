/**
 * Tips: one global pool, shown a few at a time, never twice in a row.
 *
 * A tip is a line of text with a relevance predicate and a cooldown measured
 * in launches. Selection filters by relevance, drops anything still inside its
 * cooldown, and takes whichever survivor has gone longest unshown, so the same
 * two tips do not trade places while the rest of the pool never appears.
 *
 * The pool is global rather than per-surface. A tip that only makes sense in
 * one place says so through its predicate, which is the same mechanism a tip
 * about the composer or the pool uses, so there is one list to read and one
 * rule for when a line is allowed on screen.
 */

import { tuiKeyChord } from "./keymap.ts";

export interface TuiTipContext {
    /** How many times the TUI has been launched, this launch included. */
    readonly launches: number;
    /** Models in the pool right now. */
    readonly pooledCount: number;
    /** Pool entries carrying a name. */
    readonly namedPoolCount: number;
    /** Whether any pooled model has been verified. */
    readonly anyVerified: boolean;
    /** Whether the model picker is the surface asking. */
    readonly inModelPicker: boolean;
}

export interface TuiTip {
    readonly id: string;
    readonly text: (context: TuiTipContext) => string;
    /** Launches that must pass before this tip may be shown again. */
    readonly cooldownLaunches: number;
    readonly isRelevant: (context: TuiTipContext) => boolean;
}

/** What launch each tip id was last shown at. */
export type TuiTipHistory = Readonly<Record<string, number>>;

export const TUI_TIPS: readonly TuiTip[] = [
    {
        id: "name-pool-entry",
        text: () =>
            `Press ${
                tuiKeyChord("name_pooled")
            } on a pooled model to give it a short name`,
        cooldownLaunches: 5,
        // Naming is only reachable once something is in the pool, and it stops
        // being news once the user has named a few entries themselves.
        isRelevant: (context) =>
            context.pooledCount > 0 && context.namedPoolCount < 3,
    },
    {
        id: "verify-model",
        text: () =>
            `Press ${
                tuiKeyChord("verify_model")
            } to probe a model and record what it can do`,
        cooldownLaunches: 8,
        isRelevant: (context) => context.pooledCount > 0 && !context.anyVerified,
    },
    {
        id: "pool-a-model",
        text: () =>
            `Press ${tuiKeyChord("toggle_pooled")} to add a model to your pool`,
        cooldownLaunches: 4,
        isRelevant: (context) =>
            context.inModelPicker && context.pooledCount < 2,
    },
    {
        id: "connect-provider",
        text: () =>
            `Press ${
                tuiKeyChord("open_providers")
            } to connect another provider`,
        cooldownLaunches: 10,
        isRelevant: (context) => context.inModelPicker,
    },
    {
        id: "fold-sections",
        text: () =>
            "On a section heading, ← and → fold it; shift folds every section",
        cooldownLaunches: 12,
        isRelevant: (context) =>
            context.inModelPicker && context.pooledCount > 4,
    },
    {
        id: "model-picker-shortcut",
        text: () => `Press ${tuiKeyChord("open_model_picker")} to switch models`,
        cooldownLaunches: 15,
        isRelevant: (context) => !context.inModelPicker,
    },
    {
        id: "command-palette",
        text: () =>
            `Press ${tuiKeyChord("open_palette")} for the command palette`,
        cooldownLaunches: 15,
        isRelevant: (context) => !context.inModelPicker,
    },
];

/**
 * The tip to show, or nothing.
 *
 * Ties break on the longest unshown, and a tip never shown counts as
 * infinitely long ago, so a fresh pool hands out every tip once before it
 * repeats any of them.
 */
export function selectTuiTip(
    context: TuiTipContext,
    history: TuiTipHistory,
    pool: readonly TuiTip[] = TUI_TIPS,
): TuiTip | undefined {
    const eligible = pool.filter((tip) =>
        tip.isRelevant(context)
        && launchesSinceShown(tip.id, history, context.launches)
            >= tip.cooldownLaunches
    );
    if (eligible.length === 0) return undefined;
    return eligible.reduce((longest, tip) =>
        launchesSinceShown(tip.id, history, context.launches)
                > launchesSinceShown(longest.id, history, context.launches)
            ? tip
            : longest
    );
}

export function launchesSinceShown(
    id: string,
    history: TuiTipHistory,
    launches: number,
): number {
    const shown = history[id];
    return shown === undefined ? Number.POSITIVE_INFINITY : launches - shown;
}

/** History with `id` recorded as shown at the current launch. */
export function recordTuiTipShown(
    id: string,
    history: TuiTipHistory,
    launches: number,
): TuiTipHistory {
    return { ...history, [id]: launches };
}


import { tuiKeyChordLabel } from "./keymap.ts";

export interface TuiTipContext {
    readonly launches: number;
    readonly pooledCount: number;
    readonly namedPoolCount: number;
    readonly anyVerified: boolean;
    readonly inModelPicker: boolean;
}

export interface TuiTip {
    readonly id: string;
    readonly text: (context: TuiTipContext) => string;
    readonly cooldownLaunches: number;
    readonly isRelevant: (context: TuiTipContext) => boolean;
}

export type TuiTipHistory = Readonly<Record<string, number>>;

export const TUI_TIPS: readonly TuiTip[] = [
    {
        id: "name-pool-entry",
        text: () =>
            `Press ${
                tuiKeyChordLabel("name_pooled")
            } on a model in your favorites to give it a short name`,
        cooldownLaunches: 5,
        isRelevant: (context) =>
            context.inModelPicker && context.pooledCount > 0
            && context.namedPoolCount < 3,
    },
    {
        id: "verify-model",
        text: () =>
            `Press ${tuiKeyChordLabel("verify_model")} to probe the highlighted model`,
        cooldownLaunches: 8,
        isRelevant: (context) =>
            context.inModelPicker && context.pooledCount > 0
            && !context.anyVerified,
    },
    {
        id: "pool-a-model",
        text: () =>
            `Press ${tuiKeyChordLabel("toggle_pooled")} to keep a model in your favorites`,
        cooldownLaunches: 4,
        isRelevant: (context) =>
            context.inModelPicker && context.pooledCount < 2,
    },
    {
        id: "connect-provider",
        text: () =>
            `Press ${
                tuiKeyChordLabel("open_providers")
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
        text: () => `Press ${tuiKeyChordLabel("open_model_prefix")}, release Ctrl, then ${tuiKeyChordLabel("model_prefix_open")} to switch models`,
        cooldownLaunches: 15,
        isRelevant: (context) => !context.inModelPicker,
    },
    {
        id: "command-palette",
        text: () =>
            `Press ${tuiKeyChordLabel("open_palette")} for the command palette`,
        cooldownLaunches: 15,
        isRelevant: (context) => !context.inModelPicker,
    },
];

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

export function recordTuiTipShown(
    id: string,
    history: TuiTipHistory,
    launches: number,
): TuiTipHistory {
    return { ...history, [id]: launches };
}

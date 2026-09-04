import {
    COMPACTION_TRIGGER_FRACTION,
    POST_COMPACTION_TARGET_FRACTION,
    RETAINED_USER_TURNS,
    UNKNOWN_CAPACITY_TRIGGER_TOKENS,
} from "./compaction-scheduler.ts";
import { MAX_SUMMARY_WORDS } from "./compaction-full-summary.ts";
import {
    TOOL_RESULT_AGING_LEVELS,
    TOOL_RESULT_TOTAL_BUDGET_BYTES,
    toolResultAgingLevel,
    type ToolResultAgingLevel,
} from "./tool-result-history.ts";
import { TOOL_RESULT_CEILING_BYTES } from "../tools/tool-result-limit.ts";

export type OverrideKey =
    | "contextLimit"
    | "compactionTriggerFraction"
    | "compactionTriggerTokens"
    | "compactionTargetTokens"
    | "postCompactionTargetFraction"
    | "summaryWordCap"
    | "retainedUserTurns"
    | "toolResultCeilingBytes"
    | "toolResultTotalBudgetBytes"
    | "toolResultStubAfterTurns"
    | "toolResultAgingLevel";

export const OVERRIDE_KEYS: readonly OverrideKey[] = [
    "contextLimit",
    "compactionTriggerFraction",
    "compactionTriggerTokens",
    "compactionTargetTokens",
    "postCompactionTargetFraction",
    "summaryWordCap",
    "retainedUserTurns",
    "toolResultCeilingBytes",
    "toolResultTotalBudgetBytes",
    "toolResultStubAfterTurns",
    "toolResultAgingLevel",
];

/** What a config wrote, before any default fills the gaps. */
export type ConfiguredOverrides = {
    readonly [K in OverrideKey]?: number | string;
};

export interface OverrideRow {
    readonly key: OverrideKey;
    /** What the engine reads this turn. Absent when nothing is applied. */
    readonly value?: number | string;
    readonly source: "configured" | "default";
    /** Why the engine never reads this value. Absent when it does. */
    readonly inert?: string;
}

const UNKNOWN_WINDOW = "the model's context window is unknown";

function effectiveTriggerTokens(
    configured: number | undefined,
    capacity: number | undefined,
): number | undefined {
    if (configured !== undefined) {
        return configured;
    }
    return capacity === undefined ? UNKNOWN_CAPACITY_TRIGGER_TOKENS : undefined;
}

function agingLevel(
    configured: string | undefined,
    capacity: number | undefined,
): ToolResultAgingLevel {
    return configured === undefined || configured === "auto"
        ? toolResultAgingLevel(capacity)
        : configured as ToolResultAgingLevel;
}

function row(
    key: OverrideKey,
    configured: number | string | undefined,
    fallback: number | string | undefined,
    inert?: string,
): OverrideRow {
    const value = configured ?? fallback;
    return {
        key,
        ...(value === undefined ? {} : { value }),
        source: configured === undefined ? "default" : "configured",
        ...(inert === undefined ? {} : { inert }),
    };
}

/**
 * Every context lever, what the engine reads for it, and whether it reads it
 * at all. A lever the engine never reaches is worth more as a labelled dead
 * row than as a number that looks like it is doing something.
 */
export function overrideRows(
    configured: ConfiguredOverrides,
    capacity: number | undefined,
): readonly OverrideRow[] {
    const known = capacity !== undefined;
    const triggerFraction = numberAt(configured.compactionTriggerFraction)
        ?? COMPACTION_TRIGGER_FRACTION;
    const triggerTokens = effectiveTriggerTokens(
        numberAt(configured.compactionTriggerTokens),
        capacity,
    );
    const shadowed = known && triggerTokens !== undefined
        && triggerTokens <= (capacity as number) * triggerFraction;
    const level = agingLevel(stringAt(configured.toolResultAgingLevel), capacity);

    return [
        row("contextLimit", configured.contextLimit, capacity),
        row(
            "compactionTriggerFraction",
            configured.compactionTriggerFraction,
            COMPACTION_TRIGGER_FRACTION,
            !known
                ? `${UNKNOWN_WINDOW}, so a share of it decides nothing`
                : shadowed
                ? `the token trigger fires first, at ${triggerTokens}`
                : undefined,
        ),
        row(
            "compactionTriggerTokens",
            configured.compactionTriggerTokens,
            triggerTokens === undefined ? undefined : triggerTokens,
            triggerTokens === undefined
                ? "the window is known, so the fraction decides"
                : undefined,
        ),
        row(
            "compactionTargetTokens",
            configured.compactionTargetTokens,
            undefined,
            known
                ? "the window is known, so the target is a share of it"
                : undefined,
        ),
        row(
            "postCompactionTargetFraction",
            configured.postCompactionTargetFraction,
            POST_COMPACTION_TARGET_FRACTION,
            known ? undefined : `${UNKNOWN_WINDOW}, so the target is not a share`,
        ),
        row("summaryWordCap", configured.summaryWordCap, MAX_SUMMARY_WORDS),
        row("retainedUserTurns", configured.retainedUserTurns, RETAINED_USER_TURNS),
        row(
            "toolResultCeilingBytes",
            configured.toolResultCeilingBytes,
            TOOL_RESULT_CEILING_BYTES,
        ),
        row(
            "toolResultTotalBudgetBytes",
            configured.toolResultTotalBudgetBytes,
            TOOL_RESULT_TOTAL_BUDGET_BYTES,
        ),
        row(
            "toolResultStubAfterTurns",
            configured.toolResultStubAfterTurns,
            TOOL_RESULT_AGING_LEVELS[level].ageAfterTurns,
        ),
        row("toolResultAgingLevel", configured.toolResultAgingLevel, level),
    ];
}

function numberAt(value: number | string | undefined): number | undefined {
    return typeof value === "number" ? value : undefined;
}

function stringAt(value: number | string | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** What a config would hold for each lever once one more pick lands on it. */
function configuredAfter(
    rows: readonly OverrideRow[],
    patch: OverridePick,
): ConfiguredOverrides {
    const configured: Record<string, number | string> = {};
    for (const entry of rows) {
        if (entry.source === "configured" && entry.value !== undefined) {
            configured[entry.key] = entry.value;
        }
    }
    for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) {
            delete configured[key];
        } else {
            configured[key] = value;
        }
    }
    return configured as ConfiguredOverrides;
}

function asBytes(value: number): string {
    return `${Math.round(value / 1_024)}k`;
}

/** One pane pick: a value per lever it sets, or null to drop back to the shipped default. */
export type OverridePick = {
    readonly [K in OverrideKey]?: number | string | null;
};

/**
 * Why a pick cannot stand beside the levers already set, or undefined when it
 * can. Two levers that are each fine alone can contradict each other, and a
 * config holding such a pair does not load at all, so the pane that offers
 * both has to say no before the write rather than after it.
 *
 * The comparisons mirror the parsers exactly, including which side falls back
 * to a default, so a pick this allows is a pick that loads.
 */
export function overrideConflict(
    rows: readonly OverrideRow[],
    patch: OverridePick,
): string | undefined {
    const configured = configuredAfter(rows, patch);
    const target = numberAt(configured.postCompactionTargetFraction);
    if (target !== undefined) {
        const trigger = numberAt(configured.compactionTriggerFraction)
            ?? COMPACTION_TRIGGER_FRACTION;
        if (target >= trigger) {
            return `A ${target.toFixed(2)} summary target is not under the`
                + ` ${trigger.toFixed(2)} trigger.`;
        }
    }
    const ceiling = numberAt(configured.toolResultCeilingBytes)
        ?? TOOL_RESULT_CEILING_BYTES;
    const total = numberAt(configured.toolResultTotalBudgetBytes)
        ?? TOOL_RESULT_TOTAL_BUDGET_BYTES;
    if (ceiling > total) {
        return `A ${asBytes(total)} total budget is under the`
            + ` ${asBytes(ceiling)} one-result ceiling.`;
    }
    return undefined;
}

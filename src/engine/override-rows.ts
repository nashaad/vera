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

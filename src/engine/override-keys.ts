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


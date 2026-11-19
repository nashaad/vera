import type { UsageModelRow } from "../../src/annex/usage-report.ts";

export interface SpendShare {
    readonly label: string;
    readonly percentage?: number;
}

export function spendShare(
    rows: readonly Pick<UsageModelRow, "kind" | "share">[],
): SpendShare {
    if (rows.every((row) => row.kind === "unpriced")) {
        return { label: "\u2014" };
    }
    const percentage = Math.round(rows.reduce((sum, row) => sum + row.share, 0) * 100);
    return { label: `${percentage}%`, percentage };
}

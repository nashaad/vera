import type { UsageModelRow } from "../../src/annex/usage-report.ts";

interface EstimateBasis {
    readonly estimatedFromOpenRouter: boolean;
    readonly totals: { readonly spend: { readonly estimated: number } };
    readonly models: readonly Pick<UsageModelRow, "provider" | "model" | "kind">[];
}

export function hasEstimatedSpend(report: EstimateBasis): boolean {
    return report.estimatedFromOpenRouter
        || report.totals.spend.estimated !== 0
        || report.models.some((row) => row.kind === "estimated");
}

export interface ApprovalReview {
    readonly decision: "deny";
    readonly reason: string;
    readonly riskLevel: "low" | "medium" | "high" | "critical";
    readonly model?: string;
}

export function approvalReviewText(review: ApprovalReview): string {
    const classifier = review.model === undefined || review.model.length === 0
        ? "The classifier"
        : `The classifier, ${review.model},`;
    const risk = review.riskLevel.charAt(0).toUpperCase() + review.riskLevel.slice(1);
    return `${classifier} denied this. ${risk} risk: ${review.reason}`;
}

export function parseApprovalReview(value: unknown): ApprovalReview | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.decision !== "deny" || typeof record.reason !== "string") return undefined;
    const riskLevel = record.riskLevel;
    if (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high" && riskLevel !== "critical") return undefined;
    const model = typeof record.model === "string" && record.model.length > 0 ? record.model : undefined;
    return {
        decision: "deny",
        reason: record.reason,
        riskLevel,
        ...(model === undefined ? {} : { model }),
    };
}

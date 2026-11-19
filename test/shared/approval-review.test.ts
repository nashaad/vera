import { expect, test } from "bun:test";

import { approvalReviewText, parseApprovalReview } from "../../clients/shared/approval-review.ts";

test("review facts format the classifier model, risk, and reason", () => {
    expect(approvalReviewText({ decision: "deny", model: "reviewer-model", riskLevel: "high", reason: "The action is unsafe." }))
        .toBe("The classifier, reviewer-model, denied this. High risk: The action is unsafe.");
    expect(approvalReviewText({ decision: "deny", riskLevel: "critical", reason: "Unsafe." }))
        .toBe("The classifier denied this. Critical risk: Unsafe.");
});

test("approval review facts reject malformed decisions and risk levels", () => {
    expect(parseApprovalReview({ decision: "allow", riskLevel: "high", reason: "Unsafe." })).toBeUndefined();
    expect(parseApprovalReview({ decision: "deny", riskLevel: "unknown", reason: "Unsafe." })).toBeUndefined();
    expect(parseApprovalReview({ decision: "deny", riskLevel: "high" })).toBeUndefined();
});

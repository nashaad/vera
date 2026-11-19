import type {
    MediateReviewDecision,
    ReviewDecisionMediationRequest,
} from "../engine/loop-services.ts";
import type { ToolApprovalUiRequest } from "../engine/events.ts";

const DENIAL_APPROVAL_LIMIT = 16;
const DENIAL_APPROVAL_KEY = "classifier-denial";

export const mediateReviewDecision: MediateReviewDecision = ({
    review,
    workspace,
    approvalMode,
    chat,
}: ReviewDecisionMediationRequest) => {
    if (review.decision !== "deny" || approvalMode !== "auto") return undefined;
    const model = review.model === undefined
        ? undefined
        : review.model.provider === undefined
            ? review.model.model
            : `${review.model.provider}/${review.model.model}`;
    return {
        reason: review.reason,
        options: {
            restrictedChoices: true,
            allowNotes: false,
            review: {
                decision: "deny",
                reason: review.reason,
                riskLevel: review.riskLevel,
                ...(model === undefined ? {} : { model }),
            },
            workspace,
            ...(chat === true ? { chat: true as const } : {}),
            pendingLimit: denialApprovalLimit(),
        },
    };
};

export function denialApprovalLimitForRequest(
    request: ToolApprovalUiRequest,
): { readonly key: string; readonly max: number } | undefined {
    return request.review?.decision === "deny" ? denialApprovalLimit() : undefined;
}

function denialApprovalLimit(): { readonly key: string; readonly max: number } {
    return { key: DENIAL_APPROVAL_KEY, max: DENIAL_APPROVAL_LIMIT };
}

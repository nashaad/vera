import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { approvalReviewText } from "../../clients/shared/approval-review.ts";
import { ApprovalCard } from "../../clients/ui/src/session/ApprovalCard.tsx";
import { requestKeyAction, requestKeyResponse } from "../../clients/ui/src/session/requestKeys.ts";
import { paneAnswerContext } from "../../clients/ui/src/session/requests.ts";
import { initialWatch, reduceWatch } from "../../clients/ui/src/session/transcript.ts";
import { parseSessionLine } from "../../clients/ui/src/session/wire.ts";

const review = {
    decision: "deny",
    model: "crow/reviewer",
    riskLevel: "high",
    reason: "The action is unsafe.",
} as const;

const approval = {
    mode: "ask",
    pending: false,
    modes: ["readonly", "ask", "auto"],
    grants: [],
    preferences: [],
};

test("@core desktop session and chat panes preserve a denied review from the host", () => {
    const message = parseSessionLine(JSON.stringify({
        type: "ui_request",
        requestId: "approval-1",
        request: {
            type: "tool_approval",
            toolCall: { id: "call-1", name: "bash", input: { command: "touch /outside/plank" } },
            reason: review.reason,
            warning: "",
            review,
            restrictedChoices: true,
            allowNotes: false,
            permissionGrants: [{ kind: "tool", when: { tool: "bash" }, scope: "session" }],
        },
    }));
    if (message?.type !== "ui_request") throw new Error("Expected a request");
    const watch = reduceWatch(initialWatch("agent-1"), message);
    const request = watch.requests[0];
    if (request?.kind !== "approval") throw new Error("Expected an approval");

    for (const pane of ["main", "chat:0"] as const) {
        const context = paneAnswerContext(pane, approval);
        const html = renderToStaticMarkup(createElement(ApprovalCard, {
            request,
            ...context,
            onDecide: () => undefined,
        }));
        expect(html).toContain(approvalReviewText(review));
        expect(html).toContain("The classifier, crow/reviewer, denied this. High risk: The action is unsafe.");
        expect(html).toContain("Yes, this time");
        expect(html).toContain(">No<");
        expect(html).not.toContain("Yes, for this chat");
        expect(html).not.toContain("always allow");
        expect(html).not.toContain("switch to Approve");
        expect(html).not.toContain("<input");

        for (const [key, decision] of [["1", "allow_once"], ["2", "deny"]] as const) {
            const action = requestKeyAction(request, key, context);
            if (action === undefined) throw new Error("Expected an approval action");
            const response = requestKeyResponse(request, action, "");
            if (response === undefined) throw new Error("Expected an approval response");
            expect(JSON.parse(response)).toEqual({
                type: "ui_response",
                requestId: "approval-1",
                response: { type: "tool_approval", decision },
            });
        }
        expect(requestKeyAction(request, "3", context)).toBeUndefined();
    }
});

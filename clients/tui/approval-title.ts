import type { ToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { approvalHeadline } from "../shared/approval-headline.ts";
import { tuiApprovalPath } from "./approval-body.ts";

export interface TuiApprovalQuestion {
    readonly question: string;
    readonly folder?: string;
}

// Undefined when the grants say too little; the card then keeps its tool title.
export function tuiApprovalQuestion(
    update: ToolApprovalUiRequestUpdate,
): TuiApprovalQuestion | undefined {
    const request = update.request;
    const call = request.toolCall;
    const headline = approvalHeadline({
        tool: call.name,
        input: call.input as Readonly<Record<string, unknown>>,
        grants: (request.permissionGrants ?? []).map((grant) => grant.when),
        shell: call.name === "bash",
        ...(request.workspace === undefined || request.workspace.length === 0
            ? {}
            : { workspace: request.workspace }),
        chat: request.chat === true,
    });
    if (headline === undefined) return undefined;
    return {
        question: headline.question,
        ...(headline.folder === undefined
            ? {}
            : { folder: tuiApprovalPath(headline.folder) }),
    };
}

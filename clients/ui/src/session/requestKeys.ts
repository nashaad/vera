// Keyboard answers to the open request a window shows first, and the focus rule that decides
// when those keys are read at all.

import { approvalAnswersFor, approvalResponse, questionResponse, setupResponse, type ApprovalAnswerContext, type ApprovalDecision, type OpenRequest } from "./requests.ts";

export type RequestKeyAction =
    | { readonly type: "decide"; readonly decision: ApprovalDecision; readonly switchToAuto?: true }
    | { readonly type: "choose"; readonly index: number }
    | { readonly type: "cancel" }
    | { readonly type: "dismiss" };

export interface KeyModifiers {
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly altKey: boolean;
}

export interface FocusedElement {
    readonly tagName: string;
    readonly isContentEditable: boolean;
    readonly classes: readonly string[];
    // True for a textarea with no text in it.
    readonly empty: boolean;
}

export function requestKeyAction(
    request: OpenRequest,
    key: string,
    context: ApprovalAnswerContext = {},
): RequestKeyAction | undefined {
    switch (request.kind) {
        case "approval":
            return approvalKeyAction(approvalAnswersFor(request, context), key);
        case "question":
            return questionKeyAction(request.choices.length, key);
        case "setup":
            return key === "Escape" ? { type: "dismiss" } : undefined;
    }
}

// The response line for an action. `notes` is the question's note text, read only for a choice.
export function requestKeyResponse(request: OpenRequest, action: RequestKeyAction, notes: string): string | undefined {
    switch (action.type) {
        case "decide":
            return request.kind === "approval" ? approvalResponse(request.requestId, action.decision) : undefined;
        case "choose": {
            if (request.kind !== "question") return undefined;
            const choice = request.choices[action.index];
            if (choice === undefined) return undefined;
            return questionResponse(request.requestId, {
                outcome: "selected",
                choiceId: choice.id,
                ...(request.allowNotes ? { notes } : {}),
            });
        }
        case "cancel":
            return request.kind === "question" ? questionResponse(request.requestId, { outcome: "cancelled" }) : undefined;
        case "dismiss":
            return request.kind === "setup" ? setupResponse(request.requestId, "unavailable") : undefined;
    }
}

// Digits and Escape are ignored while a modifier is held or while focus is in a field that takes
// typing. An empty composer is the one textarea that yields, so a digit answers a card when the
// person has not started a message.
export function requestKeysAllowed(modifiers: KeyModifiers, focused: FocusedElement | null): boolean {
    if (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey) return false;
    if (focused === null) return true;
    if (focused.isContentEditable) return false;
    switch (focused.tagName) {
        case "INPUT":
        case "SELECT":
            return false;
        case "TEXTAREA":
            return focused.classes.includes("composer-input") && focused.empty;
        default:
            return true;
    }
}

// The row's number is its position in the answers offered, so an answer that is left out
// leaves no gap.
function approvalKeyAction(
    answers: readonly { readonly decision: ApprovalDecision; readonly switchToAuto?: true }[],
    key: string,
): RequestKeyAction | undefined {
    if (key === "Escape") return { type: "decide", decision: "deny" };
    if (!/^[1-9]$/.test(key)) return undefined;
    const answer = answers[Number(key) - 1];
    if (answer === undefined) return undefined;
    return {
        type: "decide",
        decision: answer.decision,
        ...(answer.switchToAuto === true ? { switchToAuto: true as const } : {}),
    };
}

function questionKeyAction(choiceCount: number, key: string): RequestKeyAction | undefined {
    if (key === "Escape") return { type: "cancel" };
    if (!/^[1-9]$/.test(key)) return undefined;
    const index = Number(key) - 1;
    return index < choiceCount ? { type: "choose", index } : undefined;
}

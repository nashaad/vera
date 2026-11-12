// Approvals and questions a session is waiting on, read from `ui_request` updates,
// and the `ui_response` lines that answer them.

import { describePredicate } from "./permissions.ts";

export interface ApprovalRequest {
    readonly kind: "approval";
    readonly requestId: string;
    readonly tool: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly reason: string;
    readonly warning: string;
    // Set when a subagent asked; the session-wide choices are then not offered.
    readonly sourceAgentId?: string;
    readonly sourceTask?: string;
    // What Allow similar and Always would remember, in words; empty means neither is offered.
    readonly grants: readonly string[];
}

export interface QuestionChoice {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly recommended: boolean;
}

export interface QuestionRequest {
    readonly kind: "question";
    readonly requestId: string;
    readonly question: string;
    readonly choices: readonly QuestionChoice[];
    readonly allowCustom: boolean;
    readonly customLabel?: string;
    readonly allowNotes: boolean;
    // An out-of-band question does not hold the turn.
    readonly outOfBand: boolean;
}

export interface SetupRequest {
    readonly kind: "setup";
    readonly requestId: string;
    readonly reason: string;
    readonly waiting: number;
}

export type OpenRequest = ApprovalRequest | QuestionRequest | SetupRequest;

// An open request the turn cannot go on without. An out-of-band question lets the work continue.
export function holdsTurn(requests: readonly OpenRequest[]): boolean {
    return requests.some((request) => request.kind !== "question" || !request.outOfBand);
}

export type ApprovalDecision = "allow_once" | "allow_similar" | "allow_always" | "deny";

export interface PastApproval {
    readonly request: ApprovalRequest;
    readonly decision: ApprovalDecision;
}

// Answered approvals kept for the transcript, newest last.
export const PAST_APPROVAL_LIMIT = 10;

export function rememberApproval(past: readonly PastApproval[], entry: PastApproval): readonly PastApproval[] {
    return [...past, entry].slice(-PAST_APPROVAL_LIMIT);
}

// What an answered approval leaves behind: nothing for an allow, one muted line for a denial, the whole card when kept.
export function pastApprovalView(entry: PastApproval, keepCards: boolean): "card" | "line" | "none" {
    if (keepCards) return "card";
    return entry.decision === "deny" ? "line" : "none";
}

export interface QuestionSelected {
    readonly outcome: "selected";
    readonly choiceId: string;
    readonly notes?: string;
}

export interface QuestionCustom {
    readonly outcome: "custom";
    readonly text: string;
}

export interface QuestionCancelled {
    readonly outcome: "cancelled";
}

export type QuestionAnswer = QuestionSelected | QuestionCustom | QuestionCancelled;

export type SetupOutcome = "configured" | "cancelled" | "unavailable";

type Fields = Record<string, unknown>;

export function parseUiRequest(value: Fields): OpenRequest | undefined {
    const requestId = str(value.requestId);
    const request = value.request;
    if (requestId === undefined || !isRecord(request)) return undefined;
    switch (request.type) {
        case "tool_approval":
            return parseApproval(requestId, request);
        case "user_question":
            return parseQuestion(requestId, request);
        case "configuration_required":
            return parseSetup(requestId, request);
        default:
            return undefined;
    }
}

function parseApproval(requestId: string, request: Fields): ApprovalRequest | undefined {
    const call = request.toolCall;
    if (!isRecord(call)) return undefined;
    const tool = str(call.name);
    if (tool === undefined) return undefined;
    const sourceAgentId = str(request.sourceAgentId);
    const sourceTask = str(request.sourceTask);
    return {
        kind: "approval",
        requestId,
        tool,
        input: isRecord(call.input) ? call.input : {},
        reason: str(request.reason) ?? "",
        warning: str(request.warning) ?? "",
        ...(sourceAgentId === undefined ? {} : { sourceAgentId }),
        ...(sourceTask === undefined ? {} : { sourceTask }),
        grants: Array.isArray(request.permissionGrants)
            ? request.permissionGrants.map((grant) => describePredicate(isRecord(grant) && isRecord(grant.when) ? grant.when : {}))
            : [],
    };
}

function parseQuestion(requestId: string, request: Fields): QuestionRequest | undefined {
    const question = str(request.question);
    if (question === undefined || !Array.isArray(request.choices)) return undefined;
    const choices: QuestionChoice[] = [];
    for (const raw of request.choices) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        const label = str(raw.label);
        if (id === undefined || label === undefined) continue;
        const description = str(raw.description);
        choices.push({
            id,
            label,
            ...(description === undefined ? {} : { description }),
            recommended: raw.recommended === true,
        });
    }
    const customLabel = str(request.customLabel);
    return {
        kind: "question",
        requestId,
        question,
        choices,
        allowCustom: request.allowCustom === true,
        ...(customLabel === undefined ? {} : { customLabel }),
        allowNotes: request.allowNotes === true,
        outOfBand: request.outOfBand === true,
    };
}

function parseSetup(requestId: string, request: Fields): SetupRequest | undefined {
    const reason = str(request.reason);
    if (reason === undefined) return undefined;
    const pending = isRecord(request.pendingAction) ? request.pendingAction : {};
    const waiting = typeof pending.count === "number" && Number.isFinite(pending.count) ? pending.count : 1;
    return { kind: "setup", requestId, reason, waiting };
}

// Subagent approvals offer only Allow once and Deny, as in the terminal.
export function approvalChoices(request: ApprovalRequest): readonly ApprovalDecision[] {
    if (request.sourceAgentId !== undefined || request.grants.length === 0) return ["allow_once", "deny"];
    return ["allow_once", "allow_similar", "allow_always", "deny"];
}

export function approvalResponse(requestId: string, decision: ApprovalDecision): string {
    return line({ type: "ui_response", requestId, response: { type: "tool_approval", decision } });
}

export function questionResponse(requestId: string, answer: QuestionAnswer): string {
    return line({ type: "ui_response", requestId, response: { type: "user_question", ...trimmed(answer) } });
}

export function setupResponse(requestId: string, outcome: SetupOutcome): string {
    return line({ type: "ui_response", requestId, response: { type: "configuration_required", outcome } });
}

function trimmed(answer: QuestionAnswer): QuestionAnswer {
    if (answer.outcome === "custom") return { outcome: "custom", text: answer.text.trim() };
    if (answer.outcome === "selected" && answer.notes !== undefined) {
        const notes = answer.notes.trim();
        return notes.length === 0
            ? { outcome: "selected", choiceId: answer.choiceId }
            : { outcome: "selected", choiceId: answer.choiceId, notes };
    }
    return answer;
}

export function addRequest(requests: readonly OpenRequest[], request: OpenRequest): readonly OpenRequest[] {
    return [...requests.filter((open) => open.requestId !== request.requestId), request];
}

export function closeRequest(requests: readonly OpenRequest[], requestId: string): readonly OpenRequest[] {
    return requests.filter((open) => open.requestId !== requestId);
}

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

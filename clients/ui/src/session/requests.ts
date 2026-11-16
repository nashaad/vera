// Approvals and questions a session is waiting on, read from `ui_request` updates,
// and the `ui_response` lines that answer them.

import {
    approvalAnswers,
    type ApprovalAnswer,
    type ApprovalAnswerGrant,
    type ApprovalDecision,
} from "../../../shared/approval-answers.ts";
import { describePredicate } from "./permissions.ts";

export interface ApprovalRequest {
    readonly kind: "approval";
    readonly requestId: string;
    readonly tool: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly reason: string;
    readonly warning: string;
    // Set when a subagent asked; it takes no remembered answer and no typed answer.
    readonly sourceAgentId?: string;
    readonly sourceTask?: string;
    // Only Yes, this time and No: an ask from permission_rules cannot be lifted.
    readonly restrictedChoices?: boolean;
    // What the grant answers would remember, in words; empty means neither is offered.
    readonly grants: readonly string[];
    // The `when` objects the grants were read from, as the host sent them.
    readonly grantPredicates: readonly Readonly<Record<string, unknown>>[];
    // The working folder of the session whose tool asks, and whether it is that session's own chat folder.
    // An older host sends neither.
    readonly workspace?: string;
    readonly chat?: true;
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

export type { ApprovalDecision } from "../../../shared/approval-answers.ts";

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
    const workspace = str(request.workspace);
    const predicates = Array.isArray(request.permissionGrants)
        ? request.permissionGrants.map((grant): Fields => (isRecord(grant) && isRecord(grant.when) ? grant.when : {}))
        : [];
    return {
        kind: "approval",
        requestId,
        tool,
        input: isRecord(call.input) ? call.input : {},
        reason: str(request.reason) ?? "",
        warning: str(request.warning) ?? "",
        ...(sourceAgentId === undefined ? {} : { sourceAgentId }),
        ...(sourceTask === undefined ? {} : { sourceTask }),
        ...(request.restrictedChoices === true ? { restrictedChoices: true } : {}),
        grants: predicates.map(describePredicate),
        grantPredicates: predicates,
        ...(workspace === undefined || workspace.length === 0 ? {} : { workspace }),
        ...(request.chat === true ? { chat: true as const } : {}),
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

// A subagent asked when either source field is set.
export function isSubagentApproval(request: ApprovalRequest): boolean {
    return request.sourceAgentId !== undefined || request.sourceTask !== undefined;
}

// The session facts that decide which answers an approval offers.
export interface ApprovalAnswerContext {
    readonly mode?: string;
    readonly modes?: readonly string[];
}

// The answers an approval offers, in order, from the shared module both clients read.
export function approvalAnswersFor(
    request: ApprovalRequest,
    context: ApprovalAnswerContext = {},
): readonly ApprovalAnswer[] {
    return approvalAnswers({
        grants: request.grantPredicates.map(answerGrant),
        subagent: isSubagentApproval(request),
        restricted: request.restrictedChoices === true,
        mode: context.mode ?? "",
        modes: context.modes ?? [],
    });
}

function answerGrant(when: Readonly<Record<string, unknown>>): ApprovalAnswerGrant {
    const grant: { -readonly [K in keyof ApprovalAnswerGrant]: ApprovalAnswerGrant[K] } = {};
    for (const key of ["tool", "verb", "path", "operation", "host", "executable"] as const) {
        const value = when[key];
        if (typeof value === "string") grant[key] = value;
    }
    return grant;
}

// `notes` is what the person typed to tell Vera what to do instead. The host closes the connection when notes
// come with an allow, so only a deny carries them; blank text is left out.
export function approvalResponse(requestId: string, decision: ApprovalDecision, notes?: string): string {
    const text = decision === "deny" ? notes?.trim() ?? "" : "";
    const response = { type: "tool_approval", decision, ...(text.length === 0 ? {} : { notes: text }) };
    return line({ type: "ui_response", requestId, response });
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

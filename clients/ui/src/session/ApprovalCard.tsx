import { useId, useState, type JSX } from "react";

import { alwaysAllowWords } from "../../../shared/approval-answers.ts";
import { approvalReviewText } from "../../../shared/approval-review.ts";
import { approvalDetailField, approvalHeadline, type HeadlineGrant } from "../../../shared/approval-headline.ts";
import { shortenPath } from "../components/homePath.ts";
import { ChevronRightIcon, WarningIcon } from "../components/Icons.tsx";
import { ChoiceCard, type ChoiceRow } from "./ChoiceCard.tsx";
import { approvalAnswersFor, isSubagentApproval, type ApprovalDecision, type ApprovalRequest } from "./requests.ts";
import { actionOf, askTarget, askTitle } from "./toolTitle.ts";

const INPUT_PREVIEW_LIMIT = 400;
const NOTES_LIMIT = 2000;
const NOTES_PLACEHOLDER = "Or tell Vera what to do instead";

export interface ApprovalCardProps {
    readonly request: ApprovalRequest;
    // Set once the request was answered: the card then shows the answer instead of the choices.
    readonly outcome?: ApprovalDecision;
    // The session's working folder and whether it is a chat, which the headline needs to say "outside this chat's folder".
    readonly workspace?: string;
    readonly chat?: boolean;
    // The session's mode and the modes it offers, which decide the switch answer.
    readonly mode?: string;
    readonly modes?: readonly string[];
    // `notes` is set only by the typed answer, which always denies. `switchToAuto` marks answer 3.
    readonly onDecide: (decision: ApprovalDecision, notes?: string, switchToAuto?: boolean) => void;
}

const OUTCOME_TEXT: Readonly<Record<ApprovalDecision, string>> = {
    allow_once: "Allowed",
    allow_similar: "Allowed for this chat",
    allow_always: "Always allowed",
    deny: "Denied",
};

export function ApprovalCard({
    request,
    outcome,
    workspace,
    chat = false,
    mode = "",
    modes = [],
    onDecide,
}: ApprovalCardProps) {
    const answers = approvalAnswersFor(request, { mode, modes });
    const answered = outcome !== undefined;
    const shell = actionOf(request.tool) === "shell";
    // What a subagent is told never reaches it, so its approvals take no typed answer.
    const subagent = isSubagentApproval(request);
    const headline = approvalHeadline({
        tool: request.tool,
        input: request.input,
        grants: request.grantPredicates.map(headlineGrant),
        shell,
        ...(workspace === undefined || workspace.length === 0 ? {} : { workspace }),
        chat,
    });
    const path = stringField(request.input, "path");
    const detailField = approvalDetailField(request.tool);
    const detail = detailField === undefined ? undefined : stringField(request.input, detailField);
    const rows: readonly ChoiceRow[] = answered
        ? []
        : answers.map((answer, index) => ({
            id: answer.decision + (answer.switchToAuto === true ? ":auto" : ""),
            key: String(index + 1),
            label: answer.label,
            onPick: () => onDecide(
                answer.decision,
                undefined,
                answer.switchToAuto === true,
            ),
        }));
    const typed = answered || subagent || request.allowNotes === false
        ? undefined
        : { placeholder: NOTES_PLACEHOLDER, submitLabel: "Send", maxLength: NOTES_LIMIT, onSubmit: (text: string) => onDecide("deny", text) };
    const remembers = answers.some((answer) =>
        answer.decision === "allow_similar" || answer.decision === "allow_always"
    );
    const rememberWords = remembers
        ? alwaysAllowWords(request.grantPredicates.map(grantField))
        : undefined;

    return (
        <ChoiceCard
            kind="approval"
            requestId={request.requestId}
            answered={answered}
            title={headline === undefined ? <FallbackTitle request={request} path={path} /> : <span className="request-title">{headline.question}</span>}
            aside={(
                <>
                    {request.sourceAgentId === undefined ? null : (
                        <span className="request-badge">subagent {request.sourceAgentId.slice(0, 8)}</span>
                    )}
                    {request.sourceTask === undefined ? null : <span className="request-task">{request.sourceTask}</span>}
                </>
            )}
            close={{ label: "Deny", title: "Deny (Esc)", onClose: () => onDecide("deny") }}
            {...(request.review === undefined ? {} : { intro: <p>{approvalReviewText(request.review)}</p> })}
            rows={rows}
            {...(typed === undefined ? {} : { typed })}
            footer={answered ? <div className="request-outcome" data-decision={outcome}>{OUTCOME_TEXT[outcome]}</div> : null}
        >
            <Fold
                request={request}
                shell={shell}
                preview={shell ? null : approvalPreview(request, path, detail)}
                {...(headline?.folder === undefined ? {} : { folder: headline.folder })}
                open={headline === undefined || headline.commandOpen}
                {...(rememberWords === undefined ? {} : { rememberWords })}
            />
        </ChoiceCard>
    );
}

// What stays in the transcript when an approval was denied and past approvals are off.
export function DeniedLine({ request }: { readonly request: ApprovalRequest }) {
    const target = askTarget(request.tool, request.input);
    return (
        <p className="request-denied" data-request-id={request.requestId}>
            Denied: {askTitle(request.tool)}{target.length === 0 ? "" : ` ${target}`}
        </p>
    );
}

// The head used when the headline has nothing to say: the action and what it acts on.
function FallbackTitle({ request, path }: { readonly request: ApprovalRequest; readonly path: string | undefined }) {
    const target = askTarget(request.tool, request.input);
    return (
        <>
            <span className="request-tool">{askTitle(request.tool)}</span>
            {target.length === 0 ? null : <span className={path === target ? "card-path" : "card-target"}>{target}</span>}
        </>
    );
}

// What a tool other than a shell shows in the fold: a script in full, the size of a write, or its arguments.
function approvalPreview(request: ApprovalRequest, path: string | undefined, detail: string | undefined): JSX.Element | null {
    if (detail !== undefined) return <pre className="request-code request-script"><code>{detail}</code></pre>;
    const content = stringField(request.input, "content");
    if (path !== undefined) {
        return request.tool === "write" && content !== undefined ? <p className="request-muted">{lineCount(content)} lines</p> : null;
    }
    return Object.keys(request.input).length > 0 ? <pre className="request-code"><code>{previewInput(request.input)}</code></pre> : null;
}

interface FoldProps {
    readonly request: ApprovalRequest;
    readonly shell: boolean;
    readonly preview: JSX.Element | null;
    // Where the action lands, unshortened.
    readonly folder?: string;
    // Whether the fold starts open.
    readonly open: boolean;
    // Whether to say what Yes, for this chat and Yes, and always allow remember.
    readonly rememberWords?: string;
}

function Fold({ request, shell, preview, folder, open: startsOpen, rememberWords }: FoldProps) {
    const [open, setOpen] = useState(startsOpen);
    const bodyId = useId();
    const command = shell ? stringField(request.input, "command") : undefined;
    const hasReason = request.review === undefined && request.reason.length > 0;
    const hasWarning = request.warning.length > 0;
    if (command === undefined && preview === null && folder === undefined && !hasReason && !hasWarning && rememberWords === undefined) return null;
    return (
        <div className="request-fold" data-open={open}>
            <button type="button" className="request-fold-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
                <ChevronRightIcon className="chev" />
                <span>{shell ? "Show command" : "Show details"}</span>
            </button>
            {open ? (
                <div className="request-fold-body" id={bodyId}>
                    {folder === undefined ? null : <p className="request-folder" title={folder}>{`In ${shortenPath(folder)}`}</p>}
                    {command === undefined ? null : <pre className="request-code"><code>{`$ ${command}`}</code></pre>}
                    {preview}
                    {hasReason ? <p>{request.reason}</p> : null}
                    {hasWarning ? (
                        <p className="request-muted request-warning">
                            <WarningIcon />
                            <span>{request.warning}</span>
                        </p>
                    ) : null}
                    {rememberWords === undefined ? null : (
                        <p>
                            {`Yes, for this chat remembers ${rememberWords} for this session. Yes, and always allow saves it for every session.`}
                        </p>
                    )}
                </div>
            ) : null}
        </div>
    );
}

// Keeps only the predicate fields the answers read, and only when they are text.
function grantField(when: Readonly<Record<string, unknown>>): HeadlineGrant & { host?: string } {
    const tool = textField(when, "tool");
    const verb = textField(when, "verb");
    const path = textField(when, "path");
    const operation = textField(when, "operation");
    const executable = textField(when, "executable");
    const host = textField(when, "host");
    return {
        ...(tool === undefined ? {} : { tool }),
        ...(verb === undefined ? {} : { verb }),
        ...(path === undefined ? {} : { path }),
        ...(operation === undefined ? {} : { operation }),
        ...(executable === undefined ? {} : { executable }),
        ...(host === undefined ? {} : { host }),
    };
}

function headlineGrant(when: Readonly<Record<string, unknown>>): HeadlineGrant {
    const tool = textField(when, "tool");
    const verb = textField(when, "verb");
    const path = textField(when, "path");
    const operation = textField(when, "operation");
    const executable = textField(when, "executable");
    return {
        ...(tool === undefined ? {} : { tool }),
        ...(verb === undefined ? {} : { verb }),
        ...(path === undefined ? {} : { path }),
        ...(operation === undefined ? {} : { operation }),
        ...(executable === undefined ? {} : { executable }),
    };
}

function textField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function lineCount(text: string): number {
    return text.length === 0 ? 0 : text.split("\n").length;
}

function previewInput(input: Readonly<Record<string, unknown>>): string {
    const text = JSON.stringify(input);
    return text.length > INPUT_PREVIEW_LIMIT ? `${text.slice(0, INPUT_PREVIEW_LIMIT)}…` : text;
}

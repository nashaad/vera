import { useState } from "react";

import { HandIcon, TerminalIcon, WarningIcon } from "../components/Icons.tsx";
import { approvalChoices, type ApprovalDecision, type ApprovalRequest } from "./requests.ts";
import { askTarget, askTitle } from "./toolTitle.ts";

const INPUT_PREVIEW_LIMIT = 400;

export interface ApprovalCardProps {
    readonly request: ApprovalRequest;
    // Set once the request was answered: the card then shows the answer instead of the choices.
    readonly outcome?: ApprovalDecision;
    readonly onDecide: (decision: ApprovalDecision) => void;
}

const OUTCOME_TEXT: Readonly<Record<ApprovalDecision, string>> = {
    allow_once: "Allowed once",
    allow_similar: "Allowed for similar requests",
    allow_always: "Always allowed",
    deny: "Denied",
};

export function ApprovalCard({ request, outcome, onDecide }: ApprovalCardProps) {
    const [why, setWhy] = useState(false);
    const offered = approvalChoices(request);
    const path = stringField(request.input, "path");
    const target = askTarget(request.tool, request.input);
    const Icon = request.tool === "bash" ? TerminalIcon : HandIcon;

    return (
        <div className="request-card" data-kind="approval" data-request-id={request.requestId} data-answered={outcome !== undefined}>
            <div className="request-head">
                <Icon />
                <span className="request-head-main">
                    <span className="request-tool">{askTitle(request.tool)}</span>
                    {target.length === 0 ? null : <span className={path === target ? "card-path" : "card-target"}>{target}</span>}
                </span>
                {request.sourceAgentId === undefined ? null : (
                    <span className="request-badge">subagent {request.sourceAgentId.slice(0, 8)}</span>
                )}
                {request.sourceTask === undefined ? null : <span className="request-task">{request.sourceTask}</span>}
            </div>
            <ApprovalBody request={request} path={path} />
            {why ? <WhyBlock request={request} showGrants={offered.includes("allow_similar")} /> : null}
            {outcome === undefined ? (
                <div className="request-actions">
                    <button type="button" className="button button-primary" onClick={() => onDecide("allow_once")}>
                        Allow once <kbd className="kbd">1</kbd>
                    </button>
                    {offered.includes("allow_similar") ? (
                        <button type="button" className="button request-ghost" onClick={() => onDecide("allow_similar")}>
                            Allow similar <kbd className="kbd">2</kbd>
                        </button>
                    ) : null}
                    {offered.includes("allow_always") ? (
                        <button type="button" className="button request-ghost" onClick={() => onDecide("allow_always")}>
                            Always <kbd className="kbd">4</kbd>
                        </button>
                    ) : null}
                    <button type="button" className="button request-ghost" aria-expanded={why} onClick={() => setWhy(!why)}>
                        Why?
                    </button>
                    <span className="request-spacer" />
                    <button type="button" className="button request-danger" onClick={() => onDecide("deny")}>
                        Deny <kbd className="kbd">esc</kbd>
                    </button>
                </div>
            ) : (
                <div className="request-outcome" data-decision={outcome}>{OUTCOME_TEXT[outcome]}</div>
            )}
        </div>
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

function ApprovalBody({ request, path }: { readonly request: ApprovalRequest; readonly path: string | undefined }) {
    const command = stringField(request.input, "command");
    const content = stringField(request.input, "content");
    const hasKeys = Object.keys(request.input).length > 0;
    return (
        <div className="request-body">
            {request.tool === "bash" && command !== undefined ? (
                <pre className="request-code"><code>{`$ ${command}`}</code></pre>
            ) : path !== undefined ? (
                request.tool === "write" && content !== undefined ? <p className="request-muted">{lineCount(content)} lines</p> : null
            ) : hasKeys ? (
                <pre className="request-code"><code>{previewInput(request.input)}</code></pre>
            ) : null}
            {request.warning.length === 0 ? null : (
                <p className="request-muted request-warning">
                    <WarningIcon />
                    <span>{request.warning}</span>
                </p>
            )}
        </div>
    );
}

function WhyBlock({ request, showGrants }: { readonly request: ApprovalRequest; readonly showGrants: boolean }) {
    const grantText = showGrants && request.grants.length > 0;
    if (request.reason.length === 0 && !grantText) {
        return <div className="request-why">Vera gave no reason for this request.</div>;
    }
    return (
        <div className="request-why">
            {request.reason.length === 0 ? null : <p>{request.reason}</p>}
            {grantText ? (
                <p>
                    Allow similar remembers this for the session, and Always for every session: {request.grants.join(", ")}
                </p>
            ) : null}
        </div>
    );
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

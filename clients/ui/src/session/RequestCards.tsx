import { useCallback, useEffect, useState } from "react";

import { useAppearance } from "../theme/useAppearance.ts";
import { ApprovalCard, DeniedLine } from "./ApprovalCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { requestKeyAction, requestKeyResponse, requestKeysAllowed, type FocusedElement } from "./requestKeys.ts";
import { approvalResponse, pastApprovalView, rememberApproval, type ApprovalDecision, type OpenRequest, type PastApproval } from "./requests.ts";
import { SetupCard } from "./SetupCard.tsx";

export interface RequestCardsProps {
    readonly requests: readonly OpenRequest[];
    readonly send: (line: string) => void;
    // True while a turn runs. The answered approvals of the last turn go when the next one starts.
    readonly running: boolean;
}

// Keys answer the first unanswered request. A question or setup card stays on screen after its answer until the
// host closes it. An answered approval leaves the cards: a denial keeps one muted line, an allow keeps nothing.
export function RequestCards({ requests, send, running }: RequestCardsProps) {
    const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
    const [past, setPast] = useState<readonly PastApproval[]>([]);
    const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
    const { pastApprovals } = useAppearance();
    const first = requests.find((request) => !answered.has(request.requestId));

    useEffect(() => {
        if (running) setPast([]);
    }, [running]);

    const respond = useCallback(
        (request: OpenRequest, line: string, decision?: ApprovalDecision): void => {
            send(line);
            setAnswered((previous) => new Set(previous).add(request.requestId));
            if (request.kind === "approval" && decision !== undefined) {
                setPast((previous) => rememberApproval(previous, { request, decision }));
            }
        },
        [send],
    );

    useEffect(() => {
        if (first === undefined) return undefined;
        const onKey = (event: KeyboardEvent): void => {
            // Number keys belong to an open sheet, not to the cards under it.
            if (document.querySelector("[aria-modal='true']") !== null) return;
            if (!requestKeysAllowed(event, focusedElement())) return;
            const action = requestKeyAction(first, event.key);
            if (action === undefined) return;
            const line = requestKeyResponse(first, action, notes[first.requestId] ?? "");
            if (line === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            respond(first, line, action.type === "decide" ? action.decision : undefined);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [first, notes, respond]);

    return (
        <>
            {past.map((entry) => {
                const view = pastApprovalView(entry, pastApprovals);
                if (view === "card") {
                    return <ApprovalCard key={entry.request.requestId} request={entry.request} outcome={entry.decision} onDecide={noDecision} />;
                }
                return view === "line" ? <DeniedLine key={entry.request.requestId} request={entry.request} /> : null;
            })}
            {requests.map((request) => {
                if (answered.has(request.requestId) && request.kind === "approval") return null;
                const done = answered.has(request.requestId);
                const onRespond = (line: string): void => respond(request, line);
                switch (request.kind) {
                    case "approval":
                        return (
                            <ApprovalCard
                                key={request.requestId}
                                request={request}
                                onDecide={(decision) => respond(request, approvalResponse(request.requestId, decision), decision)}
                            />
                        );
                    case "question":
                        return (
                            <QuestionCard
                                key={request.requestId}
                                request={request}
                                answered={done}
                                notes={notes[request.requestId] ?? ""}
                                onNotes={(value) => setNotes((previous) => ({ ...previous, [request.requestId]: value }))}
                                onRespond={onRespond}
                            />
                        );
                    case "setup":
                        return <SetupCard key={request.requestId} request={request} answered={done} onRespond={onRespond} />;
                }
            })}
        </>
    );
}

function noDecision(): void {}

function focusedElement(): FocusedElement | null {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    return {
        tagName: element.tagName,
        isContentEditable: element.isContentEditable,
        classes: [...element.classList],
        empty: element instanceof HTMLTextAreaElement && element.value === "",
    };
}

import { useCallback, useEffect, useState } from "react";

import { ApprovalCard } from "./ApprovalCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { requestKeyAction, requestKeyResponse, requestKeysAllowed, type FocusedElement } from "./requestKeys.ts";
import type { OpenRequest } from "./requests.ts";
import { SetupCard } from "./SetupCard.tsx";

export interface RequestCardsProps {
    readonly requests: readonly OpenRequest[];
    readonly send: (line: string) => void;
}

// Keys answer the first unanswered request. A card stays on screen after its answer until the host closes it.
export function RequestCards({ requests, send }: RequestCardsProps) {
    const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
    const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
    const first = requests.find((request) => !answered.has(request.requestId));

    const respond = useCallback(
        (requestId: string, line: string): void => {
            send(line);
            setAnswered((previous) => new Set(previous).add(requestId));
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
            respond(first.requestId, line);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [first, notes, respond]);

    return (
        <>
            {requests.map((request) => {
                const done = answered.has(request.requestId);
                const onRespond = (line: string): void => respond(request.requestId, line);
                switch (request.kind) {
                    case "approval":
                        return <ApprovalCard key={request.requestId} request={request} answered={done} onRespond={onRespond} />;
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
            {first === undefined ? null : (
                <div className="request-waiting">
                    <span className="request-waiting-dots" aria-hidden="true">••</span>
                    Waiting on you
                </div>
            )}
        </>
    );
}

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

import { useEffect, useState } from "react";

import { RewindIcon, XIcon } from "../components/Icons.tsx";
import { freshRequestId } from "../composer/requests.ts";
import { relativeTime } from "../protocol/sessions.ts";
import { useRouter } from "../pages/router.tsx";
import type { ActiveSession } from "./activeSession.ts";
import { offerDraft } from "./drafts.ts";
import type { TimelineBoundary, TimelinePlan, TimelineRejection } from "./model.ts";
import { applyTimelineCommand, listTimelineCommand, previewRewindCommand } from "./wireTools.ts";

export interface RewindSheetProps {
    readonly session: ActiveSession;
    readonly onClose: () => void;
}

// One rewind at a time. A preview waits for its plan; applying waits for the conversation to change.
type RewindStep =
    | { readonly stage: "previewing"; readonly requestId: string; readonly boundary: TimelineBoundary }
    | { readonly stage: "applying"; readonly requestId: string; readonly boundary: TimelineBoundary; readonly planId: string };

const REJECTION_TEXT: Readonly<Record<TimelineRejection, string>> = {
    busy: "Rewind waits until the turn ends.",
    plan_expired: "The preview expired; choose the prompt again.",
    not_plan_owner: "Another window started this rewind.",
    boundary_missing: "That prompt is no longer in the conversation.",
    session_changed: "The conversation changed; choose the prompt again.",
    unavailable: "This session cannot rewind.",
};

export function RewindSheet({ session, onClose }: RewindSheetProps) {
    const router = useRouter();
    const [listId] = useState(() => freshRequestId("timeline"));
    const [step, setStep] = useState<RewindStep | undefined>(undefined);
    const [forking, setForking] = useState(false);
    const [forkProblem, setForkProblem] = useState<string | undefined>(undefined);
    const reply = session.watch.timeline;

    useEffect(() => {
        session.send(listTimelineCommand(listId));
    }, [listId]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const appliedRequestId = step?.stage === "applying" && reply?.kind === "applied" && reply.requestId === step.requestId
        ? step.requestId
        : undefined;
    useEffect(() => {
        if (appliedRequestId === undefined || step === undefined) return;
        offerDraft(session.agentId, step.boundary.prompt);
        onClose();
    }, [appliedRequestId]);

    const boundaries = reply?.kind === "list" && reply.requestId === listId ? reply.boundaries : undefined;
    const rows = boundaries === undefined ? undefined : [...boundaries].sort((left, right) => right.position - left.position);
    const previewed: TimelinePlan | undefined = step?.stage === "previewing" && reply?.kind === "preview" && reply.requestId === step.requestId
        ? reply.plan
        : undefined;
    const refusal = step !== undefined && reply?.kind === "rejected" && reply.requestId === step.requestId
        ? REJECTION_TEXT[reply.reason]
        : undefined;

    const rewind = (boundary: TimelineBoundary) => {
        const requestId = freshRequestId("rewind");
        setStep({ stage: "previewing", requestId, boundary });
        session.send(previewRewindCommand(requestId, boundary.userMessageId));
    };

    const apply = () => {
        if (step === undefined || step.stage !== "previewing" || previewed === undefined) return;
        const requestId = freshRequestId("rewind");
        setStep({ stage: "applying", requestId, boundary: step.boundary, planId: previewed.planId });
        session.send(applyTimelineCommand(requestId, previewed.planId));
    };

    const fork = async (boundary: TimelineBoundary) => {
        setForking(true);
        setForkProblem(undefined);
        const result = await session.bridge.branchSession(session.agentId, boundary.userMessageId);
        if (!result.ok) {
            setForking(false);
            setForkProblem(result.reason);
            return;
        }
        offerDraft(result.agentId, result.prompt);
        router.navigate({
            kind: "session",
            agentId: result.agentId,
            title: firstLine(result.prompt) || `Fork of ${session.title}`,
            ...(session.chat ? { chat: true } : { workspace: result.workspace }),
        });
        onClose();
    };

    return (
        <div
            className="sheet-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="sheet session-sheet" role="dialog" aria-modal="true" aria-labelledby="rewind-sheet-title">
                <div className="sheet-head">
                    <RewindIcon className="session-sheet-icon" />
                    <span className="session-sheet-title" id="rewind-sheet-title">Rewind or fork</span>
                    <button type="button" className="sheet-x" onClick={onClose} aria-label="Close">
                        <XIcon />
                    </button>
                </div>

                <div className="sheet-body session-sheet-body">
                    {step !== undefined ? (
                        <StepView
                            step={step}
                            previewed={previewed}
                            refusal={refusal}
                            onApply={apply}
                            onBack={() => setStep(undefined)}
                        />
                    ) : rows === undefined ? (
                        <p className="session-sheet-text">Loading prompts…</p>
                    ) : rows.length === 0 ? (
                        <p className="session-sheet-text">No prompts to go back to yet.</p>
                    ) : (
                        <>
                            <p className="session-sheet-text">
                                Rewinding sets aside everything after a prompt. Forking keeps this session and starts a new
                                one from that point.
                            </p>
                            <ul className="rewind-list">
                                {rows.map((boundary) => (
                                    <BoundaryRow
                                        key={boundary.userMessageId}
                                        boundary={boundary}
                                        busy={forking}
                                        onRewind={() => rewind(boundary)}
                                        onFork={() => void fork(boundary)}
                                    />
                                ))}
                            </ul>
                        </>
                    )}
                    {forkProblem === undefined ? null : (
                        <p className="session-notice session-notice-error" role="alert">{forkProblem}</p>
                    )}
                </div>
            </div>
        </div>
    );
}

interface BoundaryRowProps {
    readonly boundary: TimelineBoundary;
    readonly busy: boolean;
    readonly onRewind: () => void;
    readonly onFork: () => void;
}

function BoundaryRow({ boundary, busy, onRewind, onFork }: BoundaryRowProps) {
    const age = boundary.timestamp === undefined ? undefined : relativeTime(boundary.timestamp, Date.now());
    return (
        <li className="rewind-row">
            <div className="rewind-text">
                <span className="rewind-prompt">{firstLine(boundary.prompt) || "No text"}</span>
                {age === undefined ? null : (
                    <span className="rewind-age">{age === "now" ? "just now" : `${age} ago`}</span>
                )}
            </div>
            <div className="rewind-actions">
                <button
                    type="button"
                    className="session-button session-button-danger"
                    disabled={busy || boundary.hasImages}
                    title={boundary.hasImages ? "Prompts with images cannot be rewound." : undefined}
                    onClick={onRewind}
                >
                    Rewind here
                </button>
                <button type="button" className="session-button" disabled={busy} onClick={onFork}>
                    Fork from here
                </button>
            </div>
        </li>
    );
}

interface StepViewProps {
    readonly step: RewindStep;
    readonly previewed: TimelinePlan | undefined;
    readonly refusal: string | undefined;
    readonly onApply: () => void;
    readonly onBack: () => void;
}

function StepView({ step, previewed, refusal, onApply, onBack }: StepViewProps) {
    if (refusal !== undefined) {
        return (
            <>
                <p className="session-notice session-notice-warning" role="status">{refusal}</p>
                <div className="session-sheet-foot-row">
                    <button type="button" className="session-button" onClick={onBack}>Back</button>
                </div>
            </>
        );
    }
    if (step.stage === "applying") {
        return <p className="session-sheet-text">Rewinding…</p>;
    }
    if (previewed === undefined) {
        return <p className="session-sheet-text">Checking the rewind…</p>;
    }
    return (
        <>
            <p className="session-sheet-text">
                Rewind to this prompt? Keeps {previewed.keptMessageCount} messages and sets aside{" "}
                {previewed.setAsideMessageCount}. The prompt comes back to the composer to edit.
            </p>
            <div className="session-sheet-foot-row">
                <button type="button" className="session-button session-button-danger" onClick={onApply}>Rewind</button>
                <button type="button" className="session-button" onClick={onBack}>Back</button>
            </div>
        </>
    );
}

function firstLine(text: string): string {
    return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

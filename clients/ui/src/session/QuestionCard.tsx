import { useState, type KeyboardEvent } from "react";

import { QuestionIcon } from "../components/Icons.tsx";
import { questionResponse, type QuestionRequest } from "./requests.ts";

export interface QuestionCardProps {
    readonly request: QuestionRequest;
    readonly answered: boolean;
    readonly notes: string;
    readonly onNotes: (notes: string) => void;
    readonly onRespond: (line: string) => void;
}

export function QuestionCard({ request, answered, notes, onNotes, onRespond }: QuestionCardProps) {
    const [custom, setCustom] = useState("");
    const trimmedCustom = custom.trim();
    const placeholder = request.customLabel ?? "Something else";
    const answerCustom = (): void => {
        if (answered || trimmedCustom.length === 0) return;
        onRespond(questionResponse(request.requestId, { outcome: "custom", text: trimmedCustom }));
    };
    const onCustomKey = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") answerCustom();
    };

    return (
        <div className="request-card" data-kind="question" data-request-id={request.requestId} data-answered={answered}>
            <div className="request-head">
                <QuestionIcon />
                <span className="request-head-main">
                    <span className="request-title">{request.question}</span>
                </span>
            </div>
            <div className="request-body">
                <div className="request-choices">
                    {request.choices.map((choice, index) => (
                        <button
                            key={choice.id}
                            type="button"
                            className="request-choice"
                            disabled={answered}
                            onClick={() =>
                                onRespond(
                                    questionResponse(request.requestId, {
                                        outcome: "selected",
                                        choiceId: choice.id,
                                        ...(request.allowNotes ? { notes } : {}),
                                    }),
                                )
                            }
                        >
                            <span className="request-choice-top">
                                <kbd className="kbd">{index + 1}</kbd>
                                <span className="request-choice-label">{choice.label}</span>
                                {choice.recommended ? <span className="request-badge">Recommended</span> : null}
                            </span>
                            {choice.description === undefined ? null : (
                                <span className="request-choice-description">{choice.description}</span>
                            )}
                        </button>
                    ))}
                </div>
                {request.allowCustom ? (
                    <div className="request-custom">
                        <input
                            className="request-input"
                            type="text"
                            value={custom}
                            placeholder={placeholder}
                            aria-label={placeholder}
                            disabled={answered}
                            onChange={(event) => setCustom(event.target.value)}
                            onKeyDown={onCustomKey}
                        />
                        <button
                            type="button"
                            className="button"
                            disabled={answered || trimmedCustom.length === 0}
                            onClick={answerCustom}
                        >
                            Answer
                        </button>
                    </div>
                ) : null}
                {request.allowNotes ? (
                    <label className="request-field">
                        <span className="request-label">Add a note (optional)</span>
                        <textarea
                            className="request-textarea"
                            rows={2}
                            value={notes}
                            disabled={answered}
                            onChange={(event) => onNotes(event.target.value)}
                        />
                    </label>
                ) : null}
                {request.outOfBand ? <p className="request-note">Vera keeps working while this waits.</p> : null}
            </div>
            <div className="request-actions">
                <span className="request-spacer" />
                <button
                    type="button"
                    className="button request-ghost"
                    disabled={answered}
                    onClick={() => onRespond(questionResponse(request.requestId, { outcome: "cancelled" }))}
                >
                    Skip <kbd className="kbd">esc</kbd>
                </button>
            </div>
        </div>
    );
}

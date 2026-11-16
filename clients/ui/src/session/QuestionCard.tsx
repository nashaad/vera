import { ChoiceCard, type ChoiceRow } from "./ChoiceCard.tsx";
import { questionResponse, type QuestionRequest } from "./requests.ts";

export interface QuestionCardProps {
    readonly request: QuestionRequest;
    readonly answered: boolean;
    readonly notes: string;
    readonly onNotes: (notes: string) => void;
    readonly onRespond: (line: string) => void;
}

export function QuestionCard({ request, answered, notes, onNotes, onRespond }: QuestionCardProps) {
    const placeholder = request.customLabel ?? "Something else";
    const rows: readonly ChoiceRow[] = request.choices.map((choice, index) => ({
        id: choice.id,
        key: String(index + 1),
        label: choice.label,
        ...(choice.description === undefined ? {} : { description: choice.description }),
        ...(choice.recommended ? { badge: "Recommended" } : {}),
        onPick: () => onRespond(questionResponse(request.requestId, {
            outcome: "selected",
            choiceId: choice.id,
            ...(request.allowNotes ? { notes } : {}),
        })),
    }));

    return (
        <ChoiceCard
            kind="question"
            requestId={request.requestId}
            answered={answered}
            title={<span className="request-title">{request.question}</span>}
            close={{ label: "Skip", title: "Skip (Esc)", onClose: () => onRespond(questionResponse(request.requestId, { outcome: "cancelled" })) }}
            rows={rows}
            {...(request.allowCustom
                ? {
                    typed: {
                        placeholder,
                        submitLabel: "Answer",
                        onSubmit: (text: string) => onRespond(questionResponse(request.requestId, { outcome: "custom", text })),
                    },
                }
                : {})}
        >
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
        </ChoiceCard>
    );
}

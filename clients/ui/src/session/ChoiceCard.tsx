import { useState, type KeyboardEvent, type ReactNode } from "react";

import { ArrowRightIcon, ComposeIcon, XIcon } from "../components/Icons.tsx";

// A card that asks the person to pick: a question in the head with a close button, numbered rows,
// and an optional typed answer. Approvals and Vera's questions render through it.

export interface ChoiceRow {
    // Set on the row as data-choice.
    readonly id: string;
    // The key that picks the row.
    readonly key: string;
    readonly label: string;
    readonly description?: string;
    readonly badge?: string;
    readonly onPick: () => void;
}

export interface TypedAnswer {
    readonly placeholder: string;
    readonly submitLabel: string;
    readonly maxLength?: number;
    // Called with the trimmed text, never empty.
    readonly onSubmit: (text: string) => void;
}

export interface ChoiceCardClose {
    readonly label: string;
    readonly title: string;
    readonly onClose: () => void;
}

export interface ChoiceCardProps {
    readonly kind: string;
    readonly requestId: string;
    readonly answered: boolean;
    // The question.
    readonly title: ReactNode;
    // Shown between the question and the close button, such as a badge.
    readonly aside?: ReactNode;
    readonly close: ChoiceCardClose;
    // Shown before the choices.
    readonly intro?: ReactNode;
    // An empty list shows no rows.
    readonly rows: readonly ChoiceRow[];
    readonly typed?: TypedAnswer;
    // Shown under the rows and the typed answer.
    readonly children?: ReactNode;
    // Shown under the body, across the card.
    readonly footer?: ReactNode;
}

export function ChoiceCard({ kind, requestId, answered, title, aside, close, intro, rows, typed, children, footer }: ChoiceCardProps) {
    return (
        <div className="request-card choice-card" data-kind={kind} data-request-id={requestId} data-answered={answered}>
            <div className="request-head">
                <span className="request-head-main">{title}</span>
                {aside}
                <button
                    type="button"
                    className="icon-button request-close"
                    aria-label={close.label}
                    title={close.title}
                    disabled={answered}
                    onClick={close.onClose}
                >
                    <XIcon />
                </button>
            </div>
            <div className="request-body" onKeyDown={moveBetweenRows}>
                {intro === undefined ? null : <div className="request-intro">{intro}</div>}
                {rows.length === 0 ? null : (
                    <div className="request-choices">
                        {rows.map((row) => (
                            <button
                                key={row.id}
                                type="button"
                                className="request-choice"
                                data-choice={row.id}
                                disabled={answered}
                                onClick={row.onPick}
                            >
                                <span className="request-choice-top">
                                    <kbd className="kbd">{row.key}</kbd>
                                    <span className="request-choice-label">{row.label}</span>
                                    {row.badge === undefined ? null : <span className="request-badge">{row.badge}</span>}
                                    <ArrowRightIcon className="request-choice-go" />
                                </span>
                                {row.description === undefined ? null : (
                                    <span className="request-choice-description">{row.description}</span>
                                )}
                            </button>
                        ))}
                    </div>
                )}
                {typed === undefined ? null : <TypedRow typed={typed} answered={answered} />}
                {children}
            </div>
            {footer}
        </div>
    );
}

function TypedRow({ typed, answered }: { readonly typed: TypedAnswer; readonly answered: boolean }) {
    const [text, setText] = useState("");
    const trimmed = text.trim();
    const submit = (): void => {
        if (answered || trimmed.length === 0) return;
        typed.onSubmit(trimmed);
    };
    const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") submit();
    };
    return (
        <div className="request-custom">
            <ComposeIcon className="request-custom-mark" />
            <input
                className="request-input"
                type="text"
                value={text}
                {...(typed.maxLength === undefined ? {} : { maxLength: typed.maxLength })}
                placeholder={typed.placeholder}
                aria-label={typed.placeholder}
                disabled={answered}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKey}
            />
            <button type="button" className="button" disabled={answered || trimmed.length === 0} onClick={submit}>
                {typed.submitLabel}
            </button>
        </div>
    );
}

// Up and Down move between the rows and the typed answer, like a menu.
function moveBetweenRows(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const stops = [...event.currentTarget.querySelectorAll<HTMLElement>(".request-choice:not(:disabled), .request-custom .request-input:not(:disabled)")];
    const at = stops.indexOf(event.target as HTMLElement);
    if (at === -1) return;
    const next = stops[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
}

import { useRef, useState } from "react";
import { XIcon } from "../components/Icons.tsx";
import { PointerIcon } from "../components/PointerIcon.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import type { PageCapture } from "./page-captures.ts";

export interface PageCaptureChipItem {
    readonly key: string;
    readonly number: number;
    readonly capture: PageCapture;
    readonly attaching: boolean;
}

export interface PageCaptureChipProps {
    readonly item: PageCaptureChipItem;
    readonly onRemove: (key: string) => void;
}

interface ExpandableTextProps {
    readonly label: string;
    readonly value: string;
}

function ExpandableText({ label, value }: ExpandableTextProps) {
    const preview = value.slice(0, 300);
    return (
        <div>
            <strong>{label}</strong>
            <pre className="request-code">{preview}</pre>
            {value.length <= 300 ? null : (
                <details>
                    <summary>Show more</summary>
                    <pre className="request-code">{value}</pre>
                </details>
            )}
        </div>
    );
}

export function PageCaptureChip({ item, onRemove }: PageCaptureChipProps) {
    const [open, setOpen] = useState(false);
    const [details, setDetails] = useState(false);
    const root = useRef<HTMLSpanElement>(null);
    const placement = usePopoverPlacement(open, root);
    const { capture } = item;
    const selection = capture.details;
    const title = selection === undefined
        ? `Image ${item.number}`
        : `<${selection.tag} /> ${selection.text.slice(0, 24)}${selection.text.length > 24 ? "…" : ""}`;
    return (
        <span
            ref={root}
            className="chip chip-file page-capture-chip"
            data-attaching={item.attaching}
            tabIndex={0}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={(event) => {
                if (!event.currentTarget.contains(document.activeElement)) setOpen(false);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
                if (event.key === "Escape" && open) {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                }
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !event.currentTarget.matches(":hover")) setOpen(false);
            }}
        >
            <PointerIcon className="chip-icon" />
            <span className="chip-label">{item.attaching ? `${title}, attaching` : title}</span>
            <button
                type="button"
                className="chip-x"
                title={`Remove ${title}`}
                aria-label={`Remove ${title}`}
                onClick={() => onRemove(item.key)}
            ><XIcon className="chip-x-icon" /></button>
            {open ? (
                <span
                    className="context-pop page-capture-pop"
                    role="dialog"
                    dir="auto"
                    data-popover="above-start"
                    style={placement}
                >
                    <strong className="page-capture-heading">Included with your message</strong>
                    <img className="feedback-thumbnail" src={capture.preview} alt="" />
                    {selection === undefined ? (
                        <p>Image {item.number}</p>
                    ) : (
                        <>
                            <p className="page-capture-row"><strong>Element</strong><span dir="auto">{`<${selection.tag} /> ${selection.selector}`}</span></p>
                            <p className="page-capture-row"><strong>Text</strong><span dir="auto">{selection.text}</span></p>
                            <button type="button" className="page-capture-details" aria-expanded={details} onClick={() => setDetails((value) => !value)}>
                                <span aria-hidden="true">{details ? "⌄" : "›"}</span>{details ? "Hide details" : "Show more details"}
                            </button>
                            {details ? (
                                <>
                                    <strong>Computed styles</strong>
                                    <pre className="request-code">{selection.styles}</pre>
                                    <ExpandableText label="HTML" value={selection.html} />
                                    <ExpandableText label="Siblings" value={selection.siblings} />
                                </>
                            ) : null}
                        </>
                    )}
                </span>
            ) : null}
        </span>
    );
}

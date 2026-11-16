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
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onFocus={() => setOpen(true)}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
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
                    className="context-pop"
                    role="dialog"
                    data-popover="above-start"
                    style={placement}
                >
                    <strong>Included with your message</strong>
                    <img className="feedback-thumbnail" src={capture.preview} alt="" />
                    {selection === undefined ? (
                        <p>Image {item.number}</p>
                    ) : (
                        <>
                            <p><strong>Element</strong><br />{`<${selection.tag} /> ${selection.selector}`}</p>
                            <p><strong>Text</strong><br />{selection.text}</p>
                            {details ? (
                                <>
                                    <strong>Computed styles</strong>
                                    <pre className="request-code">{selection.styles}</pre>
                                    <ExpandableText label="HTML" value={selection.html} />
                                    <ExpandableText label="Siblings" value={selection.siblings} />
                                </>
                            ) : (
                                <button type="button" onClick={() => setDetails(true)}>Show details</button>
                            )}
                        </>
                    )}
                </span>
            ) : null}
        </span>
    );
}

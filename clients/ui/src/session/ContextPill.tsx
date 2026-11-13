import { useCallback, useRef, useState, type CSSProperties } from "react";

import { GaugeIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import { useMenuDismiss } from "../composer/useMenuDismiss.ts";
import type { ActiveSession } from "./activeSession.ts";
import type { ContextState } from "./model.ts";
import { tokenCount } from "./notices.ts";

export interface ContextPillProps {
    readonly session: ActiveSession;
    readonly onCompact: () => void;
}

type SegmentTone = "prompt-a" | "prompt-b" | "tools" | "conversation" | "other" | "free";

interface ContextSegment {
    readonly label: string;
    readonly tokens: number;
    readonly tone: SegmentTone;
}

// The context window as the title bar shows it: a percent when the capacity is known, tokens otherwise.
export function ContextPill({ session, onCompact }: ContextPillProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useMenuDismiss(open, root, close);
    const placed = usePopoverPlacement(open, root);
    const context = session.watch.context;

    const compact = () => {
        close();
        onCompact();
    };

    return (
        <div className="context-picker" ref={root}>
            <button
                type="button"
                className="pill-button context-pill"
                aria-haspopup="dialog"
                aria-expanded={open}
                title={context === undefined ? "No measurement yet" : "Context window usage"}
                data-empty={context === undefined}
                onClick={() => setOpen(!open)}
            >
                <GaugeIcon className="pill-icon" />
                <span className="pill-label">{pillLabel(context)}</span>
            </button>
            {open ? <ContextPopover context={context} onCompact={compact} style={placed} /> : null}
        </div>
    );
}

function pillLabel(context: ContextState | undefined): string {
    if (context === undefined) return "–";
    if (context.capacity === undefined) return tokenCount(context.tokens);
    return `${percentOf(context.tokens, context.capacity)}%`;
}

function percentOf(tokens: number, capacity: number): number {
    if (capacity <= 0) return 0;
    return Math.round((tokens / capacity) * 100);
}

interface ContextPopoverProps {
    readonly context: ContextState | undefined;
    readonly onCompact: () => void;
    readonly style: CSSProperties | undefined;
}

function ContextPopover({ context, onCompact, style }: ContextPopoverProps) {
    const [listing, setListing] = useState(false);
    if (context === undefined) {
        return (
            <div className="context-pop" role="dialog" data-popover="below-end" style={style} aria-label="Context usage">
                <p className="context-empty">No measurement yet.</p>
                <button type="button" className="context-compact" onClick={onCompact}>Compact</button>
            </div>
        );
    }

    const segments = contextSegments(context);
    const capacity = context.capacity;
    const messages = context.components.filter((component) => component.kind === "message");
    const headline = context.capacity === undefined
        ? `${tokenCount(context.tokens)} tokens`
        : `${tokenCount(context.tokens)} of ${tokenCount(context.capacity)} tokens`;
    const basis = context.estimated ? "estimated" : "measured";
    const trigger = triggerPosition(context);

    return (
        <div className="context-pop" role="dialog" data-popover="below-end" style={style} aria-label="Context usage">
            <div className="context-head">
                <span className="context-headline">{headline}</span>
                <span className="context-basis">{basis}</span>
            </div>

            {capacity === undefined ? null : (
                <div className="context-bar" aria-hidden="true">
                    {segments.map((segment) => (
                        <span
                            key={segment.label}
                            className={`context-seg context-seg-${segment.tone}`}
                            style={{ width: `${segmentPercent(segment.tokens, capacity)}%` }}
                        />
                    ))}
                    {trigger === undefined ? null : (
                        <span className="context-trigger" style={{ left: `${trigger}%` }} />
                    )}
                </div>
            )}

            <ul className="context-legend">
                {segments.map((segment) => (
                    <li key={segment.label} className="context-legend-row">
                        <span className={`context-swatch context-seg-${segment.tone}`} />
                        <span className="context-legend-label">{segment.label}</span>
                        <span className="context-legend-tokens">{tokenCount(segment.tokens)}</span>
                    </li>
                ))}
            </ul>

            {context.triggerTokens === undefined ? null : (
                <p className="context-trigger-note">Compacts automatically at {tokenCount(context.triggerTokens)}</p>
            )}

            <button
                type="button"
                className="context-toggle"
                aria-expanded={listing}
                onClick={() => setListing(!listing)}
            >
                {listing ? "Hide messages" : "List every message"}
            </button>
            {listing ? (
                <ul className="context-messages">
                    {messages.length === 0 ? <li className="context-message-empty">No messages yet.</li> : null}
                    {messages.map((message) => (
                        <li key={message.id} className="context-message">
                            <span className="context-message-name">{message.displayName}</span>
                            <span className="context-message-tokens">{tokenCount(message.estimatedTokens)}</span>
                        </li>
                    ))}
                </ul>
            ) : null}

            <button type="button" className="context-compact" onClick={onCompact}>Compact</button>
        </div>
    );
}

// Prompt contributions are grouped by name; tool definitions and messages each get one segment.
// Components are estimates, so whatever the measured total holds beyond them is shown as Other.
export function contextSegments(context: ContextState): readonly ContextSegment[] {
    const prompts = new Map<string, number>();
    let tools = 0;
    let conversation = 0;
    let counted = 0;
    for (const component of context.components) {
        counted += component.estimatedTokens;
        if (component.kind === "tool_schema") tools += component.estimatedTokens;
        else if (component.kind === "message") conversation += component.estimatedTokens;
        else prompts.set(component.displayName, (prompts.get(component.displayName) ?? 0) + component.estimatedTokens);
    }
    const segments: ContextSegment[] = [];
    let index = 0;
    for (const [label, tokens] of prompts) {
        segments.push({ label, tokens, tone: index % 2 === 0 ? "prompt-a" : "prompt-b" });
        index += 1;
    }
    if (tools > 0) segments.push({ label: "Tool definitions", tokens: tools, tone: "tools" });
    if (conversation > 0) segments.push({ label: "Conversation", tokens: conversation, tone: "conversation" });
    if (context.tokens > counted) segments.push({ label: "Other", tokens: context.tokens - counted, tone: "other" });
    if (context.capacity !== undefined) {
        segments.push({ label: "Free space", tokens: Math.max(0, context.capacity - context.tokens), tone: "free" });
    }
    return segments;
}

function segmentPercent(tokens: number, capacity: number): number {
    if (capacity <= 0) return 0;
    return Math.min(100, (tokens / capacity) * 100);
}

function triggerPosition(context: ContextState): number | undefined {
    if (context.capacity === undefined || context.capacity <= 0) return undefined;
    if (context.triggerFraction !== undefined) return context.triggerFraction * 100;
    if (context.triggerTokens === undefined) return undefined;
    return Math.min(100, (context.triggerTokens / context.capacity) * 100);
}

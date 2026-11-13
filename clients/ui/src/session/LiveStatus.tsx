import { useEffect, useRef, useState } from "react";

import { CheckIcon, ChevronRightIcon } from "../components/Icons.tsx";
import type { Checklist, CompactionState, RetryState, ToolCall } from "./model.ts";
import { CallList } from "./ToolRuns.tsx";
import { liveAction } from "./toolTitle.ts";

// The turn clock appears once the turn has run this long without anything else to say.
const CLOCK_AFTER_MS = 2_000;
// Streamed text is counted as one token per four characters; the host sends no count until the turn ends.
const CHARACTERS_PER_TOKEN = 4;

export function estimateTokens(characters: number): number {
    return Math.ceil(characters / CHARACTERS_PER_TOKEN);
}

// "12s" or "1m 4s".
export function elapsedText(milliseconds: number): string {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Redraws every second so the clock moves between the host's updates.
function useClock(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    return now;
}

function Dots() {
    return (
        <span className="live-dots" aria-hidden="true">
            <span />
            <span />
            <span />
        </span>
    );
}

export interface LiveStatusProps {
    // When the turn began, in epoch ms, when the history says; otherwise the clock starts when this mounts.
    readonly since?: number;
    // The calls of the run the turn is in, when no text follows them.
    readonly calls: readonly ToolCall[];
    // Text is the last thing the turn has written.
    readonly streaming: boolean;
    readonly tokens: number;
    readonly waiting: boolean;
    readonly retry?: RetryState;
    // Set while a compaction runs inside the turn.
    readonly compaction?: CompactionState;
}

// The one line at the end of a live turn. It changes its words, never its place.
export function LiveStatus({ since, calls, streaming, tokens, waiting, retry, compaction }: LiveStatusProps) {
    const now = useClock();
    const mounted = useRef(Date.now());
    const [open, setOpen] = useState(false);
    const started = since ?? mounted.current;
    const elapsed = Math.max(0, now - started);
    const clock = elapsedText(elapsed);

    if (waiting) {
        return (
            <div className="live-status" data-state="waiting">
                <Dots />
                <span className="label">Waiting on you</span>
            </div>
        );
    }

    if (compaction !== undefined) return <CompactionStatus compaction={compaction} />;

    const running = calls.filter((call) => call.state === "running");
    const current = running[running.length - 1];
    if (current !== undefined) {
        const { label, target } = liveAction(current);
        return (
            <div className="live-status-wrap">
                <button type="button" className="live-status" data-state="tool" aria-expanded={open} onClick={() => setOpen(!open)}>
                    <Dots />
                    <span className="label sweep">{label}</span>
                    {target === "" ? null : <span className="arg">{target}</span>}
                    <span className="clock">{clock}</span>
                    <ChevronRightIcon className="chev" />
                </button>
                {open ? <CallList calls={calls} /> : null}
            </div>
        );
    }

    if (retry !== undefined) {
        return (
            <div className="live-status" data-state="retrying">
                <Dots />
                <span className="label sweep">Retrying on {retry.model}</span>
                <span className="arg">attempt {retry.nextAttempt} of {retry.maxAttempts}</span>
                <span className="clock">{clock}</span>
            </div>
        );
    }

    if (streaming && tokens > 0) {
        return (
            <div className="live-status" data-state="writing">
                <Dots />
                <span className="clock">{clock} · {tokens.toLocaleString()} tokens</span>
            </div>
        );
    }

    return (
        <div className="live-status" data-state="thinking">
            <Dots />
            {elapsed >= CLOCK_AFTER_MS ? <span className="clock">{clock} ·</span> : null}
            <span className="label sweep">Thinking</span>
        </div>
    );
}

// The line at the end of the conversation while a compaction runs; its clock starts when the window hears of it.
export function CompactionStatus({ compaction }: { readonly compaction: CompactionState }) {
    const now = useClock();
    const mounted = useRef(Date.now());
    return (
        <div className="live-status" data-state="compacting" role="status">
            <Dots />
            <span className="label sweep">Compacting the conversation</span>
            {compaction.model === undefined ? null : <span className="arg">{compaction.model}</span>}
            <span className="clock">{elapsedText(now - mounted.current)}</span>
        </div>
    );
}

// The plan the turn wrote, under its newest text while the turn runs.
export function TaskCard({ checklist }: { readonly checklist: Checklist }) {
    return (
        <div className="task-card" role="list" aria-label="Plan">
            {checklist.items.map((item, index) => (
                <div key={index} className="task-row" role="listitem" data-done={item.done}>
                    <span className="task-glyph">{item.done ? <CheckIcon /> : <span className="task-ring" />}</span>
                    <span className="task-text">{item.text}</span>
                </div>
            ))}
        </div>
    );
}

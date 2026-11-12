import { Fragment, memo, useMemo, useRef, useState } from "react";

import { CheckIcon, ChevronRightIcon, CopyIcon } from "../components/Icons.tsx";
import { relativeTime } from "../protocol/sessions.ts";
import { useDesktopFlags } from "../state/useDesktopFlags.ts";
import { type FileChange, latestChecklist } from "./changes.ts";
import { copyText } from "./copyText.ts";
import { DiffRollup } from "./DiffRollup.tsx";
import { estimateTokens, LiveStatus, TaskCard } from "./LiveStatus.tsx";
import { DeliveryRow, NoticeRow, SubstitutionRow } from "./NoticeRows.tsx";
import { Markdown } from "./Markdown.tsx";
import type { AgentRunStatus, Block, RetryState, ThoughtBlock } from "./model.ts";
import { RunLine } from "./ToolRuns.tsx";
import { keepTurns, type Run, type Turn, type TurnRender } from "./turns.ts";

function formatSeconds(total: number): string {
    const seconds = Math.max(1, Math.round(total));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatWhen(at: number | undefined): string {
    const age = relativeTime(at, Date.now());
    if (age === "") return "";
    return age === "now" ? "just now" : `${age} ago`;
}

function exactWhen(at: number | undefined): string | undefined {
    return at === undefined ? undefined : new Date(at).toLocaleString();
}

// Seconds from the turn's prompt to its last recorded block, when both carry a time.
function turnSeconds(turn: Turn): number | undefined {
    const start = turn.user?.at ?? turn.work[0]?.at;
    const ends = [...turn.work, ...(turn.answer === undefined ? [] : [turn.answer])];
    const end = ends.reduce<number | undefined>((latest, block) => block.at ?? latest, undefined);
    if (start === undefined || end === undefined || end < start) return undefined;
    return (end - start) / 1000;
}

export interface TranscriptProps {
    readonly blocks: readonly Block[];
    // True while the agent is working; the last turn then shows its work open and no actions.
    readonly running: boolean;
    // The session folder, used to show changed files relative to it.
    readonly folder?: string;
    // What the agent is doing, for the status line at the end of the live turn.
    readonly status?: AgentRunStatus;
    // Set while a failed model request waits to be tried again.
    readonly retry?: RetryState;
}

export function Transcript({ blocks, running, folder, status = "working", retry }: TranscriptProps) {
    const { showReasoning } = useDesktopFlags();
    const kept = useRef<ReadonlyMap<string, TurnRender>>(new Map());
    const renders = useMemo<readonly TurnRender[]>(() => {
        const next = keepTurns(kept.current, blocks, { reasoning: showReasoning });
        kept.current = next.byKey;
        return next.renders;
    }, [blocks, showReasoning]);
    return (
        <>
            {renders.map((render, index) => {
                const live = running && index === renders.length - 1;
                return (
                    <TurnView
                        key={render.turn.key}
                        turn={render.turn}
                        rollups={render.rollups}
                        runs={render.runs}
                        folder={folder}
                        first={index === 0}
                        live={live}
                        waiting={live && status === "waiting"}
                        retry={live ? retry : undefined}
                    />
                );
            })}
        </>
    );
}

interface TurnViewProps {
    readonly turn: Turn;
    readonly rollups: ReadonlyMap<number, readonly FileChange[]>;
    readonly runs: ReadonlyMap<number, Run>;
    readonly folder?: string;
    readonly first: boolean;
    readonly live: boolean;
    readonly waiting: boolean;
    readonly retry: RetryState | undefined;
}

// Characters of text the turn has written so far, for the status line's token estimate.
function writtenCharacters(turn: Turn): number {
    const answer = turn.answer?.text.length ?? 0;
    return turn.work.reduce((total, block) => total + (block.kind === "text" ? block.text.length : 0), answer);
}

const TurnView = memo(function TurnView({ turn, rollups, runs, folder, first, live, waiting, retry }: TurnViewProps) {
    const [open, setOpen] = useState(true);
    const seconds = turnSeconds(turn);
    const showWork = open || live;
    // While the turn ends in a run of calls, the status line names the call and the run draws nothing yet.
    const liveRunEnd = live && turn.answer === undefined ? turn.work.length - 1 : -1;
    const liveRun = [...runs.values()].find((run) => run.end === liveRunEnd);
    const checklist = live ? latestChecklist(turn.work) : undefined;
    return (
        <div className="turn">
            {turn.user === undefined ? null : first ? (
                <div className="user-turn">{turn.user.text}</div>
            ) : (
                <div className="user-bubble-row"><div className="user-bubble">{turn.user.text}</div></div>
            )}
            {turn.work.length > 0 && !live ? (
                <button type="button" className="working-head" aria-expanded={open} onClick={() => setOpen(!open)}>
                    {seconds === undefined ? "Worked" : `Worked for ${formatSeconds(seconds)}`}
                    <ChevronRightIcon className="chev" />
                </button>
            ) : null}
            {showWork ? turn.work.map((block, index) => {
                const changes = rollups.get(index);
                const run = runs.get(index);
                const showRun = run !== undefined && !run.quiet && run.end !== liveRunEnd;
                return (
                    <Fragment key={block.key}>
                        {block.kind === "tools" ? (showRun ? <RunLine calls={run.calls} /> : null) : (
                            <BlockView block={block} next={turn.work[index + 1] ?? turn.answer} />
                        )}
                        {changes === undefined ? null : <DiffRollup changes={changes} folder={folder} />}
                    </Fragment>
                );
            }) : null}
            {turn.answer === undefined ? null : <Markdown text={turn.answer.text} fade={live} />}
            {checklist === undefined ? null : <TaskCard checklist={checklist} />}
            {live ? (
                <LiveStatus
                    {...(turn.user?.at === undefined ? {} : { since: turn.user.at })}
                    calls={liveRun?.calls ?? []}
                    streaming={turn.answer !== undefined}
                    tokens={estimateTokens(writtenCharacters(turn))}
                    waiting={waiting}
                    {...(retry === undefined ? {} : { retry })}
                />
            ) : null}
            {!live && (turn.answer !== undefined || turn.work.length > 0) ? <TurnActions turn={turn} /> : null}
        </div>
    );
});

const BlockView = memo(function BlockView({ block, next }: { readonly block: Block; readonly next?: Block }) {
    switch (block.kind) {
        case "user":
            return <div className="user-bubble-row"><div className="user-bubble">{block.text}</div></div>;
        case "thought":
            return <Thought block={block} next={next} />;
        case "text":
            return <Markdown text={block.text} />;
        case "tools":
            return null;
        case "notice":
            return <NoticeRow block={block} />;
        case "substitution":
            return <SubstitutionRow block={block} />;
        case "delivery":
            return <DeliveryRow block={block} />;
    }
});

function Thought({ block, next }: { readonly block: ThoughtBlock; readonly next?: Block }) {
    const [open, setOpen] = useState(false);
    if (block.live) {
        const lines = block.text.trim().split("\n");
        return (
            <div className="thinking-live">
                <span className="dots">···</span>
                <span className="line">{lines[lines.length - 1] ?? ""}</span>
            </div>
        );
    }
    const seconds = block.at !== undefined && next?.at !== undefined && next.at >= block.at
        ? (next.at - block.at) / 1000
        : undefined;
    return (
        <>
            <button type="button" className="thought-line" aria-expanded={open} onClick={() => setOpen(!open)}>
                Thought{seconds === undefined ? null : <span className="dur">{formatSeconds(seconds)}</span>}
                <ChevronRightIcon className="chev" />
            </button>
            {open ? <div className="thought-body">{block.text}</div> : null}
        </>
    );
}

function turnText(turn: Turn): string {
    if (turn.answer !== undefined) return turn.answer.text;
    return turn.work.filter((block) => block.kind === "text").map((block) => block.text).join("\n\n");
}

function TurnActions({ turn }: { readonly turn: Turn }) {
    const [copied, setCopied] = useState(false);
    const text = turnText(turn);
    const at = turn.user?.at ?? turn.work[0]?.at;
    const copy = async (): Promise<void> => {
        if (!(await copyText(text))) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
    };
    return (
        <div className="turn-actions">
            {text === "" ? null : (
                <button type="button" className="icon-button" title={copied ? "Copied" : "Copy reply"} onClick={() => void copy()}>
                    {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
            )}
            <span className="when" title={exactWhen(at)}>{formatWhen(at)}</span>
        </div>
    );
}

import { useState } from "react";

import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon } from "../components/Icons.tsx";
import { relativeTime } from "../protocol/sessions.ts";
import { Markdown } from "./Markdown.tsx";
import type { Block, TextBlock, ThoughtBlock, ToolCall, ToolsBlock, UserBlock } from "./model.ts";

interface Turn {
    readonly key: string;
    readonly user?: UserBlock;
    readonly work: readonly Block[];
    readonly answer?: TextBlock;
}

// A user block starts a turn; the trailing text of a turn is its answer and the rest is work.
export function toTurns(blocks: readonly Block[]): Turn[] {
    const turns: Turn[] = [];
    let user: UserBlock | undefined;
    let work: Block[] = [];
    let key = "start";
    const push = (): void => {
        if (user === undefined && work.length === 0) return;
        const last = work[work.length - 1];
        if (last !== undefined && last.kind === "text") turns.push({ key, user, work: work.slice(0, -1), answer: last });
        else turns.push({ key, user, work });
    };
    for (const block of blocks) {
        if (block.kind === "user") {
            push();
            user = block;
            work = [];
            key = block.key;
            continue;
        }
        if (user === undefined && work.length === 0) key = block.key;
        work.push(block);
    }
    push();
    return turns;
}

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

async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

export interface TranscriptProps {
    readonly blocks: readonly Block[];
    // True while the agent is working; the last turn then shows its work open and no actions.
    readonly running: boolean;
}

export function Transcript({ blocks, running }: TranscriptProps) {
    const turns = toTurns(blocks);
    return (
        <>
            {turns.map((turn, index) => (
                <TurnView key={turn.key} turn={turn} first={index === 0} live={running && index === turns.length - 1} />
            ))}
        </>
    );
}

function TurnView({ turn, first, live }: { readonly turn: Turn; readonly first: boolean; readonly live: boolean }) {
    const [open, setOpen] = useState(true);
    const seconds = turnSeconds(turn);
    const showWork = open || live;
    return (
        <>
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
            {showWork ? turn.work.map((block, index) => (
                <BlockView key={block.key} block={block} next={turn.work[index + 1] ?? turn.answer} />
            )) : null}
            {turn.answer === undefined ? null : <Markdown text={turn.answer.text} />}
            {!live && (turn.answer !== undefined || turn.work.length > 0) ? <TurnActions turn={turn} /> : null}
        </>
    );
}

function BlockView({ block, next }: { readonly block: Block; readonly next?: Block }) {
    switch (block.kind) {
        case "user":
            return <div className="user-bubble-row"><div className="user-bubble">{block.text}</div></div>;
        case "thought":
            return <Thought block={block} next={next} />;
        case "text":
            return <Markdown text={block.text} />;
        case "tools":
            return <ToolGroup block={block} />;
        case "notice":
            return <div className="transcript-notice" data-tone={block.tone}>{block.text}</div>;
    }
}

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

const VERBS: Readonly<Record<string, readonly [string, string]>> = {
    bash: ["Ran", "command"],
    read: ["Read", "file"],
    edit: ["Edited", "file"],
    write: ["Wrote", "file"],
    grep: ["Searched", "pattern"],
    list: ["Listed", "folder"],
    web_fetch: ["Fetched", "page"],
    web_download: ["Downloaded", "file"],
};

function argText(call: ToolCall, ...keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = call.args[key];
        if (typeof value === "string" && value.trim() !== "") return value.replace(/\s+/g, " ").trim();
    }
    return undefined;
}

function lastSegment(path: string): string {
    const parts = path.split(/[\\/]/).filter((part) => part !== "");
    return parts[parts.length - 1] ?? path;
}

// A past-tense phrase for a call, such as `Read host.ts` or `Searched for outrider in vera-hq`.
export function callLabel(call: ToolCall): string {
    const path = argText(call, "path", "file_path");
    const file = path === undefined ? undefined : lastSegment(path);
    switch (call.tool) {
        case "bash": {
            const command = argText(call, "command", "cmd");
            return command === undefined ? call.title : `Ran ${command}`;
        }
        case "read":
            return file === undefined ? call.title : `Read ${file}`;
        case "edit":
            return file === undefined ? call.title : `Edited ${file}`;
        case "write":
            return file === undefined ? call.title : `Wrote ${file}`;
        case "list":
            return file === undefined ? call.title : `Listed ${file}`;
        case "grep": {
            const pattern = argText(call, "pattern");
            if (pattern === undefined) return call.title;
            return file === undefined ? `Searched for ${pattern}` : `Searched for ${pattern} in ${file}`;
        }
        case "catalog_search": {
            const query = argText(call, "query", "q");
            return query === undefined ? call.title : `Searched sessions for ${query}`;
        }
        case "web_fetch": {
            const url = argText(call, "url");
            return url === undefined ? call.title : `Fetched ${url}`;
        }
        default:
            return call.title;
    }
}

// "Ran 3 commands" when every call is one tool, otherwise "Used 4 tools".
export function groupSummary(calls: readonly ToolCall[]): string {
    const first = calls[0];
    if (first === undefined) return "Working";
    if (calls.length === 1) return callLabel(first);
    const verb = VERBS[first.tool];
    if (verb !== undefined && calls.every((call) => call.tool === first.tool)) {
        return `${verb[0]} ${calls.length} ${verb[1]}s`;
    }
    return `Used ${calls.length} tools`;
}

function ToolGroup({ block }: { readonly block: ToolsBlock }) {
    const [open, setOpen] = useState(true);
    const running = block.active || block.calls.some((call) => call.state === "running");
    const single = block.calls.length === 1 ? block.calls[0] : undefined;
    return (
        <div className="tool-group" data-active={running}>
            <button type="button" className="tool-head" disabled={running} aria-expanded={open} onClick={() => setOpen(!open)}>
                <span className="t">{groupSummary(block.calls)}</span>
                {running ? <span className="live-dot" /> : open ? <ChevronDownIcon className="chev" /> : <ChevronRightIcon className="chev" />}
            </button>
            {(running || open) && block.calls.length > 0 ? (
                <div className="tool-card">
                    {single !== undefined && single.state !== "running" ? (
                        <div className="tool-row" data-open="true" data-failed={single.state === "failed"}>
                            <div className="tool-name">
                                {single.tool}
                                {single.state === "failed" ? <span className="failed-tag">failed</span> : null}
                            </div>
                            <ToolBody call={single} />
                        </div>
                    ) : (
                        block.calls.map((call, index) => <ToolRow key={index} call={call} />)
                    )}
                </div>
            ) : null}
        </div>
    );
}

function ToolRow({ call }: { readonly call: ToolCall }) {
    const [open, setOpen] = useState(false);
    const done = call.state !== "running";
    return (
        <div className="tool-row" data-open={open} data-failed={call.state === "failed"}>
            <button type="button" className="tool-row-head" disabled={!done} aria-expanded={open} onClick={() => setOpen(!open)}>
                <span className="t">{callLabel(call)}</span>
                {call.state === "failed" ? <span className="failed-tag">failed</span> : null}
                {!done ? <span className="live-dot" /> : open ? <ChevronDownIcon className="chev" /> : <ChevronRightIcon className="chev" />}
            </button>
            {open && done ? <ToolBody call={call} /> : null}
        </div>
    );
}

function invocationOf(call: ToolCall): string {
    const command = call.args["command"] ?? call.args["cmd"];
    if (typeof command === "string") return command;
    const rest = call.title.startsWith(`${call.tool} `) ? call.title.slice(call.tool.length + 1) : "";
    return rest;
}

function ToolBody({ call }: { readonly call: ToolCall }) {
    const [copied, setCopied] = useState(false);
    const invocation = invocationOf(call);
    const shell = call.tool === "bash";
    const copy = async (): Promise<void> => {
        if (!(await copyText(invocation))) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
    };
    return (
        <>
            {invocation === "" ? null : (
                <div className="cmd-chip">
                    <code>
                        {shell ? <><span className="dollar">$ </span><Shell text={invocation} /></> : <><span className="verb">{call.tool}</span> {invocation}</>}
                    </code>
                    <button type="button" className="copy" title={copied ? "Copied" : "Copy"} onClick={() => void copy()}>
                        {copied ? <CheckIcon /> : <CopyIcon />}
                    </button>
                </div>
            )}
            <pre className="tool-out">{call.output === "" ? "(no output)" : call.output ?? ""}</pre>
        </>
    );
}

// Colours the word at the head of each pipeline segment, its flags, and quoted strings.
function Shell({ text }: { readonly text: string }) {
    let head = true;
    return (
        <>
            {text.split(/(\s+|\||;|&&)/).map((part, index) => {
                if (part === "" || /^\s+$/.test(part)) return part;
                if (part === "|" || part === ";" || part === "&&") {
                    head = true;
                    return <span key={index} className="pipe">{part}</span>;
                }
                if (head) {
                    head = false;
                    return <span key={index} className="cmd">{part}</span>;
                }
                if (part.startsWith("-")) return <span key={index} className="flag">{part}</span>;
                if (/^["']/.test(part)) return <span key={index} className="str">{part}</span>;
                return <span key={index}>{part}</span>;
            })}
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

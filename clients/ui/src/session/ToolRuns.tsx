import { useState } from "react";

import { CheckIcon, ChevronRightIcon, CopyIcon } from "../components/Icons.tsx";
import { copyText } from "./copyText.ts";
import type { ToolCall } from "./model.ts";
import { callPaths, callTarget, isShell, rowVerb, shellCommand, toolSummary } from "./toolTitle.ts";

// A finished run of calls is one line. Opened, each call is a line of its own, and a shell command opens to a box.
export function RunLine({ calls }: { readonly calls: readonly ToolCall[] }) {
    const [open, setOpen] = useState(false);
    const failed = calls.filter((call) => call.state === "failed").length;
    return (
        <div className="run" data-open={open}>
            <button type="button" className="run-head" aria-expanded={open} onClick={() => setOpen(!open)}>
                <span className="t">{toolSummary(calls)}</span>
                {failed > 0 ? <span className="failed-tag">{failed} failed</span> : null}
                <ChevronRightIcon className="chev" />
            </button>
            {open ? <CallList calls={calls} /> : null}
        </div>
    );
}

export function CallList({ calls }: { readonly calls: readonly ToolCall[] }) {
    const paths = callPaths(calls);
    return (
        <div className="call-list">
            {calls.map((call, index) => (isShell(call)
                ? <ShellRow key={index} call={call} />
                : <CallRow key={index} call={call} paths={paths} />))}
        </div>
    );
}

function hasOutput(call: ToolCall): boolean {
    return call.output !== undefined && call.output !== "";
}

function CallRow({ call, paths }: { readonly call: ToolCall; readonly paths: readonly string[] }) {
    const [open, setOpen] = useState(false);
    const running = call.state === "running";
    const expandable = !running && hasOutput(call);
    return (
        <div className="call-row" data-failed={call.state === "failed"}>
            <button type="button" className="call-line" disabled={!expandable} aria-expanded={expandable ? open : undefined} onClick={() => setOpen(!open)}>
                <span className="verb">{rowVerb(call)}</span>
                <span className="arg">{callTarget(call, paths)}</span>
                {call.state === "failed" ? <span className="failed-tag">failed</span> : null}
            </button>
            {open && expandable ? <pre className="call-out">{call.output}</pre> : null}
        </div>
    );
}

function ShellRow({ call }: { readonly call: ToolCall }) {
    const [open, setOpen] = useState(false);
    const running = call.state === "running";
    const shown = open && !running;
    return (
        <div className="call-row" data-failed={call.state === "failed"}>
            <button type="button" className="call-line" disabled={running} aria-expanded={running ? undefined : shown} onClick={() => setOpen(!open)}>
                <span className="verb">{rowVerb(call)}</span>
                {shown ? null : <span className="arg cmd">{callTarget(call)}</span>}
                {call.state === "failed" ? <span className="failed-tag">failed</span> : null}
            </button>
            {shown ? <ShellBox call={call} /> : null}
        </div>
    );
}

function ShellBox({ call }: { readonly call: ToolCall }) {
    const [copied, setCopied] = useState(false);
    const command = shellCommand(call);
    const copy = async (): Promise<void> => {
        if (!(await copyText(command))) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
    };
    return (
        <div className="shell-box">
            <button type="button" className="copy" title={copied ? "Copied" : "Copy command"} aria-label="Copy command" onClick={() => void copy()}>
                {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
            <pre className="shell-cmd"><span className="dollar">$ </span><Shell text={command} /></pre>
            {call.output === undefined ? null : <pre className="shell-out">{call.output === "" ? "(no output)" : call.output}</pre>}
        </div>
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

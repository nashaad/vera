import { memo, useState, type ReactNode } from "react";

import { CheckIcon, CopyIcon } from "../components/Icons.tsx";
import { copyText } from "./copyText.ts";

// A small subset: headings, paragraphs, lists, fenced code, and inline
// bold, italic, code and links. Raw HTML is never rendered.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/g;

// Wraps each word in a span that fades in when it mounts. A word keeps its key while the text grows, so only new words animate.
function words(text: string, key: string, counter: { next: number }): ReactNode[] {
    return text.split(/(\s+)/).map((part) => {
        if (part === "" || /^\s+$/.test(part)) return part;
        return <span key={`${key}-w${counter.next++}`} className="word-in">{part}</span>;
    });
}

function inline(text: string, key: string, fade = false): ReactNode[] {
    const out: ReactNode[] = [];
    const counter = { next: 0 };
    const plain = (part: string): void => {
        if (fade) out.push(...words(part, key, counter));
        else out.push(part);
    };
    let last = 0;
    let index = 0;
    for (const match of text.matchAll(INLINE)) {
        const at = match.index ?? 0;
        if (at > last) plain(text.slice(last, at));
        const token = match[0];
        const k = `${key}-${index++}`;
        if (token.startsWith("**")) out.push(<strong key={k}>{token.slice(2, -2)}</strong>);
        else if (token.startsWith("`")) out.push(<code key={k}>{token.slice(1, -1)}</code>);
        else if (token.startsWith("[")) {
            const label = token.slice(1, token.indexOf("]"));
            const href = token.slice(token.indexOf("(") + 1, -1);
            out.push(<a key={k} href={href} title={href} onClick={(event) => event.preventDefault()}>{label}</a>);
        } else out.push(<em key={k}>{token.slice(1, -1)}</em>);
        last = at + token.length;
    }
    if (last < text.length) plain(text.slice(last));
    return out;
}

export function Inline({ text }: { readonly text: string }) {
    return <>{inline(text, "i")}</>;
}

function CodeCard({ lang, body }: { readonly lang: string; readonly body: string }) {
    const [copied, setCopied] = useState(false);
    const copy = async (): Promise<void> => {
        if (!(await copyText(body))) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
    };
    return (
        <div className="code-card">
            <div className="code-head">
                <span className="code-lang">{lang === "" ? "text" : lang}</span>
                <button type="button" className="icon-button" title={copied ? "Copied" : "Copy"} onClick={() => void copy()}>
                    {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
            </div>
            <pre className="code-body">{body}</pre>
        </div>
    );
}

const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^(#{1,6})\s+(.*)$/;

function renderBlock(block: string, key: string, fade: boolean): ReactNode {
    if (block.startsWith("```")) {
        const newline = block.indexOf("\n");
        const lang = block.slice(3, newline === -1 ? undefined : newline).trim();
        const body = newline === -1 ? "" : block.slice(newline + 1).replace(/\n?```\s*$/, "");
        return <CodeCard key={key} lang={lang} body={body} />;
    }
    const heading = HEADING.exec(block);
    if (heading !== null && !block.includes("\n")) {
        const level = Math.min((heading[1] ?? "#").length + 2, 6);
        const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
        return <Tag key={key}>{inline(heading[2] ?? "", key, fade)}</Tag>;
    }
    const lines = block.split("\n");
    if (lines.every((line) => BULLET.test(line))) {
        return <ul key={key}>{lines.map((line, i) => <li key={i}>{inline(line.replace(BULLET, ""), `${key}-${i}`, fade)}</li>)}</ul>;
    }
    if (lines.every((line) => NUMBERED.test(line))) {
        return <ol key={key}>{lines.map((line, i) => <li key={i}>{inline(line.replace(NUMBERED, ""), `${key}-${i}`, fade)}</li>)}</ol>;
    }
    return <p key={key}>{inline(block, key, fade)}</p>;
}

export interface MarkdownProps {
    readonly text: string;
    // Fades in the words of the last block as they arrive; for text that is still streaming.
    readonly fade?: boolean;
}

export const Markdown = memo(function Markdown({ text, fade = false }: MarkdownProps) {
    const blocks = splitBlocks(text);
    return (
        <div className="assistant-text">
            {blocks.map((block, i) => renderBlock(block, String(i), fade && i === blocks.length - 1))}
        </div>
    );
});

// Splits on blank lines and before headings, keeping a fenced block whole even when it has blank lines.
export function splitBlocks(text: string): string[] {
    const out: string[] = [];
    let buffer: string[] = [];
    let fence = false;
    const flush = (): void => {
        const joined = buffer.join("\n").trim();
        if (joined !== "") out.push(joined);
        buffer = [];
    };
    for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("```")) {
            if (!fence) {
                flush();
                fence = true;
                buffer.push(line);
            } else {
                buffer.push(line);
                fence = false;
                flush();
            }
            continue;
        }
        if (!fence && line.trim() === "") {
            flush();
            continue;
        }
        if (!fence && HEADING.test(line)) {
            flush();
            buffer.push(line);
            flush();
            continue;
        }
        buffer.push(line);
    }
    flush();
    return out;
}

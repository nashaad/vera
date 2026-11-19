import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { CheckIcon, CopyIcon } from "../components/Icons.tsx";
import { copyText } from "./copyText.ts";
import { canHighlight, highlightCode, peekHighlight } from "./highlight/engine.ts";
import { KIND_NAMES, PLAIN, type HighlightedCode } from "./highlight/tokens.ts";

function tokenNodes(code: HighlightedCode): ReactNode[] {
    return code.texts.map((text, index) => {
        const kind = code.kinds[index] ?? PLAIN;
        return kind === PLAIN ? text : <span key={index} className={`tok-${KIND_NAMES[kind]}`}>{text}</span>;
    });
}

function scrollParent(element: Element): Element | null {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
        const { overflowY } = getComputedStyle(parent);
        if (overflowY === "auto" || overflowY === "scroll") return parent;
    }
    return null;
}

// True while the block is on screen or within a screen of it. Colored runs are many DOM nodes, so a block that
// scrolls far away goes back to one text node; its colors stay in the cache for when it returns. Without
// IntersectionObserver every block counts as near.
function useNearScreen(target: RefObject<Element | null>, wanted: boolean): boolean {
    const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
    useEffect(() => {
        if (!wanted) return undefined;
        const element = target.current;
        if (element === null || typeof IntersectionObserver === "undefined") return undefined;
        const observer = new IntersectionObserver(
            (entries) => {
                const latest = entries[entries.length - 1];
                if (latest !== undefined) setNear(latest.isIntersecting);
            },
            { root: scrollParent(element), rootMargin: "100% 0%" },
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, [wanted, target]);
    return wanted && near;
}

interface Settled {
    readonly lang: string;
    readonly body: string;
    readonly code: HighlightedCode;
}

function useHighlighted(lang: string, body: string, ready: boolean, target: RefObject<Element | null>): HighlightedCode | undefined {
    const [settled, setSettled] = useState<Settled | undefined>();
    const wanted = ready && canHighlight(lang, body) !== undefined;
    const near = useNearScreen(target, wanted);
    const cached = near ? peekHighlight(lang, body) : undefined;
    useEffect(() => {
        if (!near) {
            setSettled(undefined);
            return undefined;
        }
        if (cached !== undefined) return undefined;
        let current = true;
        void highlightCode(lang, body).then((code) => {
            if (current && code !== null) setSettled({ lang, body, code });
        });
        return () => {
            current = false;
        };
    }, [near, cached, lang, body]);
    if (!near) return undefined;
    if (cached !== undefined) return cached;
    return settled !== undefined && settled.lang === lang && settled.body === body ? settled.code : undefined;
}

export interface CodeCardProps {
    readonly lang: string;
    readonly body: string;
    // False while the block is still being written: it is shown as plain text until its closing fence arrives.
    readonly ready: boolean;
}

export const CodeCard = memo(function CodeCard({ lang, body, ready }: CodeCardProps) {
    const [copied, setCopied] = useState(false);
    const target = useRef<HTMLPreElement>(null);
    const highlighted = useHighlighted(lang, body, ready, target);
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
            <pre className="code-body" ref={target}>{highlighted === undefined ? body : tokenNodes(highlighted)}</pre>
        </div>
    );
});

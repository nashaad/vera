import { memo, useRef, useState, type ReactNode } from "react";

import { CheckIcon, CopyIcon } from "../components/Icons.tsx";
import { copyText } from "./copyText.ts";
import { canHighlight } from "./highlight/engine.ts";
import { KIND_NAMES, PLAIN, type HighlightedCode } from "./highlight/tokens.ts";
import { useHighlighted, useNearScreen } from "./highlight/useHighlight.ts";

function tokenNodes(code: HighlightedCode): ReactNode[] {
    return code.texts.map((text, index) => {
        const kind = code.kinds[index] ?? PLAIN;
        return kind === PLAIN ? text : <span key={index} className={`tok-${KIND_NAMES[kind]}`}>{text}</span>;
    });
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
    const near = useNearScreen(target, ready && canHighlight(lang, body) !== undefined);
    const highlighted = useHighlighted(lang, body, near);
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

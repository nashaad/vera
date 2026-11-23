import { useEffect, useState, type RefObject } from "react";

import { highlightCode, peekHighlight } from "./engine.ts";
import type { HighlightedCode } from "./tokens.ts";

function scrollParent(element: Element): Element | null {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
        const { overflowY } = getComputedStyle(parent);
        if (overflowY === "auto" || overflowY === "scroll") return parent;
    }
    return null;
}

export function useNearScreen(target: RefObject<Element | null>, wanted: boolean): boolean {
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

export function useHighlighted(lang: string, body: string, near: boolean): HighlightedCode | undefined {
    const [settled, setSettled] = useState<Settled | undefined>();
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

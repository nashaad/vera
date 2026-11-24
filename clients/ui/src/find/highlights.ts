import { findElement, findParent } from "./tree.ts";

interface HighlightRegistry {
    set(name: string, highlight: unknown): void;
    delete(name: string): boolean;
}

interface HighlightConstructor {
    new (...ranges: Range[]): unknown;
}

interface HighlightGlobals {
    readonly CSS?: { readonly highlights?: HighlightRegistry };
    readonly Highlight?: HighlightConstructor;
}

const MATCHES = "vera-find-matches";
const CURRENT = "vera-find-current";

function support(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | undefined {
    const globals = globalThis as unknown as HighlightGlobals;
    const registry = globals.CSS?.highlights;
    const Highlight = globals.Highlight;
    return registry === undefined || Highlight === undefined ? undefined : { registry, Highlight };
}

export function clearFindHighlights(): void {
    const registry = support()?.registry;
    registry?.delete(MATCHES);
    registry?.delete(CURRENT);
}

export function showFindHighlights(ranges: readonly Range[], current: number): void {
    const available = support();
    if (available === undefined) return;
    const { registry, Highlight } = available;
    registry.delete(MATCHES);
    registry.delete(CURRENT);
    const selected = ranges[current];
    const others = ranges.filter((_, index) => index !== current);
    if (others.length > 0) registry.set(MATCHES, new Highlight(...others));
    if (selected !== undefined) registry.set(CURRENT, new Highlight(selected));
}

function scrollDelta(start: number, end: number, min: number, max: number): number {
    if (start < min) return start - min;
    if (end > max) return end - max;
    return 0;
}

export function scrollFindMatch(range: Range): void {
    const element = findElement(range.startContainer);
    if (element === null) return;
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    for (let current: Element | null = element; current !== null; current = findParent(current)) {
        const container = current as HTMLElement;
        const vertical = container.scrollHeight > container.clientHeight;
        const horizontal = container.scrollWidth > container.clientWidth;
        if (!vertical && !horizontal) continue;
        const match = range.getClientRects()[0] ?? range.getBoundingClientRect();
        const box = container.getBoundingClientRect();
        const top = box.top + container.clientTop;
        const left = box.left + container.clientLeft;
        const dy = vertical ? scrollDelta(match.top, match.bottom, top, top + container.clientHeight) : 0;
        const dx = horizontal ? scrollDelta(match.left, match.right, left, left + container.clientWidth) : 0;
        if (dx !== 0 || dy !== 0) {
            container.scrollTo({ top: container.scrollTop + dy, left: container.scrollLeft + dx, behavior: "instant" });
        }
    }
}

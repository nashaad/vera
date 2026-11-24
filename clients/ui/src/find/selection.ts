const MAX_FIND_CONTEXT = 64;

interface FindBoundary {
    readonly node: Node;
    readonly offset: number;
}

interface FindContextAnchor {
    readonly before: Uint16Array;
    readonly after: Uint16Array;
}

interface FindContainerAnchor {
    readonly element: Element;
    readonly start: number;
    readonly end: number;
}

interface FindLineAnchor {
    readonly root: Node;
    readonly line: string;
    readonly index: string;
    readonly kind: string | null;
    readonly start: number;
    readonly end: number;
}

export interface FindSelection {
    readonly range: Range;
    readonly root: Node;
    readonly index: number;
    readonly start: FindBoundary;
    readonly end: FindBoundary;
    readonly context?: FindContextAnchor;
    readonly container?: FindContainerAnchor;
    readonly line?: FindLineAnchor;
}

function textOffset(element: Element, target: Node, offset: number): number | undefined {
    let total = 0;
    let node: Node | null = element.firstChild;
    while (node !== null) {
        if (node === target) return total + offset;
        if (node.nodeType === 3) total += (node as Text).data.length;
        if (node.firstChild !== null) {
            node = node.firstChild;
        } else {
            while (node !== element && node.nextSibling === null) node = node.parentNode!;
            node = node === element ? null : node.nextSibling;
        }
    }
    return undefined;
}

function containerAnchor(range: Range): FindContainerAnchor | undefined {
    const common = range.commonAncestorContainer;
    if (common === undefined) return undefined;
    const element = common.nodeType === 1 ? common as Element : common.parentElement;
    if (element === null) return undefined;
    const start = textOffset(element, range.startContainer, range.startOffset);
    const end = textOffset(element, range.endContainer, range.endOffset);
    return start === undefined || end === undefined ? undefined : { element, start, end };
}

function lineAnchor(range: Range): FindLineAnchor | undefined {
    const root = range.startContainer.getRootNode();
    if (root.nodeType !== 11 || !("host" in root)) return undefined;
    for (let element = range.startContainer.parentElement; element !== null; element = element.parentElement) {
        const line = element.getAttribute("data-line");
        const index = element.getAttribute("data-line-index");
        if (line === null || index === null) continue;
        const start = textOffset(element, range.startContainer, range.startOffset);
        const end = textOffset(element, range.endContainer, range.endOffset);
        if (start === undefined || end === undefined) return undefined;
        return { root, line, index, kind: element.getAttribute("data-line-type"), start, end };
    }
    return undefined;
}

function contextSlice(text: string, start: number, end: number): Uint16Array {
    const result = new Uint16Array(end - start);
    for (let i = 0; i < result.length; i++) result[i] = text.charCodeAt(start + i);
    return result;
}

function contextAnchor(range: Range): FindContextAnchor | undefined {
    if (range.startContainer.nodeType !== 3 || range.endContainer.nodeType !== 3) return undefined;
    const start = (range.startContainer as Text).data;
    const end = (range.endContainer as Text).data;
    return {
        before: contextSlice(start, Math.max(0, range.startOffset - MAX_FIND_CONTEXT), range.startOffset),
        after: contextSlice(end, range.endOffset, Math.min(end.length, range.endOffset + MAX_FIND_CONTEXT)),
    };
}

export function captureFindSelection(range: Range | undefined, index: number): FindSelection | undefined {
    if (range === undefined) return undefined;
    return {
        range,
        root: range.startContainer.getRootNode(),
        index,
        start: { node: range.startContainer, offset: range.startOffset },
        end: { node: range.endContainer, offset: range.endOffset },
        context: contextAnchor(range),
        container: containerAnchor(range),
        line: lineAnchor(range),
    };
}

function sameBounds(range: Range, start: FindBoundary, end: FindBoundary): boolean {
    return range.startContainer === start.node && range.startOffset === start.offset
        && range.endContainer === end.node && range.endOffset === end.offset;
}

function sameLine(first: FindLineAnchor, second: FindLineAnchor | undefined): boolean {
    return second !== undefined && first.root === second.root && first.line === second.line
        && first.index === second.index && first.kind === second.kind;
}

function sameContext(anchor: FindContextAnchor, range: Range): boolean {
    if (range.startContainer.nodeType !== 3 || range.endContainer.nodeType !== 3) return false;
    const start = (range.startContainer as Text).data;
    const end = (range.endContainer as Text).data;
    if (range.startOffset < anchor.before.length || end.length - range.endOffset < anchor.after.length) return false;
    for (let i = 0; i < anchor.before.length; i++) {
        if (start.charCodeAt(range.startOffset - anchor.before.length + i) !== anchor.before[i]) return false;
    }
    for (let i = 0; i < anchor.after.length; i++) {
        if (end.charCodeAt(range.endOffset + i) !== anchor.after[i]) return false;
    }
    return true;
}

function uniqueContextIndex(previous: FindSelection, ranges: readonly Range[]): number {
    const context = previous.context;
    if (context === undefined || context.before.length + context.after.length === 0) return -1;
    let index = -1;
    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i]!;
        const sameNodes = range.startContainer === previous.start.node && range.endContainer === previous.end.node;
        const container = previous.container?.element;
        const sameContainer = container?.contains(range.startContainer) === true && container.contains(range.endContainer);
        if (!sameNodes && !sameContainer && (previous.line === undefined || !sameLine(previous.line, lineAnchor(range)))) continue;
        if (!sameContext(context, range)) continue;
        if (index !== -1) return -1;
        index = i;
    }
    return index;
}

function closestIndex(previous: FindSelection, ranges: readonly Range[], offset: (range: Range) => number | undefined): number {
    let index = -1;
    let distance = Infinity;
    let indexDistance = Infinity;
    for (let i = 0; i < ranges.length; i++) {
        const candidate = offset(ranges[i]!);
        if (candidate === undefined) continue;
        const nextDistance = Math.abs(candidate);
        const nextIndexDistance = Math.abs(i - previous.index);
        if (nextDistance > distance || (nextDistance === distance && nextIndexDistance >= indexDistance)) continue;
        index = i;
        distance = nextDistance;
        indexDistance = nextIndexDistance;
    }
    return index;
}

export function preserveFindIndex(previous: FindSelection | undefined, ranges: readonly Range[]): number {
    if (ranges.length === 0) return -1;
    if (previous === undefined) return 0;
    const live = previous.range;
    const liveStart = { node: live.startContainer, offset: live.startOffset };
    const liveEnd = { node: live.endContainer, offset: live.endOffset };
    const liveIndex = ranges.findIndex((range) => sameBounds(range, liveStart, liveEnd));
    if (liveIndex !== -1) return liveIndex;

    const contextIndex = uniqueContextIndex(previous, ranges);
    if (contextIndex !== -1) return contextIndex;

    const nodeIndex = closestIndex(previous, ranges, (range) => {
        if (range.startContainer !== previous.start.node || range.endContainer !== previous.end.node) return undefined;
        return range.startOffset - previous.start.offset;
    });
    if (nodeIndex !== -1) return nodeIndex;

    const container = previous.container;
    if (container !== undefined) {
        const index = closestIndex(previous, ranges, (range) => {
            if (!container.element.contains(range.startContainer) || !container.element.contains(range.endContainer)) return undefined;
            const start = textOffset(container.element, range.startContainer, range.startOffset);
            return start === undefined ? undefined : start - container.start;
        });
        if (index !== -1) return index;
    }

    const line = previous.line;
    if (line !== undefined) {
        const index = closestIndex(previous, ranges, (range) => {
            const candidate = lineAnchor(range);
            return sameLine(line, candidate) ? candidate!.start - line.start : undefined;
        });
        if (index !== -1) return index;
    }

    const placed = previous.start.node.getRootNode() === previous.root
        || previous.container?.element.getRootNode() === previous.root
        || (previous.root.nodeType === 11 && "host" in previous.root && (previous.root as ShadowRoot).host.isConnected);
    if (placed) {
        const index = closestIndex(previous, ranges, (range) =>
            range.startContainer.getRootNode() === previous.root ? 0 : undefined,
        );
        if (index !== -1) return index;
    }
    return 0;
}

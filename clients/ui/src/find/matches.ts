export const MAX_FIND_MATCHES = 1000;

export interface FindMatches {
    readonly ranges: readonly Range[];
    readonly capped: boolean;
}

export function moveFindIndex(current: number, count: number, direction: 1 | -1): number {
    if (count <= 0) return -1;
    if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
    return (current + direction + count) % count;
}

export function findMatches(root: HTMLElement, query: string, exclude?: Element): FindMatches {
    const needle = Array.from(query, character => character.toLowerCase()).join("");
    if (!needle) return { ranges: [], capped: false };

    const ranges: Range[] = [];
    const prefix = new Uint32Array(needle.length);
    for (let i = 1, length = 0; i < needle.length; i++) {
        while (length > 0 && needle[i] !== needle[length]) length = prefix[length - 1]!;
        if (needle[i] === needle[length]) length++;
        prefix[i] = length;
    }
    const nodes: Text[] = new Array(needle.length);
    const starts = new Array<number>(needle.length);
    let matched = 0;
    let cursor = 0;
    let textRoot: Node | undefined;
    const view = root.ownerDocument.defaultView;
    if (!view) return { ranges, capped: false };

    function reset(): void {
        matched = 0;
        cursor = 0;
    }

    function text(node: Text): boolean {
        const nodeRoot = node.getRootNode();
        if (textRoot !== nodeRoot) reset();
        textRoot = nodeRoot;
        const value = node.data;
        for (let offset = 0; offset < value.length;) {
            const codePoint = value.codePointAt(offset)!;
            const character = String.fromCodePoint(codePoint);
            const end = offset + character.length;
            const folded = character.toLowerCase();
            for (let i = 0; i < folded.length; i++) {
                nodes[cursor] = node;
                starts[cursor] = offset;
                cursor = (cursor + 1) % needle.length;
                while (matched > 0 && folded[i] !== needle[matched]) matched = prefix[matched - 1]!;
                if (folded[i] === needle[matched]) matched++;
                if (matched === needle.length) {
                    const range = root.ownerDocument.createRange();
                    range.setStart(nodes[cursor]!, starts[cursor]!);
                    range.setEnd(node, end);
                    ranges.push(range);
                    reset();
                    if (ranges.length === MAX_FIND_MATCHES) return true;
                }
            }
            offset = end;
        }
        return false;
    }

    function visit(node: Node): boolean {
        if (node.nodeType === 3) return text(node as Text);
        if (node.nodeType !== 1) return false;
        const element = node as Element;
        if (element === exclude || /^(SCRIPT|STYLE|INPUT|TEXTAREA|IFRAME)$/.test(element.tagName)) return false;
        const style = view!.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
        const block = element !== root && (style.display !== "contents" && !style.display.startsWith("inline"));
        const boundary = block || element.tagName === "BR" || element.tagName === "SLOT";
        if (boundary) reset();
        const shadow = element.shadowRoot;
        if (shadow) {
            reset();
            for (let child = shadow.firstChild; child; child = child.nextSibling) {
                if (visit(child)) return true;
            }
            reset();
        } else if (element.tagName === "SLOT") {
            const assigned = (element as HTMLSlotElement).assignedNodes();
            if (assigned.length > 0) {
                let previous: Node | null = null;
                for (const child of assigned) {
                    if (previous !== null && previous.nextSibling !== child) reset();
                    if (visit(child)) return true;
                    previous = child;
                }
            } else {
                for (let child = node.firstChild; child; child = child.nextSibling) {
                    if (visit(child)) return true;
                }
            }
        } else {
            for (let child = node.firstChild; child; child = child.nextSibling) {
                if (visit(child)) return true;
            }
        }
        if (boundary) reset();
        return false;
    }

    for (let ancestor: Element | null = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor === exclude) return { ranges, capped: false };
        const style = view.getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") {
            return { ranges, capped: false };
        }
    }
    const capped = visit(root);
    return { ranges, capped };
}

import { describe, expect, test } from "bun:test";
import { findMatches, MAX_FIND_MATCHES, moveFindIndex } from "../../clients/ui/src/find/matches";
import { captureFindSelection, preserveFindIndex } from "../../clients/ui/src/find/selection";

interface FakeNode {
    nodeType: number;
    firstChild: FakeNode | null;
    nextSibling: FakeNode | null;
    parentElement: FakeElement | null;
    parentNode: FakeNode | null;
    getRootNode(): FakeNode;
}

interface FakeText extends FakeNode {
    data: string;
}

interface FakeElement extends FakeNode {
    tagName: string;
    display: string;
    visibility: string;
    opacity: string;
    ownerDocument: typeof documentFixture;
    shadowRoot: FakeShadowRoot | null;
    attributes: Record<string, string>;
    getAttribute(name: string): string | null;
    contains(node: FakeNode): boolean;
    assignedNodes?(): FakeNode[];
}

interface FakeShadowRoot extends FakeNode {
    host: FakeElement;
}

interface FakeRange {
    start: [FakeText, number] | null;
    end: [FakeText, number] | null;
    readonly startContainer: FakeText | undefined;
    readonly startOffset: number | undefined;
    readonly endContainer: FakeText | undefined;
    readonly endOffset: number | undefined;
    readonly commonAncestorContainer: FakeNode | undefined;
    setStart(node: FakeText, offset: number): void;
    setEnd(node: FakeText, offset: number): void;
}

const documentFixture = {
    defaultView: {
        getComputedStyle(element: FakeElement) {
            return { display: element.display, visibility: element.visibility, opacity: element.opacity };
        },
    },
    createRange(): FakeRange {
        return {
            start: null,
            end: null,
            get startContainer() { return this.start?.[0]; },
            get startOffset() { return this.start?.[1]; },
            get endContainer() { return this.end?.[0]; },
            get endOffset() { return this.end?.[1]; },
            get commonAncestorContainer() {
                const ancestors = new Set<FakeNode>();
                for (let node: FakeNode | null = this.start?.[0] ?? null; node !== null; node = node.parentNode) ancestors.add(node);
                for (let node: FakeNode | null = this.end?.[0] ?? null; node !== null; node = node.parentNode) {
                    if (ancestors.has(node)) return node;
                }
                return undefined;
            },
            setStart(node, offset) { this.start = [node, offset]; },
            setEnd(node, offset) {
                if (this.start?.[0].getRootNode() !== node.getRootNode()) throw new Error("Range crosses trees");
                this.end = [node, offset];
            },
        };
    },
};

function getRootNode(this: FakeNode): FakeNode {
    let node: FakeNode = this;
    while (node.parentNode !== null) node = node.parentNode;
    return node;
}

function text(data: string): FakeText {
    return { nodeType: 3, data, firstChild: null, nextSibling: null, parentElement: null, parentNode: null, getRootNode };
}

function setChildren(parent: FakeNode, children: FakeNode[]): void {
    parent.firstChild = children[0] ?? null;
    children.forEach((child, index) => {
        child.parentElement = parent.nodeType === 1 ? parent as FakeElement : null;
        child.parentNode = parent;
        child.nextSibling = children[index + 1] ?? null;
    });
}

function element(tag: string, children: FakeNode[] = [], display = "inline", visibility = "visible", opacity = "1"): FakeElement {
    const result: FakeElement = {
        nodeType: 1, tagName: tag.toUpperCase(), display, visibility, opacity,
        firstChild: null, nextSibling: null, parentElement: null, parentNode: null, getRootNode,
        ownerDocument: documentFixture, shadowRoot: null, attributes: {},
        getAttribute(name) { return this.attributes[name] ?? null; },
        contains(node) {
            for (let current: FakeNode | null = node; current !== null; current = current.parentNode) {
                if (current === this) return true;
            }
            return false;
        },
    };
    setChildren(result, children);
    return result;
}

function shadow(host: FakeElement, children: FakeNode[]): FakeShadowRoot {
    const root: FakeShadowRoot = {
        nodeType: 11, host, firstChild: null, nextSibling: null, parentElement: null, parentNode: null, getRootNode,
    };
    host.shadowRoot = root;
    setChildren(root, children);
    return root;
}

function slot(assigned: FakeNode[], fallback: FakeNode[] = []): FakeElement {
    const result = element("slot", fallback, "contents");
    result.assignedNodes = () => assigned;
    return result;
}

function search(root: FakeElement, query: string, exclude?: FakeElement) {
    return findMatches(root as unknown as HTMLElement, query, exclude as unknown as Element | undefined);
}

function rangeAt(ranges: readonly Range[], index: number): FakeRange {
    return ranges[index] as unknown as FakeRange;
}

describe("find matches", () => {
    test("matches case and inline text with UTF-16 offsets", () => {
        const first = text("😀He");
        const second = text("LLo hello");
        const root = element("div", [first, element("span", [second])], "block");
        const result = search(root, "hello");
        expect(result.ranges).toHaveLength(2);
        expect(rangeAt(result.ranges, 0).start).toEqual([first, 2]);
        expect(rangeAt(result.ranges, 0).end).toEqual([second, 3]);
        expect(rangeAt(result.ranges, 1).start).toEqual([second, 4]);
        expect(search(element("div", [text("İ")]), "i\u0307").ranges).toHaveLength(1);
    });

    test("handles repeated prefixes across nodes without overlapping matches", () => {
        const first = text("😀ababab");
        const second = text("ACababacababac");
        const root = element("div", [first, element("span", [second])]);
        const result = search(root, "ababac");
        expect(result.ranges).toHaveLength(3);
        expect(rangeAt(result.ranges, 0).start).toEqual([first, 4]);
        expect(rangeAt(result.ranges, 0).end).toEqual([second, 2]);
        expect(rangeAt(result.ranges, 1).start).toEqual([second, 2]);
        expect(rangeAt(result.ranges, 2).end).toEqual([second, 14]);
        expect(search(element("div", [text("aaaaa")]), "aaa").ranges).toHaveLength(1);
    });

    test("handles a long no-match run with repeated query prefixes", () => {
        const root = element("div", [text("a".repeat(100_000))]);
        const result = search(root, "a".repeat(2048) + "b");
        expect(result.ranges).toHaveLength(0);
        expect(result.capped).toBe(false);
    });

    test("does not span block boundaries or line breaks", () => {
        const root = element("div", [text("a"), element("div", [text("b")], "block"), text("c"), element("br"), text("d")]);
        for (const query of ["ab", "bc", "cd"]) expect(search(root, query).ranges).toHaveLength(0);
    });

    test("excludes hidden content, controls, scripts, styles and the bar", () => {
        const bar = element("div", [text("hit")]);
        const root = element("div", [
            bar, element("script", [text("hit")]), element("style", [text("hit")]),
            element("input", [text("hit")]), element("textarea", [text("hit")]),
            element("div", [text("hit")], "none"), element("div", [text("hit")], "block", "hidden"),
            element("div", [text("hit")], "block", "visible"),
        ]);
        expect(search(root, "hit", bar).ranges).toHaveLength(1);
        element("div", [root], "none");
        expect(search(root, "hit", bar).ranges).toHaveLength(0);
    });

    test("searches nested open roots at the host and slots in rendered order", () => {
        const before = text("hit-before");
        const after = text("hit-after");
        const assignedFirst = text("hit-first");
        const assignedSecond = text("hit-second");
        const unslotted = text("hit-unslotted");
        const fallback = text("hit-fallback");
        const ignoredFallback = text("hit-ignored-fallback");
        const nestedText = text("hit-nested");
        const nested = element("inner-host");
        shadow(nested, [nestedText]);
        const host = element("outer-host", [assignedFirst, assignedSecond, unslotted]);
        const start = text("hit-start");
        const middle = text("hit-middle");
        shadow(host, [start, slot([assignedSecond], [ignoredFallback]), middle, nested, slot([assignedFirst]), slot([], [fallback])]);
        const root = element("div", [before, host, after], "block");
        const result = search(root, "hit");
        expect(result.ranges.map((_, index) => rangeAt(result.ranges, index).start?.[0])).toEqual([
            before, start, assignedSecond, middle, nestedText, assignedFirst, fallback, after,
        ]);
    });

    test("does not form ranges across shadow or slot boundaries", () => {
        const lightStart = text("cross");
        const assigned = text("slotleft");
        const host = element("host", [assigned]);
        shadow(host, [text("shadow"), slot([assigned]), text("slotright")]);
        const root = element("div", [lightStart, host, text("after")]);
        for (const query of ["crossshadow", "shadow slotleft", "shadowslotleft", "slotleftslotright", "slotrightafter"]) {
            expect(search(root, query).ranges).toHaveLength(0);
        }
        const a = text("pir");
        const b = text("ate");
        const secondHost = element("host", [a, b]);
        shadow(secondHost, [slot([a, b])]);
        expect(search(element("div", [secondHost]), "pirate").ranges).toHaveLength(1);
        const c = text("pir");
        const d = text("ate");
        const thirdHost = element("host", [c, text("unassigned"), d]);
        shadow(thirdHost, [slot([c, d])]);
        expect(search(element("div", [thirdHost]), "pirate").ranges).toHaveLength(0);
    });

    test("keeps exclusions inside shadow roots and under hidden hosts", () => {
        const bar = element("div", [text("hit")]);
        const host = element("host");
        shadow(host, [
            bar, element("script", [text("hit")]), element("style", [text("hit")]),
            element("input", [text("hit")]), element("textarea", [text("hit")]), element("iframe", [text("hit")]),
            element("span", [text("hit")], "none"), element("span", [text("hit")], "inline", "hidden"),
            element("span", [text("hit")], "inline", "visible", "0"), element("span", [text("hit")]),
        ]);
        const hiddenHost = element("host", [], "none");
        shadow(hiddenHost, [text("hit")]);
        const root = element("div", [host, hiddenHost]);
        expect(search(root, "hit", bar).ranges).toHaveLength(1);
    });

    test("caps matches in composed order across light and shadow trees", () => {
        const first = text("x".repeat(600));
        const inside = text("x".repeat(600));
        const last = text("x");
        const host = element("host");
        shadow(host, [inside]);
        const result = search(element("div", [first, host, last]), "x");
        expect(result.ranges).toHaveLength(MAX_FIND_MATCHES);
        expect(result.capped).toBe(true);
        expect(rangeAt(result.ranges, 599).start?.[0]).toBe(first);
        expect(rangeAt(result.ranges, 600).start?.[0]).toBe(inside);
        expect(rangeAt(result.ranges, 999).start?.[0]).toBe(inside);
    });

    test("keeps a selected match when content is appended", () => {
        const original = text("hit hit");
        const root = element("div", [original]);
        const before = search(root, "hit");
        const selected = captureFindSelection(before.ranges[1], 1);
        const live = rangeAt(before.ranges, 1);
        live.start = [original, 0];
        live.end = [original, 0];
        original.data += " hit";
        const after = search(root, "hit");
        expect(after.ranges).toHaveLength(3);
        expect(preserveFindIndex(selected, after.ranges)).toBe(1);
        const earlier = text("hit ");
        setChildren(root, [earlier, original]);
        const withEarlier = search(root, "hit");
        expect(preserveFindIndex(selected, withEarlier.ranges)).toBe(2);
    });

    test("keeps a uniquely identified occurrence after text is prefixed", () => {
        const content = text("hit hit");
        const root = element("div", [content]);
        const before = search(root, "hit");
        const selected = captureFindSelection(before.ranges[1], 1);
        const live = rangeAt(before.ranges, 1);
        content.data = "hit x hit hit";
        live.start = [content, 0];
        live.end = [content, 0];
        const after = search(root, "hit");
        expect(after.ranges).toHaveLength(3);
        expect(preserveFindIndex(selected, after.ranges)).toBe(2);
    });

    test("uses the prior position when context matches multiple occurrences", () => {
        const content = text("hit hit");
        const root = element("div", [content]);
        const before = search(root, "hit");
        const selected = captureFindSelection(before.ranges[1], 1);
        const live = rangeAt(before.ranges, 1);
        content.data = "hit hit hit";
        live.start = [content, 0];
        live.end = [content, 0];
        expect(preserveFindIndex(selected, search(root, "hit").ranges)).toBe(1);
    });

    test("keeps a nearby match in the same tree when the selected block changes", () => {
        const blocks = Array.from({ length: 5 }, () => element("div", [text("hit")], "block"));
        const root = element("div", blocks);
        const before = search(root, "hit");
        const selected = captureFindSelection(before.ranges[2], 2);
        (blocks[2]!.firstChild as FakeText).data = "gone";
        const after = search(root, "hit");
        expect(after.ranges).toHaveLength(4);
        expect(preserveFindIndex(selected, after.ranges)).toBe(2);
    });

    test("selects the first match when the old position cannot be placed", () => {
        const oldRoot = element("div", [text("hit hit")]);
        const selected = captureFindSelection(search(oldRoot, "hit").ranges[1], 1);
        const newRoot = element("div", [text("hit hit hit")]);
        expect(preserveFindIndex(selected, search(newRoot, "hit").ranges)).toBe(0);
    });

    test("bounds the selected occurrence's surrounding context", () => {
        const content = text("a".repeat(400) + "hit" + "b".repeat(400));
        const selected = captureFindSelection(search(element("div", [content]), "hit").ranges[0], 0);
        expect(selected?.context?.before.length).toBeLessThanOrEqual(64);
        expect(selected?.context?.after.length).toBeLessThanOrEqual(64);
        expect(selected?.context?.before.length).toBeGreaterThan(0);
        expect(selected?.context?.after.length).toBeGreaterThan(0);
    });

    test("selects the first match when the selected match disappears", () => {
        const first = text("hit");
        const selectedText = text("hit");
        const root = element("div", [first, element("div", [selectedText], "block")]);
        const before = search(root, "hit");
        expect(before.ranges).toHaveLength(2);
        const selected = captureFindSelection(before.ranges[1], 1);
        selectedText.data = "gone";
        const after = search(root, "hit");
        expect(after.ranges).toHaveLength(1);
        expect(preserveFindIndex(selected, after.ranges)).toBe(0);
        expect(preserveFindIndex(selected, [])).toBe(-1);
    });

    test("uses the closest prior position when a removed match is ambiguous", () => {
        const content = text("hit hit hit");
        const root = element("div", [content]);
        const before = search(root, "hit");
        const selected = captureFindSelection(before.ranges[1], 1);
        content.data = "hit hit";
        const live = rangeAt(before.ranges, 1);
        live.start = [content, 4];
        live.end = [content, 4];
        const after = search(root, "hit");
        expect(after.ranges).toHaveLength(2);
        expect(preserveFindIndex(selected, after.ranges)).toBe(1);
    });

    test("keeps a selected match when its text node is replaced", () => {
        const first = element("div", [text("hit")], "block");
        const second = element("div", [text("hit")], "block");
        const root = element("div", [first, second]);
        const selected = captureFindSelection(search(root, "hit").ranges[1], 1);
        setChildren(second, [text("hit")]);
        expect(preserveFindIndex(selected, search(root, "hit").ranges)).toBe(1);
        setChildren(second, [text("gone")]);
        expect(preserveFindIndex(selected, search(root, "hit").ranges)).toBe(0);
    });

    test("keeps a selected shadow line when a virtualized viewer remounts it", () => {
        const line = (number: string, content: string) => {
            const node = element("div", [text(content)], "block");
            node.attributes = { "data-line": number, "data-line-index": number, "data-line-type": "context" };
            return node;
        };
        const host = element("host");
        const tree = shadow(host, [line("1", "hit"), line("40", "hit")]);
        const root = element("div", [host]);
        const before = search(root, "hit");
        const selected = captureFindSelection(before.ranges[1], 1);
        setChildren(tree, [line("1", "hit"), line("40", "hit"), line("41", "hit")]);
        const after = search(root, "hit");
        expect(after.ranges).toHaveLength(3);
        expect(preserveFindIndex(selected, after.ranges)).toBe(1);
        setChildren(tree, [line("1", "hit"), line("40", "gone"), line("41", "hit")]);
        expect(preserveFindIndex(selected, search(root, "hit").ranges)).toBe(1);
    });

    test("keeps a nearby match when a selected shadow line unmounts", () => {
        const line = (number: string) => {
            const node = element("div", [text("hit")], "block");
            node.attributes = { "data-line": number, "data-line-index": number, "data-line-type": "context" };
            return node;
        };
        const host = Object.assign(element("host"), { isConnected: true });
        const selectedLine = line("40");
        const tree = shadow(host, [line("1"), selectedLine, line("41")]);
        const root = element("div", [host]);
        const selected = captureFindSelection(search(root, "hit").ranges[1], 1);
        setChildren(tree, [line("1"), line("41"), line("42")]);
        selectedLine.parentNode = null;
        selectedLine.parentElement = null;
        expect(preserveFindIndex(selected, search(root, "hit").ranges)).toBe(1);
    });

    test("caps results and wraps selection", () => {
        const root = element("div", [text("x".repeat(MAX_FIND_MATCHES + 10))]);
        const result = search(root, "x");
        expect(result.ranges).toHaveLength(MAX_FIND_MATCHES);
        expect(result.capped).toBe(true);
        expect(search(root, "").capped).toBe(false);
        expect(moveFindIndex(2, 3, 1)).toBe(0);
        expect(moveFindIndex(0, 3, -1)).toBe(2);
        expect(moveFindIndex(-1, 3, -1)).toBe(2);
        expect(moveFindIndex(-1, 0, 1)).toBe(-1);
    });
});

import { afterEach, describe, expect, test } from "bun:test";

import {
    buildTextBlock,
    canAddAnnotation,
    clipRect,
    clipText,
    describeSelection,
    HTML_LIMIT,
    TEXT_BLOCK_LIMIT,
    TEXT_LIMIT,
    uniqueSelector,
} from "../../extensions/browser-annotate/helpers.ts";

const savedDocument = globalThis.document;
const savedCss = globalThis.CSS;
const savedGetComputedStyle = globalThis.getComputedStyle;

afterEach(() => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: savedDocument });
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: savedCss });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: savedGetComputedStyle });
});

describe("browser annotation page helpers", () => {
    test("collapses text and uses an ellipsis at the approved limits", () => {
        expect(clipText("  one\n  two  ", TEXT_LIMIT)).toBe("one two");
        expect(clipText("x".repeat(TEXT_LIMIT + 1), TEXT_LIMIT)).toBe(`${"x".repeat(TEXT_LIMIT - 1)}…`);
        expect(clipText("x".repeat(HTML_LIMIT + 1), HTML_LIMIT)).toHaveLength(HTML_LIMIT);
    });

    test("builds the exact no-selection text and bounds the complete block", () => {
        expect(buildTextBlock("https://example.test/page")).toBe(
            "Selected in the Browser tab on https://example.test/page",
        );
        const details = {
            tag: "p",
            selector: "main > p:nth-of-type(2)",
            text: "A sentence.",
            styles: "display block",
            html: "<p>A sentence.</p>",
            siblings: "<p>, <p> (selected)",
        };
        expect(buildTextBlock("https://example.test/page", details)).toBe([
            "Selected in the Browser tab on https://example.test/page",
            "Element: p",
            "Selector: main > p:nth-of-type(2)",
            "Text: A sentence.",
            "Styles: display block",
            "HTML: <p>A sentence.</p>",
            "Siblings: <p>, <p> (selected)",
        ].join("\n"));
        expect(buildTextBlock("https://example.test/" + "a".repeat(TEXT_BLOCK_LIMIT + 100))).toHaveLength(
            "Selected in the Browser tab on ".length + 1024,
        );
        const cappedDetails = {
            tag: "t".repeat(256),
            selector: "s".repeat(4096),
            text: "x".repeat(500),
            styles: "c".repeat(4096),
            html: "h".repeat(2000),
            siblings: "b".repeat(4096),
        };
        const cappedBlock = buildTextBlock("u".repeat(5000), cappedDetails);
        expect(cappedBlock.length).toBeLessThan(TEXT_BLOCK_LIMIT);
        expect(cappedBlock).toContain("HTML: " + "h".repeat(2000));
        expect(cappedBlock).toEndWith("Siblings: " + "b".repeat(4096));
    });

    test("requires a selection or drawing before adding an annotation", () => {
        expect(canAddAnnotation(false, 0)).toBe(false);
        expect(canAddAnnotation(true, 0)).toBe(true);
        expect(canAddAnnotation(false, 1)).toBe(true);
    });

    test("clips capture rectangles to the viewport and ten-thousand pixel cap", () => {
        expect(clipRect({ x: -10, y: 20, width: 200, height: 200 }, 100, 150)).toEqual({
            x: 0,
            y: 20,
            width: 100,
            height: 130,
        });
        expect(clipRect({ x: 0, y: 0, width: 12000, height: 11000 }, 12000, 11000)).toEqual({
            x: 0,
            y: 0,
            width: 10000,
            height: 10000,
        });
        expect(clipRect({ x: 12000, y: 0, width: 20, height: 20 }, 20000, 20000)).toEqual({
            x: 10000,
            y: 0,
            width: 0,
            height: 20,
        });
    });

    test("returns a CSS selector that uniquely identifies a repeated element", () => {
        interface NodeLike {
            readonly localName: string;
            readonly id: string;
            readonly parentElement: NodeLike | null;
            readonly children: NodeLike[];
            readonly previousElementSibling: NodeLike | null;
            readonly nextElementSibling: NodeLike | null;
        }
        const root: NodeLike = { localName: "html", id: "", parentElement: null, children: [], previousElementSibling: null, nextElementSibling: null };
        const main: NodeLike = { localName: "main", id: "", parentElement: root, children: [], previousElementSibling: null, nextElementSibling: null };
        const first: NodeLike = { localName: "p", id: "", parentElement: main, children: [], previousElementSibling: null, nextElementSibling: null };
        const second: NodeLike = { localName: "p", id: "", parentElement: main, children: [], previousElementSibling: first, nextElementSibling: null };
        main.children.push(first, second);
        root.children.push(main);
        const documentMock = {
            documentElement: root,
            querySelectorAll(selector: string): NodeLike[] {
                return selector === "main > p:nth-of-type(2)" ? [second] : [first, second];
            },
        };
        Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
        Object.defineProperty(globalThis, "CSS", {
            configurable: true,
            value: { escape: (value: string) => value },
        });
        expect(uniqueSelector(second as unknown as Element)).toBe("main > p:nth-of-type(2)");
        expect(uniqueSelector(root as unknown as Element)).toBe("html");
    });

    test("reads only ten nearby siblings and a bounded number of attributes", () => {
        interface Sibling {
            localName: string;
            id: string;
            parentElement: Sibling | null;
            previousElementSibling: Sibling | null;
            nextElementSibling: Sibling | null;
            attributes: NamedNodeMap;
            innerText: string;
            textContent: string;
            outerHTML: string;
        }
        const root = {} as Sibling;
        const parent = { localName: "section", parentElement: root, previousElementSibling: null, nextElementSibling: null } as Sibling;
        let attributeReads = 0;
        const nodes: Sibling[] = Array.from({ length: 40 }, (_, index) => ({
            localName: "p",
            id: "",
            parentElement: parent,
            previousElementSibling: null,
            nextElementSibling: null,
            attributes: {
                length: 100000,
                item() {
                    attributeReads += 1;
                    return { name: "data-value", value: "x".repeat(200) } as Attr;
                },
            } as unknown as NamedNodeMap,
            innerText: "Text",
            textContent: "Text",
            outerHTML: "<p>Text</p>",
        }));
        nodes.forEach((node, index) => {
            node.previousElementSibling = nodes[index - 1] ?? null;
            node.nextElementSibling = nodes[index + 1] ?? null;
        });
        const selected = nodes[20] as Sibling;
        const documentMock = {
            documentElement: root,
            querySelectorAll(selector: string): Sibling[] {
                const match = /nth-of-type\((\d+)\)/.exec(selector);
                return match === null ? nodes : [nodes[Number(match[1]) - 1] as Sibling];
            },
        };
        Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
        Object.defineProperty(globalThis, "CSS", { configurable: true, value: { escape: (value: string) => value } });
        Object.defineProperty(globalThis, "getComputedStyle", {
            configurable: true,
            value: () => ({
                display: "block",
                borderWidth: "0px",
                borderStyle: "none",
                borderRadius: "0px",
                flexDirection: "row",
                justifyContent: "normal",
                alignItems: "normal",
                getPropertyValue: () => "",
            }),
        });
        const details = describeSelection(selected as unknown as Element);
        expect(details.siblings.match(/<p\b/g)).toHaveLength(10);
        expect(details.siblings).toContain("(selected)");
        expect(details.siblings).toContain("data-value");
        expect(attributeReads).toBeLessThanOrEqual(160);
    });
});

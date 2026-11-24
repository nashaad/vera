import { expect, test } from "bun:test";

import { observeFindTree } from "../../clients/ui/src/find/observer.ts";

interface TestNode {
    readonly nodeType: number;
    readonly tagName?: string;
    firstChild: TestNode | null;
    nextSibling: TestNode | null;
    shadowRoot?: TestNode | null;
}

function element(tagName: string, children: TestNode[] = [], shadowRoot: TestNode | null = null): TestNode {
    const node: TestNode = { nodeType: 1, tagName, firstChild: null, nextSibling: null, shadowRoot };
    childrenOf(node, children);
    return node;
}

function childrenOf(node: TestNode, children: TestNode[]): void {
    node.firstChild = children[0] ?? null;
    children.forEach((child, index) => { child.nextSibling = children[index + 1] ?? null; });
}

function shadow(children: TestNode[] = []): TestNode {
    const root: TestNode = { nodeType: 11, firstChild: null, nextSibling: null };
    childrenOf(root, children);
    return root;
}

test("one find observer follows mounted roots and disconnects them all", () => {
    const previous = globalThis.MutationObserver;
    const instances: FakeObserver[] = [];
    class FakeObserver {
        readonly targets: Node[] = [];
        options: MutationObserverInit | undefined;
        constructor(readonly callback: MutationCallback) { instances.push(this); }
        observe(target: Node, options: MutationObserverInit): void {
            this.targets.push(target);
            this.options = options;
        }
        disconnect(): void { this.targets.length = 0; }
        takeRecords(): MutationRecord[] { return []; }
    }
    globalThis.MutationObserver = FakeObserver as unknown as typeof MutationObserver;
    try {
        const inner = shadow();
        const outer = shadow([element("INNER", [], inner)]);
        const ignored = shadow();
        const bar = element("DIV", [element("BAR-HOST", [], ignored)]);
        const host = element("HOST", [], outer);
        const app = element("DIV", [host, bar]);
        const watch = observeFindTree(app as unknown as HTMLElement, () => {}, () => bar as unknown as Element);
        const observer = instances[0]!;
        expect(instances).toHaveLength(1);
        expect(observer.targets).toEqual([app, outer, inner] as unknown as Node[]);
        expect(observer.options?.attributeFilter).toContain("slot");
        expect(observer.options?.attributeFilter).toContain("name");

        const replacement = shadow();
        childrenOf(app, [element("NEW-HOST", [], replacement), bar]);
        watch.refresh();
        expect(observer.targets).toEqual([app, replacement] as unknown as Node[]);
        watch.disconnect();
        expect(observer.targets).toHaveLength(0);
        watch.refresh();
        expect(observer.targets).toHaveLength(0);
    } finally {
        globalThis.MutationObserver = previous;
    }
});

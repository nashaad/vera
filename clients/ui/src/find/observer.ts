const OPTIONS: MutationObserverInit = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "data-window-find-slot", "slot", "name"],
};

export interface FindObserver {
    refresh(): void;
    disconnect(): void;
}

export function observeFindTree(root: HTMLElement, callback: MutationCallback, exclude: () => Element | null): FindObserver {
    const observer = new MutationObserver(callback);
    let active = true;

    function visit(node: Node): void {
        for (let child = node.firstChild; child !== null; child = child.nextSibling) {
            if (child.nodeType !== 1) continue;
            const element = child as Element;
            if (element === exclude() || /^(SCRIPT|STYLE|INPUT|TEXTAREA|IFRAME)$/.test(element.tagName)) continue;
            const shadow = element.shadowRoot;
            if (shadow) {
                observer.observe(shadow, OPTIONS);
                visit(shadow);
            }
            visit(element);
        }
    }

    function refresh(): void {
        if (!active) return;
        const pending = observer.takeRecords();
        if (pending.length > 0) callback(pending, observer);
        observer.disconnect();
        observer.observe(root, OPTIONS);
        visit(root);
    }

    refresh();
    return {
        refresh,
        disconnect() {
            active = false;
            observer.disconnect();
        },
    };
}

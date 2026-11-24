export function findElement(node: Node): Element | null {
    if (node.nodeType === 1) return node as Element;
    if (node.nodeType === 11 && "host" in node) return (node as ShadowRoot).host;
    if (node.nodeType === 3 && (node as Text).assignedSlot) return (node as Text).assignedSlot;
    if (node.parentElement !== null) return node.parentElement;
    const parent = node.parentNode;
    return parent?.nodeType === 11 && "host" in parent ? (parent as ShadowRoot).host : null;
}

export function findParent(element: Element): Element | null {
    if (element.assignedSlot) return element.assignedSlot;
    if (element.parentElement !== null) return element.parentElement;
    const parent = element.parentNode;
    return parent?.nodeType === 11 && "host" in parent ? (parent as ShadowRoot).host : null;
}

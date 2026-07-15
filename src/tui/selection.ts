export interface SelectionPoint {
    readonly x: number;
    readonly y: number;
}

export interface SelectionTreeNode {
    readonly parent: SelectionTreeNode | null;
}

export interface SelectionEntryNode extends SelectionTreeNode {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface TranscriptSelection {
    readonly anchor: SelectionPoint;
    readonly focus: SelectionPoint;
    readonly selectedRenderables: readonly SelectionTreeNode[];
}

export function isTranscriptSelection(
    selection: TranscriptSelection,
    entries: readonly SelectionEntryNode[],
): boolean {
    if (selection.selectedRenderables.length === 0) {
        return false;
    }

    return pointIsInsideEntry(selection.anchor, entries)
        && pointIsInsideEntry(selection.focus, entries)
        && selection.selectedRenderables.every((node) =>
            belongsToEntry(node, entries)
        );
}

function pointIsInsideEntry(
    point: SelectionPoint,
    entries: readonly SelectionEntryNode[],
): boolean {
    return entries.some((entry) =>
        point.x >= entry.x
        && point.x < entry.x + entry.width
        && point.y >= entry.y
        && point.y < entry.y + entry.height
    );
}

function belongsToEntry(
    node: SelectionTreeNode,
    entries: readonly SelectionEntryNode[],
): boolean {
    let current: SelectionTreeNode | null = node;
    while (current !== null) {
        if (entries.some((entry) => entry === current)) {
            return true;
        }
        current = current.parent;
    }
    return false;
}

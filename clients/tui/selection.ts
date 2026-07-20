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

    // The terminal selection can finish one row outside the transcript (for
    // example, after dragging from the first line down to the composer). The
    // selected renderables are the authoritative boundary: copy is safe when
    // every selected node belongs to a transcript entry, regardless of the
    // exact mouse-up coordinate or drag direction.
    return selection.selectedRenderables.every((node) =>
        belongsToEntry(node, entries)
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

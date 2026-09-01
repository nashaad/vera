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

export interface SelectionSource {
    readonly node: SelectionTreeNode;
    readonly speaker: string;
}

export function selectionSpeaker(
    selection: TranscriptSelection,
    sources: readonly SelectionSource[],
): string | undefined {
    if (selection.selectedRenderables.length === 0) {
        return undefined;
    }
    let speaker: string | undefined;
    for (const node of selection.selectedRenderables) {
        const owner = ownerOf(node, sources);
        if (owner === undefined) {
            return undefined;
        }
        if (speaker !== undefined && speaker !== owner) {
            return undefined;
        }
        speaker = owner;
    }
    return speaker;
}

function ownerOf(
    node: SelectionTreeNode,
    sources: readonly SelectionSource[],
): string | undefined {
    let current: SelectionTreeNode | null = node;
    while (current !== null) {
        const match = sources.find((source) => source.node === current);
        if (match !== undefined) {
            return match.speaker;
        }
        current = current.parent;
    }
    return undefined;
}

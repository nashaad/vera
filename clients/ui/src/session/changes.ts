import type { Block, Checklist, FileDiff } from "./model.ts";

// What a stretch of the transcript changed on disk, one entry per file in first-touched order.
export interface FileChange {
    readonly path: string;
    // Each edit's patch, oldest first.
    readonly patches: readonly string[];
    readonly added: number;
    readonly removed: number;
    readonly scratch: boolean;
}

export const MAX_CHANGED_FILES = 200;

export function collectChanges(blocks: readonly Block[]): FileChange[] {
    const byPath = new Map<string, FileChange>();
    for (const block of blocks) {
        if (block.kind !== "tools") continue;
        for (const call of block.calls) {
            if (call.presentation?.kind !== "diff") continue;
            add(byPath, call.presentation.diff);
        }
    }
    return [...byPath.values()];
}

function add(byPath: Map<string, FileChange>, diff: FileDiff): void {
    const known = byPath.get(diff.path);
    if (known === undefined) {
        if (byPath.size >= MAX_CHANGED_FILES) return;
        byPath.set(diff.path, {
            path: diff.path,
            patches: [diff.patch],
            added: diff.added,
            removed: diff.removed,
            scratch: diff.scratch,
        });
        return;
    }
    byPath.set(diff.path, {
        ...known,
        patches: [...known.patches, diff.patch],
        added: known.added + diff.added,
        removed: known.removed + diff.removed,
    });
}

// The blocks after the last prompt, or every block when there is none.
export function lastTurn(blocks: readonly Block[]): readonly Block[] {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        if (blocks[index]?.kind === "user") return blocks.slice(index + 1);
    }
    return blocks;
}

// The newest checklist any call wrote: the session's plan.
export function latestChecklist(blocks: readonly Block[]): Checklist | undefined {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index];
        if (block?.kind !== "tools") continue;
        for (let call = block.calls.length - 1; call >= 0; call -= 1) {
            const presentation = block.calls[call]?.presentation;
            if (presentation?.kind === "checklist") return presentation.checklist;
        }
    }
    return undefined;
}

export function fileName(path: string): string {
    const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? path;
}

// The folder part of a path, relative to the session folder when it sits inside it.
export function fileFolder(path: string, root: string | undefined): string {
    const relative = root !== undefined && root.length > 0 && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    const cut = relative.lastIndexOf("/");
    return cut <= 0 ? "" : relative.slice(0, cut);
}

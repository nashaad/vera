import { CORE_CONTAINERS } from "../registry/core.ts";
import type { WorkbenchApi } from "../workbench/context.tsx";
import { revealContainer } from "../workbench/reveal.ts";

// File opens can precede the Files view mounting, so keep one pending request per session.
type FileOpenListener = (path: string, line?: number) => void;
interface FileOpenRequest {
    readonly path: string;
    readonly line?: number;
}

interface FileOpenHunk {
    readonly additionStart: number;
    readonly additionCount: number;
}

export function firstNewSideLine(hunks: readonly FileOpenHunk[]): number | undefined {
    const hunk = hunks.find((entry) => entry.additionCount > 0) ?? hunks[0];
    return hunk === undefined ? undefined : Math.max(1, hunk.additionStart);
}

const listeners = new Map<string, Set<FileOpenListener>>();
const waiting = new Map<string, FileOpenRequest>();

export function requestFileOpen(sessionId: string, path: string, line?: number): void {
    const group = listeners.get(sessionId);
    if (group === undefined || group.size === 0) {
        waiting.set(sessionId, line === undefined ? { path } : { path, line });
        return;
    }
    for (const listener of group) listener(path, line);
}

export function openFileInFiles(
    workbench: Pick<WorkbenchApi, "layout" | "dispatch">,
    sessionId: string,
    path: string,
    line?: number,
): void {
    requestFileOpen(sessionId, path, line);
    revealContainer(workbench, CORE_CONTAINERS.files);
}

export function subscribeFileOpen(sessionId: string, listener: FileOpenListener): () => void {
    const group = listeners.get(sessionId) ?? new Set<FileOpenListener>();
    group.add(listener);
    listeners.set(sessionId, group);
    const pending = waiting.get(sessionId);
    if (pending !== undefined) {
        waiting.delete(sessionId);
        listener(pending.path, pending.line);
    }
    return () => {
        group.delete(listener);
        if (group.size === 0) listeners.delete(sessionId);
    };
}

export function clearFileOpenForTest(): void {
    listeners.clear();
    waiting.clear();
}

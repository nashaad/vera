import { folderName } from "../protocol/sessionGroups.ts";
import type { SessionRow } from "../protocol/sessions.ts";

export const FOLDER_MENU_LIMIT = 8;
export const TITLE_LIMIT = 60;

export interface FolderChoice {
    readonly folder: string;
    readonly name: string;
}

// Distinct folders ordered by their most recent session, newest first.
export function folderChoices(rows: readonly SessionRow[], limit: number = FOLDER_MENU_LIMIT): readonly FolderChoice[] {
    const latest = new Map<string, number>();
    for (const row of rows) {
        if (row.workspace.length === 0) continue;
        const at = row.updatedAt ?? 0;
        const seen = latest.get(row.workspace);
        if (seen === undefined || at > seen) latest.set(row.workspace, at);
    }
    return [...latest.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, limit)
        .map(([folder]) => ({ folder, name: folderName(folder) }));
}

// The first non-empty line, cut to a number of code points (not UTF-16 units).
export function sessionTitle(text: string, limit: number = TITLE_LIMIT): string {
    const line = text
        .split("\n")
        .map((part) => part.trim())
        .find((part) => part.length > 0) ?? "";
    return Array.from(line).slice(0, limit).join("");
}

export interface EnterContext {
    readonly shift: boolean;
    readonly composing: boolean;
    readonly empty: boolean;
    readonly running: boolean;
    readonly queued: boolean;
}

// "passthrough" leaves the key to the textarea; "none" swallows it so no newline appears.
export type EnterAction = "passthrough" | "none" | "send" | "release-all" | "abort";

export function enterAction(context: EnterContext): EnterAction {
    if (context.composing || context.shift) return "passthrough";
    if (!context.empty) return "send";
    if (!context.running) return "none";
    return context.queued ? "release-all" : "abort";
}

export interface EscapeContext {
    readonly composing: boolean;
    readonly empty: boolean;
    readonly queued: boolean;
}

export type EscapeAction = "passthrough" | "release-one";

export function escapeAction(context: EscapeContext): EscapeAction {
    if (context.composing || !context.empty || !context.queued) return "passthrough";
    return "release-one";
}

export interface ArrowUpContext {
    readonly composing: boolean;
    readonly empty: boolean;
    readonly held: boolean;
}

export type ArrowUpAction = "passthrough" | "withdraw";

// Up in an empty box takes the newest held prompt back out of the queue to edit it.
export function arrowUpAction(context: ArrowUpContext): ArrowUpAction {
    if (context.composing || !context.empty || !context.held) return "passthrough";
    return "withdraw";
}

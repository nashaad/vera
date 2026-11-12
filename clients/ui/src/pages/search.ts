import type { SessionSearchHit, SessionSearchMatch } from "../protocol/bridge.ts";
import { folderName } from "../protocol/sessionGroups.ts";
import type { SessionRow } from "../protocol/sessions.ts";

export interface SnippetSegment {
    readonly text: string;
    readonly marked: boolean;
}

export interface SearchFilter {
    readonly workspace: string | undefined;
    // Set when the search is limited to the conversation last open.
    readonly agentId: string | undefined;
}

export interface SearchKey extends SearchFilter {
    readonly query: string;
}

export interface SearchRow {
    readonly agentId: string;
    readonly title: string;
    readonly workspace: string;
    // True for a session known to be a chat, which has no folder to show.
    readonly chat: boolean;
    readonly updatedAt: number | undefined;
    // Empty for a title-only match.
    readonly hits: readonly SessionSearchHit[];
}

export interface WorkspaceChoice {
    readonly workspace: string;
    readonly label: string;
}

// The query is matched through a case-insensitive pattern, not by lowercasing the text first, because
// lowercasing can change the length of a string and move the indexes.
export function markSnippet(snippet: string, query: string): readonly SnippetSegment[] {
    const needle = query.trim();
    const found = needle.length === 0 ? null : new RegExp(escapePattern(needle), "i").exec(snippet);
    if (found === null) return [{ text: snippet, marked: false }];
    const end = found.index + found[0].length;
    return [
        { text: snippet.slice(0, found.index), marked: false },
        { text: found[0], marked: true },
        { text: snippet.slice(end), marked: false },
    ].filter((segment) => segment.text.length > 0);
}

export function inScope(agentId: string, workspace: string, filter: SearchFilter): boolean {
    return (filter.agentId === undefined || agentId === filter.agentId)
        && (filter.workspace === undefined || workspace === filter.workspace);
}

export function titleMatches(rows: readonly SessionRow[], query: string, filter: SearchFilter): readonly SessionRow[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];
    return rows.filter((row) => inScope(row.id, row.workspace, filter) && row.name.toLowerCase().includes(needle));
}

// Host matches keep the host's order and come first; a session already matched by the host is not repeated.
// A host match carries no chat label, so it is read from the listed rows.
export function mergeMatches(
    hostMatches: readonly SessionSearchMatch[],
    titleRows: readonly SessionRow[],
    listed: readonly SessionRow[] = titleRows,
): readonly SearchRow[] {
    const chatIds = new Set(listed.filter((row) => row.chat).map((row) => row.id));
    const merged: SearchRow[] = hostMatches.map((match) => ({
        agentId: match.agentId,
        title: match.title,
        workspace: match.workspace,
        chat: chatIds.has(match.agentId),
        updatedAt: Number.isFinite(match.updatedAt) ? match.updatedAt : undefined,
        hits: match.hits,
    }));
    const seen = new Set(merged.map((row) => row.agentId));
    for (const row of titleRows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push({ agentId: row.id, title: row.name, workspace: row.workspace, chat: row.chat, updatedAt: row.updatedAt, hits: [] });
    }
    return merged;
}

export function workspaceChoices(rows: readonly SessionRow[]): readonly WorkspaceChoice[] {
    const seen = new Set<string>();
    const choices: WorkspaceChoice[] = [];
    for (const row of rows) {
        if (row.chat || row.workspace.length === 0 || seen.has(row.workspace)) continue;
        seen.add(row.workspace);
        choices.push({ workspace: row.workspace, label: folderName(row.workspace) });
    }
    return choices;
}

export function sameSearch(a: SearchKey, b: SearchKey): boolean {
    return a.query === b.query && a.workspace === b.workspace && a.agentId === b.agentId;
}

function escapePattern(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

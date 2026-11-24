import type { SessionPane, SessionSearchHit } from "../protocol/bridge.ts";
import type { Route } from "../pages/routes.ts";
import { findElement, findParent } from "./tree.ts";

export interface SearchResultFindRequest {
    readonly type: "search-result";
    readonly agentId: string;
    readonly query: string;
    readonly entryId: string | null;
}

export interface SearchResultFindReady {
    readonly type: "search-result-ready";
    readonly agentId: string;
    readonly preservePosition: () => void;
}

export interface SearchResultFindSelection {
    readonly index: number;
    readonly inSession: boolean;
}

export interface SessionHistoryReady {
    readonly agentId: string;
    readonly loaded: boolean;
}

export function searchResultFindReady(agentId: string, pane: SessionPane, watch: SessionHistoryReady, preservePosition: () => void): SearchResultFindReady | undefined {
    if (pane !== "main" || !watch.loaded || watch.agentId !== agentId) return undefined;
    return { type: "search-result-ready", agentId, preservePosition };
}

export function searchResultFindRequest(agentId: string, query: string, hit: SessionSearchHit | undefined): SearchResultFindRequest | undefined {
    if (hit === undefined || query.length === 0) return undefined;
    return { type: "search-result", agentId, query, entryId: hit.entryId };
}

export function isSearchResultFindRequest(value: unknown): value is SearchResultFindRequest {
    if (typeof value !== "object" || value === null) return false;
    const request = value as Record<string, unknown>;
    return request.type === "search-result"
        && typeof request.agentId === "string" && request.agentId.length > 0
        && typeof request.query === "string" && request.query.length > 0
        && (request.entryId === null || typeof request.entryId === "string");
}

export function isSearchResultFindReady(value: unknown): value is SearchResultFindReady {
    if (typeof value !== "object" || value === null) return false;
    const ready = value as Record<string, unknown>;
    return ready.type === "search-result-ready" && typeof ready.agentId === "string" && ready.agentId.length > 0
        && typeof ready.preservePosition === "function";
}

export class PendingSearchResultFind {
    private pending: SearchResultFindRequest | undefined;

    set(request: SearchResultFindRequest): void {
        this.pending = request;
    }

    clear(): void {
        this.pending = undefined;
    }

    routeChanged(route: Route): void {
        if (this.pending !== undefined && (route.kind !== "session" || route.agentId !== this.pending.agentId)) this.clear();
    }

    take(agentId: string): SearchResultFindRequest | undefined {
        if (this.pending?.agentId !== agentId) return undefined;
        const request = this.pending;
        this.clear();
        return request;
    }
}

function matchesEntry(projected: string | null, entryId: string | null): boolean {
    if (projected === null || entryId === null || entryId.length === 0 || !projected.startsWith(entryId)) return false;
    const suffix = projected.slice(entryId.length);
    return suffix === "" || /^#(?:\d+|r\d+)$/.test(suffix);
}

function sessionMatch(range: Range, request: SearchResultFindRequest): { readonly inSession: boolean; readonly inEntry: boolean } {
    let inEntry = false;
    let inTranscript = false;
    for (let element = findElement(range.startContainer); element !== null; element = findParent(element)) {
        if (!inTranscript) {
            if (element.matches(".transcript-scroll[data-session]")) {
                if (element.getAttribute("data-session") !== request.agentId) break;
                inTranscript = true;
            } else if (matchesEntry(element.getAttribute("data-find-entry"), request.entryId)) {
                inEntry = true;
            }
        } else if (element.matches(".session-page")) {
            if (element.getAttribute("data-pane") === "main") return { inSession: true, inEntry };
            break;
        }
    }
    return { inSession: false, inEntry: false };
}

export function selectSearchResultMatch(ranges: readonly Range[], request: SearchResultFindRequest): SearchResultFindSelection {
    let firstSession = -1;
    for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        if (range === undefined) continue;
        const match = sessionMatch(range, request);
        if (!match.inSession) continue;
        if (firstSession < 0) firstSession = index;
        if (match.inEntry) return { index, inSession: true };
    }
    if (firstSession >= 0) return { index: firstSession, inSession: true };
    return { index: ranges.length === 0 ? -1 : 0, inSession: false };
}

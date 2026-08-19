import { connectHost } from "./connection.ts";
import {
    MAX_HITS_PER_SESSION,
    MAX_SEARCH_RESULTS,
    type SessionSearchHit,
    type SessionSearchQuery,
    type SessionSearchResult,
    type SessionSearchResults,
} from "../store/session-search.ts";

export class SessionSearchUnavailableError extends Error {
    constructor() {
        super("This host has no session directory to search");
        this.name = "SessionSearchUnavailableError";
    }
}

/**
 * Ask the host to scan its transcripts.
 *
 * A one-shot request on the host socket, the same shape as the agent listing,
 * rather than anything on an attachment: a search spans every session on the
 * machine, so belonging to the attached one would be a lie about its scope.
 */
export async function searchSessionsThroughHost(
    socketPath: string,
    query: SessionSearchQuery,
    responseTimeoutMs = 10_000,
): Promise<SessionSearchResults> {
    const connection = await connectHost({ socketPath });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await connection.send({ type: "search_sessions", query });
        const response = asRecord(await Promise.race([
            connection.receive(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error("Host session search deadline exceeded"));
                }, responseTimeoutMs);
            }),
        ]));
        if (response?.type === "session_search_unavailable") {
            throw new SessionSearchUnavailableError();
        }
        const results = response?.type === "session_search_results"
            ? parseSearchResults(response.results)
            : undefined;
        if (results === undefined) {
            throw new Error("Host returned invalid session search results");
        }
        return results;
    } finally {
        clearTimeout(timeout);
        connection.close();
    }
}

/**
 * Rejects rather than repairs, and enforces the same bounds the host applies:
 * a result set the client cannot trust field by field would put transcript
 * text on screen under a session name that may not be the one it came from.
 */
export function parseSearchResults(
    value: unknown,
): SessionSearchResults | undefined {
    const snapshot = asRecord(value);
    if (
        snapshot === undefined
        || typeof snapshot.truncated !== "boolean"
        || !Array.isArray(snapshot.results)
        || snapshot.results.length > MAX_SEARCH_RESULTS
    ) {
        return undefined;
    }
    const results: SessionSearchResult[] = [];
    for (const candidate of snapshot.results) {
        const result = parseSearchResult(candidate);
        if (result === undefined) return undefined;
        results.push(result);
    }
    return { results, truncated: snapshot.truncated };
}

function parseSearchResult(value: unknown): SessionSearchResult | undefined {
    const result = asRecord(value);
    if (
        result === undefined
        || !isText(result.session_id)
        || !isText(result.session_path)
        || typeof result.title !== "string"
        || typeof result.workspace !== "string"
        || !isText(result.updated_at)
        || Number.isNaN(Date.parse(result.updated_at as string))
        || !Array.isArray(result.hits)
        || result.hits.length === 0
        || result.hits.length > MAX_HITS_PER_SESSION
    ) {
        return undefined;
    }
    const hits: SessionSearchHit[] = [];
    for (const candidate of result.hits) {
        const hit = parseSearchHit(candidate);
        if (hit === undefined) return undefined;
        hits.push(hit);
    }
    return {
        session_id: result.session_id as string,
        session_path: result.session_path as string,
        title: result.title,
        workspace: result.workspace,
        updated_at: result.updated_at as string,
        hits,
    };
}

const HIT_KINDS = [
    "user_message",
    "agent_message",
    "tool_command",
    "file_edit",
] as const;

function parseSearchHit(value: unknown): SessionSearchHit | undefined {
    const hit = asRecord(value);
    if (
        hit === undefined
        || !(HIT_KINDS as readonly unknown[]).includes(hit.kind)
        || typeof hit.snippet !== "string"
        || (hit.entry_id !== null && !isText(hit.entry_id))
    ) {
        return undefined;
    }
    return {
        kind: hit.kind as SessionSearchHit["kind"],
        snippet: hit.snippet,
        entry_id: hit.entry_id as string | null,
    };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function isText(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

import { isAbsolute } from "node:path";

import { connectHost, type HostConnection } from "../../../src/host/connection.ts";
import type {
    SessionSearchHit,
    SessionSearchKind,
    SessionSearchMatch,
    SessionSearchRequest,
    SessionSearchResult,
} from "../../ui/src/protocol/bridge.ts";

const MAX_QUERY_CHARS = 200;
const MAX_ID_CHARS = 128;
const SEARCH_TIMEOUT_MS = 10_000;
// The host returns at most 20 sessions and 50 hits for one session; more is a reply this client refuses.
const MAX_MATCHES = 20;
const MAX_HITS = 50;
const HIT_KINDS: readonly SessionSearchKind[] = ["user_message", "agent_message", "tool_command", "file_edit"];

type Fields = Record<string, unknown>;

export function searchArgument(value: unknown): SessionSearchRequest | undefined {
    if (!isFields(value)) return undefined;
    const query = typeof value.query === "string" ? value.query.trim() : "";
    if (query.length === 0 || query.length > MAX_QUERY_CHARS) return undefined;
    const workspace = typeof value.workspace === "string" && isAbsolute(value.workspace) ? value.workspace : undefined;
    const agentId = typeof value.agentId === "string" && value.agentId.length > 0 && value.agentId.length <= MAX_ID_CHARS
        ? value.agentId
        : undefined;
    return {
        query,
        ...(workspace === undefined ? {} : { workspace }),
        ...(agentId === undefined ? {} : { agentId }),
    };
}

export async function searchSessions(
    socketPath: string | undefined,
    request: SessionSearchRequest,
): Promise<SessionSearchResult> {
    if (socketPath === undefined) return { ok: false, reason: "The host is not running." };
    const query = {
        query: request.query,
        ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
        ...(request.agentId === undefined ? {} : { session_id: request.agentId }),
    };
    let connection: HostConnection | undefined;
    try {
        connection = await connectHost({ socketPath });
        await connection.send({ type: "search_sessions", query });
        const reply = await connection.receiveWithin(SEARCH_TIMEOUT_MS, "The host did not answer the search in time.");
        if (isFields(reply) && reply.type === "session_search_unavailable") {
            return { ok: false, reason: "This host has no session folder to search." };
        }
        const parsed = isFields(reply) && reply.type === "session_search_results" ? parseResults(reply.results) : undefined;
        return parsed ?? { ok: false, reason: "The host sent search results this window could not read." };
    } catch (error) {
        return { ok: false, reason: error instanceof Error && error.message.length > 0 ? error.message : "The host did not answer the search." };
    } finally {
        connection?.close();
    }
}

export function parseResults(value: unknown): SessionSearchResult | undefined {
    if (!isFields(value) || typeof value.truncated !== "boolean" || !Array.isArray(value.results)) return undefined;
    if (value.results.length > MAX_MATCHES) return undefined;
    const matches: SessionSearchMatch[] = [];
    for (const entry of value.results) {
        const match = parseMatch(entry);
        if (match === undefined) return undefined;
        matches.push(match);
    }
    return { ok: true, matches, truncated: value.truncated };
}

function parseMatch(value: unknown): SessionSearchMatch | undefined {
    if (!isFields(value)) return undefined;
    const { session_id: id, title, workspace, updated_at: updated, hits } = value;
    if (typeof id !== "string" || id.length === 0 || typeof title !== "string" || typeof workspace !== "string") return undefined;
    if (typeof updated !== "string" || !Array.isArray(hits) || hits.length > MAX_HITS) return undefined;
    const parsedHits: SessionSearchHit[] = [];
    for (const hit of hits) {
        if (!isFields(hit) || typeof hit.snippet !== "string") return undefined;
        const kind = HIT_KINDS.find((candidate) => candidate === hit.kind);
        if (kind === undefined) return undefined;
        parsedHits.push({ kind, snippet: hit.snippet });
    }
    return { agentId: id, title, workspace, updatedAt: Date.parse(updated), hits: parsedHits };
}

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

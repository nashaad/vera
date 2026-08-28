import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Full-text search across the transcripts already on disk.
 *
 * A streaming scan and nothing else: no index, no new file, no derived store.
 * The transcripts are the only copy, so a query can never disagree with what a
 * session actually says, and there is nothing to rebuild when one is trashed.
 */

export type SessionSearchKind =
    | "user_message"
    | "agent_message"
    | "tool_command"
    | "file_edit";

export type SessionSearchFilter = "messages" | "tools" | "files";

export interface SessionSearchQuery {
    readonly query: string;
    /** Omitted searches every kind. */
    readonly kind?: SessionSearchFilter;
    /** Directory path. Omitted searches every workspace. */
    readonly workspace?: string;
    /** One session, by id. Omitted searches every session. */
    readonly session_id?: string;
}

export interface SessionSearchHit {
    readonly kind: SessionSearchKind;
    readonly snippet: string;
    /**
     * The transcript entry id, which is the same reference resume and rewind
     * take. Null on a hit that no message entry carries an id for, so a client
     * opens the session rather than a position that does not exist.
     */
    readonly entry_id: string | null;
}

export interface SessionSearchResult {
    readonly session_id: string;
    readonly session_path: string;
    readonly title: string;
    readonly workspace: string;
    readonly updated_at: string;
    readonly hits: readonly SessionSearchHit[];
}

export interface SessionSearchResults {
    readonly results: readonly SessionSearchResult[];
    /** True when the bound stopped the scan before every session was read. */
    readonly truncated: boolean;
}

export const MAX_SEARCH_RESULTS = 20;
export const MAX_HITS_PER_SESSION = 3;
/**
 * The cap when the query names one session.
 *
 * Three hits keeps a list of twenty sessions readable, because the session is
 * what is being chosen there. A search of one session is the list, so every
 * match is a row worth having and the pane scrolls them.
 */
export const MAX_HITS_IN_ONE_SESSION = 50;
export const MAX_SNIPPET_LENGTH = 96;
const MAX_LINE_BYTES = 512 * 1_024;
const SNIPPET_LEAD = 24;

export const NO_SEARCH_RESULTS: SessionSearchResults = Object.freeze({
    results: Object.freeze([]) as readonly SessionSearchResult[],
    truncated: false,
});

export interface SessionSearchOptions {
    readonly maxResults?: number;
    readonly maxHitsPerSession?: number;
    /** Authoritative transcript path when the query names one session. */
    readonly sessionPath?: string;
}

/**
 * Search every transcript in a directory, newest file first.
 *
 * Newest first is what makes the bound honest: stopping early drops the oldest
 * sessions rather than whichever the filesystem happened to list last.
 */
export async function searchSessions(
    sessionDirectory: string,
    query: SessionSearchQuery,
    options: SessionSearchOptions = {},
): Promise<SessionSearchResults> {
    const needle = query.query.trim().toLowerCase();
    if (needle.length === 0) return NO_SEARCH_RESULTS;
    const maxResults = options.maxResults ?? MAX_SEARCH_RESULTS;
    const maxHits = options.maxHitsPerSession
        ?? (query.session_id === undefined
            ? MAX_HITS_PER_SESSION
            : MAX_HITS_IN_ONE_SESSION);

    const sessionPath = query.session_id === undefined
        ? undefined
        : options.sessionPath;
    let names: readonly string[] = [];
    if (sessionPath === undefined) {
        try {
            names = await readdir(sessionDirectory);
        } catch {
            return NO_SEARCH_RESULTS;
        }
    }

    // The runtime resolves named sessions through its index because a
    // resumed transcript may not be named after its id. The conventional
    // filename remains the fallback for direct store callers.
    const paths = sessionPath === undefined
        ? names
            .filter((name) => name.endsWith(".jsonl"))
            .filter((name) => query.session_id === undefined
                || name === `${query.session_id}.jsonl`)
            .map((name) => join(sessionDirectory, name))
        : [sessionPath];
    const files = (await Promise.all(
        paths
            .map(async (path) => {
                const info = await stat(path).catch(() => undefined);
                return info === undefined
                    ? undefined
                    : { path, updatedAt: info.mtime.toISOString() };
            }),
    )).flatMap((file) => file === undefined ? [] : [file])
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const results: SessionSearchResult[] = [];
    let truncated = false;
    for (const file of files) {
        if (results.length >= maxResults) {
            truncated = true;
            break;
        }
        const result = await searchSessionFile(
            file.path,
            file.updatedAt,
            needle,
            query,
            maxHits,
        );
        if (result !== undefined) results.push(result);
    }
    return { results, truncated };
}

/** One transcript, read a line at a time so a large session is never held whole. */
export async function searchSessionFile(
    path: string,
    updatedAt: string,
    needle: string,
    query: SessionSearchQuery,
    maxHits: number,
): Promise<SessionSearchResult | undefined> {
    let header: Record<string, unknown> | undefined;
    let title: string | undefined;
    let name: string | null | undefined;
    const hits: SessionSearchHit[] = [];

    const stream = Bun.file(path).stream();
    const decoder = new TextDecoder("utf-8");
    let buffered = "";

    const consume = (line: string): void => {
        if (line.length === 0 || line.length > MAX_LINE_BYTES) return;
        let record: Record<string, unknown>;
        try {
            record = JSON.parse(line) as Record<string, unknown>;
        } catch {
            // A half-written last line is normal on a session being appended
            // to right now, and a corrupt one in the middle is still no reason
            // to lose the rest of the transcript.
            return;
        }
        if (record.type === "session") {
            header = record;
            return;
        }
        if (record.type === "session_name") {
            if (typeof record.name === "string" || record.name === null) {
                name = record.name as string | null;
            }
            return;
        }
        if (record.type !== "message") return;
        const message = record.message as Record<string, unknown> | undefined;
        if (message === undefined) return;
        const entryId = typeof record.id === "string" ? record.id : null;
        const internal = message.internal === true;
        const role = message.role;
        const content = Array.isArray(message.content) ? message.content : [];

        if (role === "user" && !internal && title === undefined) {
            const text = joinText(content);
            if (text.length > 0) title = text.slice(0, 80);
        }
        if (hits.length >= maxHits) return;

        for (const block of content) {
            if (hits.length >= maxHits) return;
            const hit = blockHit(block, role, internal, entryId, needle, query);
            if (hit !== undefined) hits.push(hit);
        }
    };

    for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
            consume(buffered.slice(0, newline));
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf("\n");
        }
        if (buffered.length > MAX_LINE_BYTES) buffered = "";
    }
    consume(buffered);

    if (header === undefined || hits.length === 0) return undefined;
    const workspace = typeof header.cwd === "string" ? header.cwd : "";
    if (query.workspace !== undefined && workspace !== query.workspace) {
        return undefined;
    }
    const sessionId = typeof header.id === "string" ? header.id : "";
    if (sessionId.length === 0) return undefined;
    return {
        session_id: sessionId,
        session_path: path,
        title: name ?? title ?? sessionId,
        workspace,
        updated_at: updatedAt,
        hits,
    };
}

function blockHit(
    block: unknown,
    role: unknown,
    internal: boolean,
    entryId: string | null,
    needle: string,
    query: SessionSearchQuery,
): SessionSearchHit | undefined {
    if (typeof block !== "object" || block === null) return undefined;
    const value = block as Record<string, unknown>;

    if (value.type === "text" && typeof value.text === "string") {
        if (internal || (role !== "user" && role !== "assistant")) {
            return undefined;
        }
        if (query.kind !== undefined && query.kind !== "messages") {
            return undefined;
        }
        const snippet = snippetAround(value.text, needle);
        return snippet === undefined ? undefined : {
            kind: role === "user" ? "user_message" : "agent_message",
            snippet,
            entry_id: entryId,
        };
    }

    if (value.type === "tool_call" && typeof value.name === "string") {
        const input = typeof value.input === "object" && value.input !== null
            ? value.input as Record<string, unknown>
            : {};
        const path = firstText(input, ["file_path", "path"]);
        if (path !== undefined
            && (query.kind === undefined || query.kind === "files")) {
            const snippet = snippetAround(path, needle);
            if (snippet !== undefined) {
                return { kind: "file_edit", snippet, entry_id: entryId };
            }
        }
        if (query.kind !== undefined && query.kind !== "tools") return undefined;
        const command = firstText(input, ["command", "pattern", "query"]);
        const text = command === undefined
            ? value.name
            : `${value.name} ${command}`;
        const snippet = snippetAround(text, needle);
        return snippet === undefined ? undefined : {
            kind: "tool_command",
            snippet,
            entry_id: entryId,
        };
    }
    return undefined;
}

function firstText(
    input: Record<string, unknown>,
    keys: readonly string[],
): string | undefined {
    for (const key of keys) {
        const value = input[key];
        if (typeof value === "string" && value.trim().length > 0) return value;
    }
    return undefined;
}

function joinText(content: readonly unknown[]): string {
    return content
        .flatMap((block) => {
            const value = block as Record<string, unknown> | null;
            return value?.type === "text" && typeof value.text === "string"
                ? [value.text]
                : [];
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * The window of text around the match, with an ellipsis on each cut side.
 *
 * Centred on the match rather than taken from the front, because a query that
 * matched a thousand words in is otherwise shown a snippet that does not
 * contain what was searched for.
 */
export function snippetAround(
    text: string,
    needle: string,
): string | undefined {
    const line = text.replace(/\s+/g, " ").trim();
    const at = line.toLowerCase().indexOf(needle);
    if (at === -1) return undefined;
    if (line.length <= MAX_SNIPPET_LENGTH) return line;
    const start = Math.max(0, at - SNIPPET_LEAD);
    const end = Math.min(line.length, start + MAX_SNIPPET_LENGTH);
    return `${start > 0 ? "…" : ""}${line.slice(start, end)}${
        end < line.length ? "…" : ""
    }`;
}

import type { JsonObject, JsonValue } from "../extensions/contributions.ts";
import {
    WatchFatalError,
    type SourceEvent,
    type WatchConnector,
    type WatchRuntimeContext,
} from "./source.ts";

/**
 * The first connector: arc's event log over SSE.
 *
 * arc is the only inter-node bus, and this watch is the one bridge in. The
 * connector holds no state of its own. It reads the cursor the host persisted,
 * hands it back as `Last-Event-ID`, and lets the host advance it from the `id`
 * arc stamps on each frame.
 */

export const ARC_SOURCE_FAMILY = "arc";
/** Frames larger than this are dropped rather than buffered without bound. */
export const MAX_FRAME_BYTES = 64 * 1024;

/** Resolves the bearer token for a watch. The host holds credentials; the
 * definition is committed data and never carries one. */
export type WatchSecretResolver = (watchId: string) => string | null;

export type FetchLike = (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export interface ArcConnectorOptions {
    readonly fetch?: FetchLike;
    readonly secret?: WatchSecretResolver;
}

interface ArcEvent {
    readonly seq: number;
    readonly kind: string;
    readonly issue_id?: string;
    readonly topic?: string;
    readonly actor?: string;
    readonly session?: string;
    readonly payload?: string;
    readonly ts: string;
}

export function createArcConnector(
    options: ArcConnectorOptions = {},
): WatchConnector {
    const doFetch = options.fetch ?? globalThis.fetch;
    const secret = options.secret ?? ((): null => null);

    return {
        sourceFamily: ARC_SOURCE_FAMILY,
        async run(context: WatchRuntimeContext): Promise<void> {
            const url = arcEventsUrl(context.config);
            const token = secret(context.watchId);
            const cursor = context.cursor();
            const headers: Record<string, string> = {
                Accept: "text/event-stream",
            };
            if (cursor !== null) {
                headers["Last-Event-ID"] = cursor;
            }
            if (token !== null) {
                headers.Authorization = `Bearer ${token}`;
            }

            const response = await doFetch(url, {
                headers,
                signal: context.signal,
            });
            if (response.status === 401 || response.status === 403) {
                throw new WatchFatalError(
                    "auth_rejected",
                    `arc rejected the watch credentials with ${response.status}`,
                );
            }
            if (!response.ok) {
                throw new Error(`arc events request failed with ${response.status}`);
            }
            const body = response.body;
            if (body === null) {
                throw new Error("arc events response carried no body");
            }
            context.healthy();

            for await (const frame of readFrames(body, context.signal)) {
                const event = toSourceEvent(frame);
                if (event !== null) {
                    await context.admit([event]);
                }
            }
        },
    };
}

interface SseFrame {
    readonly id: string | null;
    readonly data: string;
}

/**
 * `config.server` is the arc base URL; the rest are arc's own request-scoped
 * filters. Nothing here is interpolated into anything but query parameters,
 * and an unknown key is a load error rather than a silently ignored filter.
 */
export function arcEventsUrl(config: JsonObject): string {
    const server = config.server;
    if (typeof server !== "string" || server.trim() === "") {
        throw new WatchFatalError(
            "bad_config",
            "an arc watch needs a server URL in config.server",
        );
    }
    if (config.topics !== undefined) {
        throw new WatchFatalError(
            "bad_config",
            "arc filters on one topic; use config.topic",
        );
    }
    let url: URL;
    try {
        url = new URL("/events", server);
    } catch {
        throw new WatchFatalError(
            "bad_config",
            `config.server is not a URL: ${server}`,
        );
    }
    for (const key of ["topic", "issue_id", "actor", "exclude_session"]) {
        const value = config[key];
        if (value === undefined) {
            continue;
        }
        if (typeof value !== "string") {
            throw new WatchFatalError(
                "bad_config",
                `arc watch config.${key} must be a string`,
            );
        }
        url.searchParams.set(key, value);
    }
    const kinds = config.kind;
    if (kinds !== undefined) {
        if (!Array.isArray(kinds) || kinds.some((k) => typeof k !== "string")) {
            throw new WatchFatalError(
                "bad_config",
                "arc watch config.kind must be an array of strings",
            );
        }
        url.searchParams.set("kind", (kinds as readonly string[]).join(","));
    }
    return url.toString();
}

async function* readFrames(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
): AsyncGenerator<SseFrame> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    try {
        while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const frame = parseFrame(block);
                if (frame !== null) {
                    yield frame;
                }
                boundary = buffer.indexOf("\n\n");
            }
            if (buffer.length > MAX_FRAME_BYTES) {
                buffer = "";
            }
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}

function parseFrame(block: string): SseFrame | null {
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
        if (line === "" || line.startsWith(":")) {
            continue;
        }
        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        const rest = separator === -1 ? "" : line.slice(separator + 1);
        const value = rest.startsWith(" ") ? rest.slice(1) : rest;
        if (field === "id") {
            id = value;
        } else if (field === "data") {
            data.push(value);
        }
    }
    if (data.length === 0) {
        return null;
    }
    return { id, data: data.join("\n") };
}

/**
 * One arc event becomes one inbox entry. `actor` and `session` are copied so
 * the causality guard downstream is a query rather than agent-side logic; an
 * event arc could not attribute gets the watch itself as a stable actor.
 */
export function toSourceEvent(frame: SseFrame): SourceEvent | null {
    let event: ArcEvent;
    try {
        event = JSON.parse(frame.data) as ArcEvent;
    } catch {
        return null;
    }
    if (
        typeof event !== "object" || event === null
        || typeof event.seq !== "number" || typeof event.kind !== "string"
        || typeof event.ts !== "string"
    ) {
        return null;
    }
    const cursor = frame.id ?? `v1:${event.seq}`;
    return {
        id: `arc:${event.seq}`,
        kind: `arc.${event.kind}`,
        ts: event.ts,
        actor: event.actor !== undefined && event.actor !== ""
            ? event.actor
            : "source:arc",
        session: event.session !== undefined && event.session !== ""
            ? event.session
            : null,
        cursor,
        payload: arcPayload(event),
    };
}

function arcPayload(event: ArcEvent): JsonObject {
    const payload: Record<string, JsonValue> = {
        seq: event.seq,
        kind: event.kind,
    };
    if (event.issue_id !== undefined && event.issue_id !== "") {
        payload.issue_id = event.issue_id;
    }
    if (event.topic !== undefined && event.topic !== "") {
        payload.topic = event.topic;
    }
    if (event.actor !== undefined && event.actor !== "") {
        payload.actor = event.actor;
    }
    if (event.session !== undefined && event.session !== "") {
        payload.session = event.session;
    }
    if (event.payload !== undefined && event.payload !== "") {
        payload.detail = parseDetail(event.payload);
    }
    return payload;
}

/** arc carries its own payload as a JSON string; unparseable text stays text. */
function parseDetail(raw: string): JsonValue {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ) {
            return parsed as JsonObject;
        }
    } catch {
        return raw;
    }
    return raw;
}

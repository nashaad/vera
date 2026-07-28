import type { JsonObject, WatchFloodPolicy } from "../extensions/contributions.ts";

/**
 * The in-process shape of one source event line. It is the same schema a
 * subprocess source writes as NDJSON, so a connector and a subprocess produce
 * identical inbox entries and neither gets a privilege the other lacks.
 */
export interface SourceEvent {
    /** Source-scoped dedup key, stable across replays. Ordering is inbox seq. */
    readonly id: string;
    /** Dotted kind namespaced by source family. */
    readonly kind: string;
    /** RFC 3339 UTC, when the upstream thing happened. */
    readonly ts: string;
    /** Self-asserted, for the causality guard. Never empty. */
    readonly actor: string;
    /** `null` means no Vera session caused it, which is a filterable answer. */
    readonly session: string | null;
    /** Opaque resume token valid as of this event. */
    readonly cursor?: string;
    /** Inert. Stored and returned, never evaluated or interpolated. */
    readonly payload: JsonObject;
}

/** Advances the cursor with no entry appended, for a source that finds nothing. */
export interface SourceCheckpoint {
    readonly cursor: string;
}

/** Written when admission drops events, so a hole is visible rather than inferred. */
export const SOURCE_GAP_KIND = "source.gap";

export interface WatchRuntimeContext {
    /** Canonical `<extension-id>/<local-id>`. */
    readonly watchId: string;
    readonly sourceFamily: string;
    readonly config: JsonObject;
    readonly address: string | null;
    readonly flood: WatchFloodPolicy;
    /** Cancelled when the host stops or restarts the watch. */
    readonly signal: AbortSignal;
    /** The persisted resume token, `null` on a first-ever run. */
    cursor(): string | null;
    /** Admits events, then persists the cursor. Never the other way round. */
    admit(events: readonly SourceEvent[]): Promise<void>;
    /** Advances the cursor without appending anything. */
    checkpoint(checkpoint: SourceCheckpoint): void;
    /** Marks the connector as having run correctly, resetting backoff. */
    healthy(): void;
}

export interface WatchConnector {
    readonly sourceFamily: string;
    /**
     * Runs until the signal aborts. Returning is a clean stop; throwing is a
     * failure the supervisor backs off and retries.
     */
    run(context: WatchRuntimeContext): Promise<void>;
}

/**
 * A connector failure that no retry can fix. The supervisor quarantines
 * instead of backing off, matching the protocol's exit-code split.
 */
export class WatchFatalError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "WatchFatalError";
        this.code = code;
    }
}

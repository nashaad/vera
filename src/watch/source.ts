import type { JsonObject, WatchFloodPolicy } from "../extensions/contributions.ts";

export interface SourceEvent {
    readonly id: string;
    readonly kind: string;
    readonly ts: string;
    readonly actor: string;
    readonly session: string | null;
    readonly cursor?: string;
    readonly payload: JsonObject;
}

export interface SourceCheckpoint {
    readonly cursor: string;
}

export const SOURCE_GAP_KIND = "source.gap";

export interface WatchRuntimeContext {
    readonly watchId: string;
    readonly sourceFamily: string;
    readonly config: JsonObject;
    readonly address: string | null;
    readonly flood: WatchFloodPolicy;
    readonly signal: AbortSignal;
    cursor(): string | null;
    admit(events: readonly SourceEvent[]): Promise<void>;
    checkpoint(checkpoint: SourceCheckpoint): void;
    recordGap(reason: string, detail: Record<string, string | number>): void;
    healthy(): void;
}

export interface WatchConnector {
    readonly sourceFamily: string;
    run(context: WatchRuntimeContext): Promise<void>;
}

export class WatchFatalError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "WatchFatalError";
        this.code = code;
    }
}

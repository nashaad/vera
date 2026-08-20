/**
 * The client-safe context picture. It contains facts about one projected
 * request, never the request's content or any live engine object.
 */
export type VeraClientContextAvailability =
    | "available"
    | "partial"
    | "unavailable";

export interface VeraClientContextModel {
    readonly provider?: string;
    readonly model: string;
    readonly capacity?: number;
}

export interface VeraClientContextHeadline {
    readonly tokens: number;
    readonly estimated: boolean;
}

export type VeraClientContextComponentKind =
    | "prompt_contribution"
    | "tool_schema"
    | "message";

export interface VeraClientContextComponent {
    readonly kind: VeraClientContextComponentKind;
    readonly id: string;
    readonly owner: string;
    readonly source: string;
    readonly displayName: string;
    readonly count: number;
    readonly estimatedTokens: number;
}

export interface VeraClientContextProjection {
    readonly estimatedTokens: number;
    readonly components: readonly VeraClientContextComponent[];
}

export interface VeraClientContextCompaction {
    readonly triggerFraction?: number;
    readonly triggerTokens?: number;
}

export interface VeraClientContextSnapshot {
    readonly availability: VeraClientContextAvailability;
    readonly model?: VeraClientContextModel;
    readonly headline?: VeraClientContextHeadline;
    readonly projection?: VeraClientContextProjection;
    readonly compaction?: VeraClientContextCompaction;
}

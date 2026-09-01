
import type { AdmissionVerdict } from "./admission.ts";
import type { CatalogModel } from "./catalog-shape.ts";
import { EFFORT_LADDER } from "./effort-ladder.ts";
import { PROBE_LEARNED_KEY, effortLearnedKey } from "./pool-file.ts";

export const MODEL_FEED_SCHEMA_VERSION = 1;

export type FeedVerdict = "added" | "incompatible" | "unavailable";

export interface ModelFeedRow {
    readonly provider: string;
    readonly model: string;
    readonly verdict: FeedVerdict;
    readonly verified_levels: readonly string[];
    readonly provider_default_level?: string;
    readonly response_model?: string;
    readonly reason?: string;
    readonly verified_at: string;
}

export interface ModelFeed {
    readonly schema_version: typeof MODEL_FEED_SCHEMA_VERSION;
    readonly generated_at: string;
    readonly models: readonly ModelFeedRow[];
}

export interface FeedRowInput {
    readonly provider: string;
    readonly model: string;
    readonly verdict: AdmissionVerdict;
    readonly catalogModel?: CatalogModel;
    readonly verifiedAt: string;
}

export function feedRowForVerdict(input: FeedRowInput): ModelFeedRow {
    const base = {
        provider: input.provider,
        model: input.model,
        ...(input.catalogModel?.default_level === undefined
            ? {}
            : { provider_default_level: input.catalogModel.default_level }),
        verified_at: input.verifiedAt,
    };
    if (input.verdict.status !== "added") {
        return {
            ...base,
            verdict: input.verdict.status,
            verified_levels: [],
            reason: input.verdict.reason,
        };
    }
    const learned = input.verdict.learned;
    const verified = EFFORT_LADDER.flatMap((level) => {
        const fact = learned[effortLearnedKey(level)];
        return fact?.ok === true && fact.wire !== undefined
            ? [fact.wire]
            : [];
    });
    const responseModel = learned[PROBE_LEARNED_KEY]?.wire;
    return {
        ...base,
        verdict: "added",
        verified_levels: verified,
        ...(responseModel === undefined
            ? {}
            : { response_model: responseModel }),
    };
}

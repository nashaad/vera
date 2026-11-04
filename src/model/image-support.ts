
import type { EffectiveCatalogOptions } from "./catalog.ts";
import type { EffortPool } from "./effort-pool.ts";
import type { LearnedFact } from "./pool-file.ts";

/** A provider can put a newer model behind a stable id, so a refusal has to grow old and be retried. */
export const NEGATIVE_IMAGE_FACT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ImageSupportLookup {
    (model: string): boolean | undefined;
}

export interface PoolImageSupportOptions extends EffectiveCatalogOptions {
    readonly pool: EffortPool;
    readonly provider: string;
}

export interface ImageSupportSources {
    /** A boolean the pool file states outright. It is a decision, so it never ages out. */
    readonly declared?: boolean;
    readonly learned?: LearnedFact;
    readonly catalog?: boolean;
    readonly now?: Date;
}

/** Declared wins, then the learned fact until it goes stale, then the provider catalog. */
export function resolveImageSupportFromSources(
    sources: ImageSupportSources,
): boolean | undefined {
    if (sources.declared !== undefined) {
        return sources.declared;
    }
    const learned = sources.learned;
    if (learned?.ok === true) {
        return true;
    }
    if (learned !== undefined && !negativeFactIsStale(learned, sources.now)) {
        return false;
    }
    return sources.catalog;
}

function negativeFactIsStale(fact: LearnedFact, now: Date = new Date()): boolean {
    const seen = Date.parse(fact.seen);
    // An unreadable date must not keep a model blocked for good.
    if (Number.isNaN(seen)) {
        return true;
    }
    return now.getTime() - seen > NEGATIVE_IMAGE_FACT_MAX_AGE_MS;
}

export function poolImageSupport(
    options: PoolImageSupportOptions,
): ImageSupportLookup {
    return (model) => options.pool.resolveImageSupport({
        provider: options.provider,
        model,
    });
}

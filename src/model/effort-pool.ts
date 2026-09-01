
import { effectiveCatalog, type EffectiveCatalogOptions } from "./catalog.ts";
import type { CatalogModel } from "./catalog-shape.ts";
import {
    EFFORT_LADDER,
    type EffortMap,
    isEffortLevel,
} from "./effort-ladder.ts";
import { IMAGES_LEARNED_KEY, type LearnedFact } from "./pool-file.ts";
import {
    loadPoolFile,
    type LoadPoolFileOptions,
} from "./pool-file-loader.ts";
import {
    recordLearned as recordLearnedInFile,
    PoolFileWriteRefusedError,
    type PoolStoreOptions,
} from "./pool-file-store.ts";
import { lookupModel, resolveEffort } from "./pool-policy.ts";

export interface ModelRef {
    readonly provider: string;
    readonly model: string;
}

export interface ResolvedEffort {
    readonly requested: string;
    readonly providerEffort?: string;
    readonly efforts: EffortMap;
    readonly reason?: string;
}

export interface EffortPool {
    resolveEffort(ref: ModelRef, requested: string): ResolvedEffort;
    resolveImageSupport(ref: ModelRef): boolean | undefined;
    recordLearned(ref: ModelRef, key: string, fact: LearnedFact): void;
}

export function poolModelId(ref: ModelRef): string {
    return `${ref.provider}/${ref.model}`;
}

export function learnedFact(error: string, now: Date = new Date()): LearnedFact {
    return { ok: false, seen: now.toISOString().slice(0, 10), error };
}

export function learnedSupportedFact(now: Date = new Date()): LearnedFact {
    return { ok: true, seen: now.toISOString().slice(0, 10), checked: "user_key" };
}

export interface PoolEffortPoolOptions
    extends LoadPoolFileOptions, PoolStoreOptions, EffectiveCatalogOptions {
    /** Called instead of throwing when the pool file cannot be written back. A refused write must not fail the turn it happened in: the coarsening that produced the fact still. */
    readonly onWriteRefused?: (error: PoolFileWriteRefusedError) => void;
}

export function createPoolEffortPool(
    options: PoolEffortPoolOptions = {},
): EffortPool {
    return {
        resolveEffort(ref, requested) {
            const id = poolModelId(ref);
            const lookup = lookupModel(
                id,
                loadPoolFile(options).merged,
                providerCatalog(ref.provider, options),
            );
            const efforts: Record<string, string | null | undefined> = {};
            let reason: string | undefined;
            for (const level of EFFORT_LADDER) {
                const resolution = resolveEffort(level, lookup);
                if (resolution.status === "supported") {
                    efforts[level] = resolution.wire;
                    if (
                        level === requested
                        && resolution.contradiction !== undefined
                    ) {
                        reason = `the pool file declares effort "${level}" for`
                            + ` this model, but the provider rejected it:`
                            + ` ${resolution.contradiction}`;
                    }
                } else if (resolution.status === "forbidden") {
                    efforts[level] = null;
                    if (level === requested) {
                        reason = resolution.contradiction
                            ?? `the pool records effort "${level}" as`
                                + ` unsupported for this model`;
                    }
                }
            }
            const providerEffort = isEffortLevel(requested)
                ? efforts[requested]
                : undefined;
            return {
                requested,
                ...(typeof providerEffort === "string"
                    ? { providerEffort }
                    : {}),
                efforts,
                ...(reason === undefined ? {} : { reason }),
            };
        },
        resolveImageSupport(ref) {
            const lookup = lookupModel(
                poolModelId(ref),
                loadPoolFile(options).merged,
                providerCatalog(ref.provider, options),
            );
            if (typeof lookup.entry?.images === "boolean") {
                return lookup.entry.images;
            }
            const learned = lookup.entry?.learned?.[IMAGES_LEARNED_KEY];
            if (learned !== undefined) {
                return learned.ok;
            }
            return lookup.catalogModel?.image_support;
        },
        recordLearned(ref, key, fact) {
            try {
                recordLearnedInFile(poolModelId(ref), { [key]: fact }, options);
            } catch (error) {
                if (!(error instanceof PoolFileWriteRefusedError)) {
                    throw error;
                }
                options.onWriteRefused?.(error);
            }
        },
    };
}

function providerCatalog(
    provider: string,
    options: EffectiveCatalogOptions,
): ReadonlyMap<string, CatalogModel> {
    const models = new Map<string, CatalogModel>();
    for (const model of effectiveCatalog(provider, options).models) {
        models.set(`${provider}/${model.id}`, model);
    }
    return models;
}

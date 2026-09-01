/**
 * The narrow face request-time coarsening needs from the declarative pool.
 *
 * The engine asks two questions only: what does the resolved data say this
 * model's levels are, and here is a fact the provider just told us. The pool
 * file's schema, scopes, precedence and on-disk location stay on this side of
 * the interface, so the engine never opens a file or learns a well-known path.
 */

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
import { joinSettingsOverlay } from "./settings-overlay.ts";

export interface ModelRef {
    readonly provider: string;
    readonly model: string;
}

export interface ResolvedEffort {
    /** The level the caller asked for, unchanged. */
    readonly requested: string;
    /**
     * The exact string to put on the wire, or absent when the resolved data
     * has no wire string for the requested level. Absent means send no level,
     * never a substituted one.
     */
    readonly providerEffort?: string;
    /** The whole resolved map, which coarsening walks to find a neighbour. */
    readonly efforts: EffortMap;
    /**
     * Why the requested level cannot be sent, when it cannot. Carries the
     * provider's own wording when a learned rejection is what forbids it, so
     * a notice can quote the refusal the user's own account produced.
     */
    readonly reason?: string;
}

export interface EffortPool {
    /** Resolves declared over learned over catalog for one model. */
    resolveEffort(ref: ModelRef, requested: string): ResolvedEffort;
    /**
     * Whether the model takes image input, declared over learned over
     * catalog. Undefined when no source says either way, which is the only
     * case a caller may answer from somewhere else.
     */
    resolveImageSupport(ref: ModelRef): boolean | undefined;
    /** Records a fact under a dotted key such as `efforts.xhigh`. */
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
    /**
     * Called instead of throwing when the pool file cannot be written back.
     * A refused write must not fail the turn it happened in: the coarsening
     * that produced the fact still applies, only the record of it is lost.
     */
    readonly onWriteRefused?: (error: PoolFileWriteRefusedError) => void;
}

/**
 * Reads the pool file on every question rather than caching it: the file is a
 * user-editable document, and a host that cached it would keep sending a level
 * the user has just forbidden by hand.
 */
export function createPoolEffortPool(
    options: PoolEffortPoolOptions = {},
): EffortPool {
    return {
        resolveEffort(ref, requested) {
            const id = poolModelId(ref);
            const catalog = providerCatalog(ref.provider, options);
            const catalogModel = catalog.get(id);
            const overlay = joinSettingsOverlay({
                provider: ref.provider,
                listingId: ref.model,
                liveThinking: catalogModel?.thinking_support === true
                    || (catalogModel?.levels.length ?? 0) > 0,
                ...(options.overlay === undefined ? {} : { overlay: options.overlay }),
            });
            const lookup = lookupModel(
                id,
                loadPoolFile(options).merged,
                catalog,
                overlay,
            );
            const efforts: Record<string, string | null | undefined> = {};
            let reason: string | undefined;
            for (const level of EFFORT_LADDER) {
                const resolution = resolveEffort(level, lookup);
                if (resolution.status === "supported") {
                    efforts[level] = resolution.wire;
                    // A declared level that the provider has already rejected
                    // stays declared: the user's word is not rewritten. The
                    // standoff is what a notice has to say out loud, otherwise
                    // the same refusal repeats every turn with no explanation.
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

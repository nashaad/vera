/**
 * Reading the pool: what a model is allowed to be, and what it can do.
 *
 * Two questions, one precedence rule. Selection asks whether a model id passes
 * allow/deny, which every candidate anywhere passes first and where deny
 * always wins. Capability asks what a field's value is, answered by
 * declared > learned > catalog, field by field rather than record by record: a
 * declared context window does not suppress a learned effort rejection.
 *
 * Nothing here reaches a provider or writes the pool file.
 */

import type { CatalogModel } from "./catalog-shape.ts";
import { EFFORT_LADDER, type EffortLevel } from "./effort-ladder.ts";
import {
    type PoolFile,
    type PoolFileModel,
    effortLearnedKey,
    providerOf,
} from "./pool-file.ts";

export type CapabilitySource = "declared" | "learned" | "catalog";

export interface SelectionDecision {
    readonly allowed: boolean;
    /** The pattern that decided it, absent when nothing matched. */
    readonly pattern?: string;
    readonly rule?: "allow" | "deny";
}

/** How a level may be requested, and on whose word. */
export type EffortResolutionStatus =
    /** Send `wire` verbatim. */
    | "supported"
    /** The level must not be requested; coarsen to a neighbour. */
    | "forbidden"
    /** Nothing is known: send the request with no level named. */
    | "provider_default";

export interface EffortResolution {
    readonly level: EffortLevel;
    readonly status: EffortResolutionStatus;
    readonly wire?: string;
    readonly source?: CapabilitySource;
    /** Present when a learned fact contradicts the declared value. */
    readonly contradiction?: string;
}

export interface ResolvedCapability<T> {
    readonly value?: T;
    readonly source?: CapabilitySource;
}

export interface PoolLookup {
    readonly entry?: PoolFileModel;
    readonly catalogModel?: CatalogModel;
}

/**
 * Deny wins over allow, whatever the order or specificity of the patterns. An
 * absent allow list means everything is allowed; an empty one means nothing
 * is, which is the only way to write "deny by default" in the file.
 */
export function decideSelection(
    modelId: string,
    file: PoolFile,
): SelectionDecision {
    const deny = matchPattern(modelId, file.defaults.deny ?? []);
    if (deny !== undefined) {
        return { allowed: false, pattern: deny, rule: "deny" };
    }
    const allowPatterns = file.defaults.allow;
    if (allowPatterns === undefined) {
        return { allowed: true };
    }
    const allow = matchPattern(modelId, allowPatterns);
    return allow === undefined
        ? { allowed: false }
        : { allowed: true, pattern: allow, rule: "allow" };
}

export function isSelectable(modelId: string, file: PoolFile): boolean {
    return decideSelection(modelId, file).allowed;
}

/**
 * Glob matching over model ids. `*` matches any run of characters including
 * the provider separator, `?` matches one character, and everything else is
 * literal. That is what makes `openrouter/*:free` a usable rule.
 */
export function matchesPattern(modelId: string, pattern: string): boolean {
    return globToRegExp(pattern).test(modelId);
}

export function resolveTools(
    lookup: PoolLookup,
): ResolvedCapability<boolean> {
    const declared = lookup.entry?.tools;
    if (declared !== undefined) {
        return { value: declared, source: "declared" };
    }
    const learned = lookup.entry?.learned?.tools;
    if (learned !== undefined) {
        return { value: learned.ok, source: "learned" };
    }
    const catalog = lookup.catalogModel?.tool_support;
    return catalog === undefined
        ? {}
        : { value: catalog, source: "catalog" };
}

export function resolveContext(
    lookup: PoolLookup,
): ResolvedCapability<number> {
    const declared = lookup.entry?.context;
    if (declared !== undefined) {
        return { value: declared, source: "declared" };
    }
    const catalog = lookup.catalogModel?.context_window;
    return catalog === undefined
        ? {}
        : { value: catalog, source: "catalog" };
}

/**
 * Resolves one effort level for one model.
 *
 * A declared level wins, and a learned rejection of a declared level does not
 * overrule it: the contradiction rides along on the result so a caller can say
 * so instead of quietly editing the user's intent. A learned rejection with no
 * declaration behind it does forbid the level, since nothing else claims
 * otherwise.
 */
export function resolveEffort(
    level: EffortLevel,
    lookup: PoolLookup,
): EffortResolution {
    const learned = lookup.entry?.learned?.[effortLearnedKey(level)];
    const declaredEfforts = lookup.entry?.efforts;

    if (declaredEfforts !== undefined && level in declaredEfforts) {
        const declared = declaredEfforts[level];
        const contradiction = learned?.ok === false
            ? learned.error ?? "the provider rejected this level"
            : undefined;
        if (declared === null) {
            return {
                level,
                status: "forbidden",
                source: "declared",
                ...(contradiction === undefined ? {} : { contradiction }),
            };
        }
        return {
            level,
            status: "supported",
            wire: declared as string,
            source: "declared",
            ...(contradiction === undefined ? {} : { contradiction }),
        };
    }

    if (learned !== undefined) {
        if (!learned.ok) {
            return {
                level,
                status: "forbidden",
                source: "learned",
                ...(learned.error === undefined
                    ? {}
                    : { contradiction: learned.error }),
            };
        }
        return {
            level,
            status: "supported",
            wire: learned.wire ?? level,
            source: "learned",
        };
    }

    const catalogLevel = lookup.catalogModel?.levels.find(
        (candidate) => candidate.id === level,
    );
    if (catalogLevel !== undefined) {
        return {
            level,
            status: "supported",
            wire: catalogLevel.id,
            source: "catalog",
        };
    }

    return { level, status: "provider_default" };
}

/** Every ladder level this model may be asked for, weakest first. */
export function supportedEfforts(
    lookup: PoolLookup,
): readonly EffortResolution[] {
    return EFFORT_LADDER
        .map((level) => resolveEffort(level, lookup))
        .filter((resolution) => resolution.status === "supported");
}

/**
 * The pool entry and catalog record for one id, ready to resolve fields from.
 */
export function lookupModel(
    modelId: string,
    file: PoolFile,
    catalog?: ReadonlyMap<string, CatalogModel>,
): PoolLookup {
    const entry = file.models[modelId];
    const catalogModel = catalog?.get(modelId);
    return {
        ...(entry === undefined ? {} : { entry }),
        ...(catalogModel === undefined ? {} : { catalogModel }),
    };
}

/**
 * Declared fallback targets for a model, filtered to what selection allows.
 * Cross-provider references were already dropped at parse time; the provider
 * check here holds for entries built in memory rather than read from disk.
 */
export function resolveFallback(
    modelId: string,
    file: PoolFile,
): readonly string[] {
    const provider = providerOf(modelId);
    const fallback = file.models[modelId]?.fallback ?? [];
    return fallback.filter((reference) => (
        providerOf(reference) === provider && isSelectable(reference, file)
    ));
}

function matchPattern(
    modelId: string,
    patterns: readonly string[],
): string | undefined {
    return patterns.find((pattern) => matchesPattern(modelId, pattern));
}

const patternCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
    const cached = patternCache.get(pattern);
    if (cached !== undefined) {
        return cached;
    }
    const source = [...pattern].map((character) => {
        if (character === "*") return ".*";
        if (character === "?") return ".";
        return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }).join("");
    const expression = new RegExp(`^${source}$`);
    patternCache.set(pattern, expression);
    return expression;
}

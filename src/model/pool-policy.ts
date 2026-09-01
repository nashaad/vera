
import type { CatalogModel } from "./catalog-shape.ts";
import { EFFORT_LADDER, type EffortLevel } from "./effort-ladder.ts";
import {
    type PoolFile,
    type PoolFileModel,
    effortLearnedKey,
    providerOf,
} from "./pool-file.ts";
import type { OverlayModel } from "./settings-overlay.ts";

export type CapabilitySource = "declared" | "learned" | "catalog";

export interface SelectionDecision {
    readonly allowed: boolean;
    readonly pattern?: string;
    readonly rule?: "allow" | "deny";
}

export type EffortResolutionStatus =
    | "supported"
    /** The level must not be requested; coarsen to a neighbour. */
    | "forbidden"
    | "provider_default";

export interface EffortResolution {
    readonly level: EffortLevel;
    readonly status: EffortResolutionStatus;
    readonly wire?: string;
    readonly source?: CapabilitySource;
    readonly contradiction?: string;
}

export interface ResolvedCapability<T> {
    readonly value?: T;
    readonly source?: CapabilitySource;
}

export interface PoolLookup {
    readonly entry?: PoolFileModel;
    readonly catalogModel?: CatalogModel;
    readonly overlay?: OverlayModel;
}

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

    const overlayEfforts = lookup.overlay?.thinking.efforts;
    if (overlayEfforts !== undefined && level in overlayEfforts) {
        const mapped = overlayEfforts[level];
        if (mapped === null) {
            return { level, status: "forbidden", source: "catalog" };
        }
        if (typeof mapped === "string" && mapped.length > 0) {
            return {
                level,
                status: "supported",
                wire: mapped,
                source: "catalog",
            };
        }
    }

    const catalogLevel = lookup.catalogModel?.levels.find(
        (candidate) => candidate.id === level,
    );
    if (catalogLevel !== undefined) {
        return {
            level,
            status: "supported",
            wire: catalogLevel.wire ?? catalogLevel.id,
            source: "catalog",
        };
    }

    return { level, status: "provider_default" };
}

export function supportedEfforts(
    lookup: PoolLookup,
): readonly EffortResolution[] {
    return EFFORT_LADDER
        .map((level) => resolveEffort(level, lookup))
        .filter((resolution) => resolution.status === "supported");
}

export function lookupModel(
    modelId: string,
    file: PoolFile,
    catalog?: ReadonlyMap<string, CatalogModel>,
    overlay?: OverlayModel,
): PoolLookup {
    const entry = file.models[modelId];
    const catalogModel = catalog?.get(modelId);
    return {
        ...(entry === undefined ? {} : { entry }),
        ...(catalogModel === undefined ? {} : { catalogModel }),
        ...(overlay === undefined ? {} : { overlay }),
    };
}

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

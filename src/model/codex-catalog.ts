import { homedir } from "node:os";
import { join } from "node:path";

import { writeProviderCatalogSnapshot } from "./catalog-cache.ts";
import type {
    CatalogModel,
    ProviderCatalog,
    ReasoningLevel,
} from "./catalog-shape.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

const PROVIDER = "openai-codex";

export interface CodexCatalogRefreshOptions {
    /** The Codex cache to read. Defaults to `codexModelCachePath()`. */
    readonly cachePath?: string;
    /** Where the snapshot is written. Defaults to Vera's cache directory. */
    readonly cacheDir?: string;
}

/**
 * Codex keeps its model list here, refreshed by the Codex CLI itself. Vera
 * reads it rather than fetching its own copy: the file is already on disk for
 * anyone who has signed in, and a model list is not worth a startup request.
 */
export function codexModelCachePath(): string {
    return join(homedir(), ".codex", "models_cache.json");
}

/**
 * Reads the Codex cache and republishes it as a Vera discovery snapshot.
 * Returns the catalog so a caller can list the models in the same pass, and
 * `undefined` when there is nothing to publish: no cache, unreadable cache, or
 * a cache that yielded no models. None of those are errors. A user who has
 * never run Codex simply has no Codex models.
 */
export function refreshCodexCatalog(
    options: CodexCatalogRefreshOptions = {},
): ProviderCatalog | undefined {
    let raw: unknown;
    try {
        raw = JSON.parse(
            readRegularFileTextSync(
                options.cachePath ?? codexModelCachePath(),
            ),
        );
    } catch {
        return undefined;
    }

    const catalog = normalizeCodexModelCache(raw);
    if (catalog.models.length === 0) {
        return undefined;
    }

    try {
        writeProviderCatalogSnapshot(
            catalog,
            options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
        );
    } catch {
        // A snapshot Vera cannot write is not a reason to hide models it has
        // already read: the caller gets the catalog either way, and the next
        // start tries again.
    }
    return catalog;
}

export function normalizeCodexModelCache(raw: unknown): ProviderCatalog {
    try {
        if (!isRecord(raw) || !Array.isArray(raw.models)) {
            return emptyCatalog();
        }

        const models: CatalogModel[] = [];
        for (const value of raw.models) {
            const model = normalizeModel(value);
            if (model !== undefined) {
                models.push(model);
            }
        }

        return {
            schema_version: 2,
            provider: PROVIDER,
            ...(typeof raw.fetched_at === "string"
                ? { fetched_at: raw.fetched_at }
                : {}),
            models,
        };
    } catch {
        return emptyCatalog();
    }
}

function normalizeModel(value: unknown): CatalogModel | undefined {
    if (
        !isRecord(value)
        || typeof value.slug !== "string"
        || typeof value.display_name !== "string"
        || value.visibility === "hide"
    ) {
        return undefined;
    }

    return {
        id: value.slug,
        label: value.display_name,
        ...(typeof value.description === "string"
            ? { description: value.description }
            : {}),
        ...(typeof value.priority === "number"
            ? { order: value.priority }
            : {}),
        ...(typeof value.context_window === "number"
            ? { context_window: value.context_window }
            : {}),
        ...(typeof value.default_reasoning_level === "string"
            ? { default_level: value.default_reasoning_level }
            : {}),
        levels: normalizeLevels(value.supported_reasoning_levels),
    };
}

function normalizeLevels(value: unknown): ReasoningLevel[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const levels: ReasoningLevel[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.effort !== "string") {
            continue;
        }
        levels.push({
            id: entry.effort,
            label: reasoningLevelLabel(entry.effort),
            ...(typeof entry.description === "string"
                ? { description: entry.description }
                : {}),
        });
    }
    // Codex lists its levels weakest-first; the catalog stores them
    // strongest-first (see `CatalogModel.levels`). Reversing here is the whole
    // reason a consumer can treat "the next level up" as one step towards the
    // front without knowing which provider a model came from.
    return levels.reverse();
}

function reasoningLevelLabel(id: string): string {
    if (id === "xhigh") {
        return "Extra High";
    }
    return id
        .split(/[-_]/)
        .filter((part) => part.length > 0)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join(" ");
}

function emptyCatalog(): ProviderCatalog {
    return {
        schema_version: 2,
        provider: PROVIDER,
        models: [],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

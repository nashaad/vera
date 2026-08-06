import { randomUUID } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CatalogModel } from "./catalog-shape.ts";
import type { ModelReasoningEffort } from "./types.ts";

export interface PoolStoreOptions {
    readonly path?: string;
}

export interface VerifiedPoolLevel {
    readonly vera_effort: ModelReasoningEffort;
    readonly provider_effort: string;
}

/**
 * The admission record for a pool entry. `response_model` is whatever string
 * the provider returned for the probe, recorded verbatim: aggregator routes
 * legitimately alias and version model names, so it documents the routing
 * rather than gating on it. `checked` names who vouches: "vera" for centrally
 * tested seeds, "user_key" for the local admission probe.
 */
export interface PoolVerification {
    readonly verified_at: string;
    readonly response_model: string;
    readonly levels: readonly VerifiedPoolLevel[];
    readonly checked: "user_key" | "vera";
    readonly needs_reverify?: boolean;
}

export interface PoolEntry {
    readonly provider: string;
    readonly model: string;
    readonly verification?: PoolVerification;
}

export interface ReadyPoolEntry extends PoolEntry {
    readonly status: "ready";
    readonly verification: PoolVerification;
    readonly catalogModel?: CatalogModel;
}

export interface NeedsVerifyPoolEntry extends PoolEntry {
    readonly status: "needs_verify";
    readonly catalogModel?: CatalogModel;
}

export type PoolResolution = ReadyPoolEntry | NeedsVerifyPoolEntry;

export function defaultPoolPath(): string {
    return join(homedir(), ".vera", "config.json");
}

export function readPool(
    options: PoolStoreOptions = {},
): readonly PoolEntry[] {
    return poolFromConfig(readConfig(options.path ?? defaultPoolPath()));
}

export function addPoolEntry(
    entry: PoolEntry,
    options: PoolStoreOptions = {},
): readonly PoolEntry[] {
    const identifier = formatPoolIdentifier(entry);
    return writeUpdatedPool(options, (current) => [
        entry,
        ...current.filter(
            (value) => formatPoolIdentifier(value) !== identifier,
        ),
    ]);
}

export function removePoolEntry(
    entry: { readonly provider: string; readonly model: string },
    options: PoolStoreOptions = {},
): readonly PoolEntry[] {
    const identifier = formatPoolIdentifier(entry);
    return writeUpdatedPool(options, (current) =>
        current.filter(
            (value) => formatPoolIdentifier(value) !== identifier,
        ));
}

export function markPoolEntryNeedsReverify(
    entry: { readonly provider: string; readonly model: string },
    options: PoolStoreOptions = {},
): readonly PoolEntry[] {
    const identifier = formatPoolIdentifier(entry);
    return writeUpdatedPool(options, (current) => current.map((value) => {
        if (
            formatPoolIdentifier(value) !== identifier
            || value.verification === undefined
        ) {
            return value;
        }
        return {
            ...value,
            verification: { ...value.verification, needs_reverify: true },
        };
    }));
}

/**
 * A pool entry is ready only when it carries a verification record that has
 * not been flipped to needs-reverify. Everything else, including entries
 * migrated from the legacy pin list, must pass admission before it can be
 * selected.
 */
export function resolvePool(
    entries: readonly PoolEntry[],
    knownModels: ReadonlyMap<string, CatalogModel>,
): readonly PoolResolution[] {
    return entries.map((entry) => {
        const catalogModel = knownModels.get(formatPoolIdentifier(entry));
        if (
            entry.verification === undefined
            || entry.verification.needs_reverify === true
        ) {
            return {
                status: "needs_verify",
                ...entry,
                ...(catalogModel === undefined ? {} : { catalogModel }),
            };
        }
        return {
            status: "ready",
            ...entry,
            verification: entry.verification,
            ...(catalogModel === undefined ? {} : { catalogModel }),
        };
    });
}

export function formatPoolIdentifier(
    entry: { readonly provider: string; readonly model: string },
): string {
    return `${entry.provider}/${entry.model}`;
}

/**
 * Pool order is when each model was admitted, newest first, and using a model
 * does not move it. A list that reorders itself under the user is a list they
 * cannot aim at.
 */
function writeUpdatedPool(
    options: PoolStoreOptions,
    update: (current: readonly PoolEntry[]) => readonly PoolEntry[],
): readonly PoolEntry[] {
    const path = options.path ?? defaultPoolPath();
    const config = readConfig(path);
    const updated = update(poolFromConfig(config));
    const directory = dirname(path);
    const temporaryPath = join(directory, `.config-${randomUUID()}.tmp`);
    const { pinned: _legacy, ...rest } = config;

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
        temporaryPath,
        `${JSON.stringify({
            ...rest,
            pool: updated,
        }, null, 2)}\n`,
        { mode: 0o600 },
    );
    renameSync(temporaryPath, path);
    return updated;
}

/**
 * Legacy `pinned` identifiers migrate as entries with no verification record:
 * they were never probed, so they enter the pool as needs-verify rather than
 * being grandfathered in as runnable.
 */
function poolFromConfig(
    config: Record<string, unknown>,
): readonly PoolEntry[] {
    if (Array.isArray(config.pool)) {
        return config.pool.flatMap((value) => {
            const entry = parsePoolEntry(value);
            return entry === undefined ? [] : [entry];
        });
    }
    if (!Array.isArray(config.pinned)) {
        return [];
    }
    return config.pinned.flatMap((value) => {
        if (typeof value !== "string") {
            return [];
        }
        const entry = parseIdentifier(value);
        return entry === undefined ? [] : [entry];
    });
}

function parsePoolEntry(value: unknown): PoolEntry | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
        typeof record.provider !== "string"
        || record.provider.length === 0
        || typeof record.model !== "string"
        || record.model.length === 0
    ) {
        return undefined;
    }
    const verification = parseVerification(record.verification);
    return {
        provider: record.provider,
        model: record.model,
        ...(verification === undefined ? {} : { verification }),
    };
}

function parseVerification(value: unknown): PoolVerification | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
        typeof record.verified_at !== "string"
        || typeof record.response_model !== "string"
        || !Array.isArray(record.levels)
        || (record.checked !== "user_key" && record.checked !== "vera")
    ) {
        return undefined;
    }
    const levels = record.levels.flatMap((level) => {
        if (
            typeof level !== "object" || level === null || Array.isArray(level)
        ) {
            return [];
        }
        const item = level as Record<string, unknown>;
        return isReasoningEffort(item.vera_effort)
                && typeof item.provider_effort === "string"
            ? [{
                vera_effort: item.vera_effort,
                provider_effort: item.provider_effort,
            }]
            : [];
    });
    return {
        verified_at: record.verified_at,
        response_model: record.response_model,
        levels,
        checked: record.checked,
        ...(record.needs_reverify === true ? { needs_reverify: true } : {}),
    };
}

function isReasoningEffort(value: unknown): value is ModelReasoningEffort {
    return value === "off" || value === "low" || value === "medium"
        || value === "high" || value === "max";
}

function readConfig(path: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
    } catch {
        return {};
    }
    return {};
}

function parseIdentifier(
    identifier: string,
): PoolEntry | undefined {
    const separator = identifier.indexOf("/");
    if (separator <= 0 || separator === identifier.length - 1) {
        return undefined;
    }
    return {
        provider: identifier.slice(0, separator),
        model: identifier.slice(separator + 1),
    };
}

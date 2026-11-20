/**
 * What the daily catalog scan remembers about tracked models: when each was
 * last offered, how many authoritative scans in a row missed it, and whether
 * the drop was reported. Derived state, safe to delete.
 */

import { randomUUID } from "node:crypto";
import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { VeraConfig } from "../config.ts";
import {
    MODEL_ASSIGNMENT_IDS,
    isModelSlotId,
    resolveModelAssignment,
    type ModelAssignmentId,
} from "../config/model-assignments.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";
import {
    isCuratedPoolEntry,
    splitModelId,
    type PoolFile,
} from "./pool-file.ts";
import { isSelectable } from "./pool-policy.ts";

export const MODEL_AVAILABILITY_SCHEMA_VERSION = 1;

export const MAX_TRACKED_MODELS = 512;

export const MAX_MISSING_SCANS = 1_000;

export const MODEL_AVAILABILITY_RECORD_MAX_BYTES = 256 * 1_024;

const MAX_IDENTIFIER_LENGTH = 256;

const MAX_DATE_LENGTH = 64;

export type ModelAvailabilityRole = "favorite" | "default" | `assignment:${ModelAssignmentId}`;

export interface ModelAvailabilityEntry {
    readonly provider: string;
    readonly model: string;
    readonly roles: readonly ModelAvailabilityRole[];
    readonly last_seen_at?: string;
    readonly first_missing_at?: string;
    readonly missing_scans: number;
    readonly dropped_at?: string;
    readonly notified_at?: string;
}

export interface ModelAvailabilityRecord {
    readonly schema_version: 1;
    readonly last_scan_at?: string;
    readonly models: readonly ModelAvailabilityEntry[];
}

interface HeldDates {
    readonly last_seen_at?: string;
    readonly first_missing_at?: string;
    readonly missing_scans: number;
    readonly dropped_at?: string;
    readonly notified_at?: string;
}

export interface TrackedModel {
    readonly provider: string;
    readonly model: string;
    readonly roles: readonly ModelAvailabilityRole[];
}

export interface TrackedModelSet {
    readonly models: readonly TrackedModel[];
    /** Curated favorites left out because the tracked set was already full. */
    readonly droppedFavorites: number;
}

/** The models one provider answered with on an authoritative refresh. */
export interface CatalogListingFacts {
    readonly provider: string;
    /** Present only for a full, parsed, non-empty answer. */
    readonly listed?: readonly string[];
}

export interface ModelDropNotice {
    readonly provider: string;
    readonly model: string;
    readonly roles: readonly ModelAvailabilityRole[];
    readonly last_seen_at?: string;
    readonly first_missing_at?: string;
    readonly missing_scans: number;
}

export type ModelAvailabilityLog = (
    entry: { readonly type: string } & Record<string, unknown>,
) => unknown;

/**
 * The models a scan watches: curated favorites in the home pool, the default
 * model, and every model an assignment names. Pinned models are kept before
 * favorites when the set is capped.
 */
export function trackedModels(
    config: VeraConfig,
    pool: PoolFile,
    limit = MAX_TRACKED_MODELS,
): TrackedModelSet {
    const found = new Map<string, { provider: string; model: string; roles: Set<ModelAvailabilityRole> }>();
    const add = (role: ModelAvailabilityRole, provider: string, model: string): void => {
        if (provider.length === 0 || model.length === 0) return;
        const key = pairKey(provider, model);
        const existing = found.get(key);
        if (existing === undefined) {
            found.set(key, { provider, model, roles: new Set([role]) });
            return;
        }
        existing.roles.add(role);
    };

    add("default", config.provider, config.model);
    const assignments = config.model_assignments ?? {};
    const catalog = {
        models: config.models ?? [],
        model_routes: config.model_routes ?? {},
        reviewer_profiles: config.reviewer_profiles ?? {},
    };
    for (const slot of MODEL_ASSIGNMENT_IDS) {
        if (assignments[slot] === undefined) continue;
        const resolved = resolveModelAssignment(catalog, assignments, slot);
        for (const model of resolved?.models ?? []) {
            add(`assignment:${slot}`, model.provider, model.model);
        }
    }

    const pinned = found.size;
    let favoritesAdded = 0;
    let droppedFavorites = 0;
    for (const [id, entry] of Object.entries(pool.models)) {
        if (!isCuratedPoolEntry(entry) || !isSelectable(id, pool)) continue;
        const pair = splitModelId(id);
        if (pair === undefined) continue;
        const key = pairKey(pair.provider, pair.model);
        if (found.has(key)) {
            found.get(key)!.roles.add("favorite");
            continue;
        }
        if (pinned + favoritesAdded >= limit) {
            droppedFavorites += 1;
            continue;
        }
        favoritesAdded += 1;
        add("favorite", pair.provider, pair.model);
    }

    return {
        models: [...found.values()]
            .map((entry) => ({
                provider: entry.provider,
                model: entry.model,
                roles: sortedRoles(entry.roles),
            }))
            .sort(compareEntries),
        droppedFavorites,
    };
}

export function applyCatalogScan(
    previous: ModelAvailabilityRecord | undefined,
    tracked: readonly TrackedModel[],
    listings: readonly CatalogListingFacts[],
    scanAt: string,
    deliver: (notice: ModelDropNotice) => boolean,
): { readonly next: ModelAvailabilityRecord; readonly dropped: number } {
    const prior = new Map<string, ModelAvailabilityEntry>();
    for (const entry of previous?.models ?? []) {
        prior.set(pairKey(entry.provider, entry.model), entry);
    }
    const listedByProvider = new Map<string, ReadonlySet<string>>();
    for (const listing of listings) {
        if (listing.listed === undefined || listing.listed.length === 0) continue;
        listedByProvider.set(listing.provider, new Set(listing.listed));
    }

    const trackedByPair = new Map<string, { provider: string; model: string; roles: Set<ModelAvailabilityRole> }>();
    for (const entry of tracked) {
        const key = pairKey(entry.provider, entry.model);
        const merged = trackedByPair.get(key);
        if (merged === undefined) {
            trackedByPair.set(key, {
                provider: entry.provider,
                model: entry.model,
                roles: new Set(entry.roles),
            });
            continue;
        }
        for (const role of entry.roles) merged.roles.add(role);
    }

    let delivered = 0;
    const models: ModelAvailabilityEntry[] = [];
    for (const entry of trackedByPair.values()) {
        const roles = sortedRoles(entry.roles);
        const held = prior.get(pairKey(entry.provider, entry.model));
        const listed = listedByProvider.get(entry.provider);
        if (listed === undefined) {
            models.push({
                provider: entry.provider,
                model: entry.model,
                roles,
                ...datesOf(held),
            });
            continue;
        }
        if (listed.has(entry.model)) {
            models.push({
                provider: entry.provider,
                model: entry.model,
                roles,
                last_seen_at: scanAt,
                missing_scans: 0,
            });
            continue;
        }

        const missed = Math.min(MAX_MISSING_SCANS, (held?.missing_scans ?? 0) + 1);
        const firstMissing = (held?.missing_scans ?? 0) === 0
            ? scanAt
            : held?.first_missing_at ?? scanAt;
        const droppedAt = held?.dropped_at ?? (missed >= 2 ? scanAt : undefined);
        let notifiedAt = held?.notified_at;
        if (droppedAt !== undefined && notifiedAt === undefined && roles.some(isPinnedRole)) {
            const notice: ModelDropNotice = {
                provider: entry.provider,
                model: entry.model,
                roles,
                ...(held?.last_seen_at === undefined ? {} : { last_seen_at: held.last_seen_at }),
                first_missing_at: firstMissing,
                missing_scans: missed,
            };
            if (deliver(notice)) {
                notifiedAt = scanAt;
                delivered += 1;
            }
        }
        models.push({
            provider: entry.provider,
            model: entry.model,
            roles,
            ...(held?.last_seen_at === undefined ? {} : { last_seen_at: held.last_seen_at }),
            first_missing_at: firstMissing,
            missing_scans: missed,
            ...(droppedAt === undefined ? {} : { dropped_at: droppedAt }),
            ...(notifiedAt === undefined ? {} : { notified_at: notifiedAt }),
        });
    }

    return {
        next: {
            schema_version: MODEL_AVAILABILITY_SCHEMA_VERSION,
            last_scan_at: scanAt,
            models: models.sort(compareEntries),
        },
        dropped: delivered,
    };
}

export function isPinnedRole(role: ModelAvailabilityRole): boolean {
    return role === "default" || role.startsWith("assignment:");
}

export class ModelAvailabilityStore {
    constructor(
        private readonly path: string,
        private readonly log: ModelAvailabilityLog,
    ) {}

    read(): ModelAvailabilityRecord | undefined {
        let text: string;
        try {
            text = readRegularFileTextSync(this.path, MODEL_AVAILABILITY_RECORD_MAX_BYTES);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            this.log({ type: "model_availability_record_invalid", reason: messageOf(error) });
            return undefined;
        }
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            this.log({ type: "model_availability_record_invalid", reason: "invalid JSON" });
            return undefined;
        }
        const record = parseRecord(value);
        if (record === undefined) {
            this.log({ type: "model_availability_record_invalid", reason: "unexpected shape" });
            return undefined;
        }
        return record;
    }

    write(record: ModelAvailabilityRecord): boolean {
        const capped = capEntries(record.models);
        const payload: ModelAvailabilityRecord = {
            schema_version: MODEL_AVAILABILITY_SCHEMA_VERSION,
            ...(record.last_scan_at === undefined ? {} : { last_scan_at: record.last_scan_at }),
            models: capped.models,
        };
        const serialized = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
        if (serialized.length > MODEL_AVAILABILITY_RECORD_MAX_BYTES) {
            this.log({ type: "model_availability_record_failed", reason: "record is too large" });
            return false;
        }
        try {
            mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
            const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
            try {
                const file = openSync(temporary, "wx", 0o600);
                try {
                    writeFileSync(file, serialized);
                    fsyncSync(file);
                } finally {
                    closeSync(file);
                }
                renameSync(temporary, this.path);
            } finally {
                try {
                    unlinkSync(temporary);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            }
        } catch (error) {
            this.log({ type: "model_availability_record_failed", reason: messageOf(error) });
            return false;
        }
        if (capped.dropped > 0) {
            this.log({ type: "model_availability_over_cap", dropped: capped.dropped });
        }
        return true;
    }
}

function capEntries(
    models: readonly ModelAvailabilityEntry[],
): { readonly models: readonly ModelAvailabilityEntry[]; readonly dropped: number } {
    if (models.length <= MAX_TRACKED_MODELS) {
        return { models, dropped: 0 };
    }
    const pinned = models.filter((entry) => entry.roles.some(isPinnedRole));
    const rest = models.filter((entry) => !entry.roles.some(isPinnedRole));
    const kept = [...pinned, ...rest].slice(0, MAX_TRACKED_MODELS);
    return { models: kept, dropped: models.length - kept.length };
}

function parseRecord(value: unknown): ModelAvailabilityRecord | undefined {
    if (!isRecord(value) || value.schema_version !== MODEL_AVAILABILITY_SCHEMA_VERSION) {
        return undefined;
    }
    const lastScanAt = optionalDate(value.last_scan_at);
    if (lastScanAt === null) return undefined;
    if (!Array.isArray(value.models)) return undefined;
    const models: ModelAvailabilityEntry[] = [];
    const seen = new Set<string>();
    for (const item of value.models) {
        const entry = parseEntry(item);
        if (entry === undefined) return undefined;
        const key = pairKey(entry.provider, entry.model);
        if (seen.has(key)) continue;
        seen.add(key);
        models.push(entry);
    }
    return {
        schema_version: MODEL_AVAILABILITY_SCHEMA_VERSION,
        ...(lastScanAt === undefined ? {} : { last_scan_at: lastScanAt }),
        models,
    };
}

function parseEntry(value: unknown): ModelAvailabilityEntry | undefined {
    if (!isRecord(value)) return undefined;
    if (!isIdentifier(value.provider) || !isIdentifier(value.model)) return undefined;
    if (!Array.isArray(value.roles)) return undefined;
    const roles: ModelAvailabilityRole[] = [];
    for (const role of value.roles) {
        if (typeof role === "string" && isModelAvailabilityRole(role) && !roles.includes(role)) {
            roles.push(role);
        }
    }
    if (!Number.isSafeInteger(value.missing_scans)
        || (value.missing_scans as number) < 0
        || (value.missing_scans as number) > MAX_MISSING_SCANS) {
        return undefined;
    }
    const lastSeenAt = optionalDate(value.last_seen_at);
    const firstMissingAt = optionalDate(value.first_missing_at);
    const droppedAt = optionalDate(value.dropped_at);
    const notifiedAt = optionalDate(value.notified_at);
    if (lastSeenAt === null || firstMissingAt === null || droppedAt === null || notifiedAt === null) {
        return undefined;
    }
    return {
        provider: value.provider,
        model: value.model,
        roles: sortedRoles(roles),
        ...(lastSeenAt === undefined ? {} : { last_seen_at: lastSeenAt }),
        ...(firstMissingAt === undefined ? {} : { first_missing_at: firstMissingAt }),
        missing_scans: value.missing_scans as number,
        ...(droppedAt === undefined ? {} : { dropped_at: droppedAt }),
        ...(notifiedAt === undefined ? {} : { notified_at: notifiedAt }),
    };
}

export function isModelAvailabilityRole(value: string): value is ModelAvailabilityRole {
    if (value === "favorite" || value === "default") return true;
    return value.startsWith("assignment:") && isModelSlotId(value.slice("assignment:".length));
}

function datesOf(entry: ModelAvailabilityEntry | undefined): HeldDates {
    if (entry === undefined) return { missing_scans: 0 };
    return {
        ...(entry.last_seen_at === undefined ? {} : { last_seen_at: entry.last_seen_at }),
        ...(entry.first_missing_at === undefined ? {} : { first_missing_at: entry.first_missing_at }),
        missing_scans: entry.missing_scans,
        ...(entry.dropped_at === undefined ? {} : { dropped_at: entry.dropped_at }),
        ...(entry.notified_at === undefined ? {} : { notified_at: entry.notified_at }),
    };
}

function sortedRoles(roles: Iterable<ModelAvailabilityRole>): readonly ModelAvailabilityRole[] {
    return [...new Set(roles)].sort((left, right) => roleRank(left) - roleRank(right)
        || (left < right ? -1 : left > right ? 1 : 0));
}

function roleRank(role: ModelAvailabilityRole): number {
    if (role === "favorite") return 0;
    if (role === "default") return 1;
    return 2;
}

function compareEntries(
    left: { readonly provider: string; readonly model: string },
    right: { readonly provider: string; readonly model: string },
): number {
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
    if (left.model === right.model) return 0;
    return left.model < right.model ? -1 : 1;
}

function pairKey(provider: string, model: string): string {
    return `${provider}\u0000${model}`;
}

function isIdentifier(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && value.length <= MAX_IDENTIFIER_LENGTH;
}

function optionalDate(value: unknown): string | undefined | null {
    if (value === undefined) return undefined;
    return isDateText(value) ? value : null;
}

function isDateText(value: unknown): value is string {
    return typeof value === "string"
        && value.length <= MAX_DATE_LENGTH
        && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Host storage facts for the UI. The host module is the source of truth; this
// mirror keeps the renderer bundle from importing the host tree.

export const STORAGE_CAPABILITY = "storage.manage.v1";

export const STORAGE_AREAS = [
    "sessions",
    "scratch",
    "logs",
    "caches",
    "extensions",
    "browser",
    "other",
] as const;
export type StorageArea = (typeof STORAGE_AREAS)[number];

export const STORAGE_CLEANUP_AREAS = ["scratch", "logs", "old_scratch"] as const;
export type StorageCleanupArea = (typeof STORAGE_CLEANUP_AREAS)[number];

export interface StorageLargestItem {
    readonly name: string;
    readonly bytes: number;
}

export interface StorageCategoryMeasurement {
    readonly category: StorageArea | "old_scratch";
    readonly bytes: number;
    readonly items: number;
    readonly summary: string;
    readonly largest: readonly StorageLargestItem[];
}

export interface StorageMeasurement {
    readonly categories: readonly StorageCategoryMeasurement[];
    readonly total_bytes: number;
    readonly measured_at: string;
    readonly partial: boolean;
    readonly old_scratch: StorageCategoryMeasurement;
}

export interface StorageCleanupPreview {
    readonly area: StorageCleanupArea;
    readonly max_age_days: number;
    readonly count: number;
    readonly bytes: number;
    readonly names: readonly string[];
    readonly more: number;
    readonly partial: boolean;
}

export interface StorageCleanupResult {
    readonly area: StorageCleanupArea;
    readonly max_age_days: number;
    readonly removed: number;
    readonly removed_bytes: number;
}

export interface StorageFailure {
    readonly ok: false;
    readonly reason: string;
    readonly needsNewerHost?: true;
}

export type StorageMeasured =
    | { readonly ok: true; readonly measurement: StorageMeasurement }
    | StorageFailure;

export type StoragePreviewed =
    | { readonly ok: true; readonly preview: StorageCleanupPreview }
    | StorageFailure;

export type StorageCleaned =
    | { readonly ok: true; readonly result: StorageCleanupResult }
    | StorageFailure;

export function isStorageCleanupArea(value: unknown): value is StorageCleanupArea {
    return typeof value === "string"
        && (STORAGE_CLEANUP_AREAS as readonly string[]).includes(value);
}

export function isStorageAgeDays(value: unknown): value is number {
    return typeof value === "number"
        && Number.isInteger(value)
        && value >= 1
        && value <= 3650;
}

// Facts the desktop needs to show and clean up the home. Names are plain data;
// the client decides how each is formatted.

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
    // Files and symlinks visited; directories are not counted.
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

export interface StorageMeasureRequest {
    readonly type: "storage_measure";
    readonly refresh: boolean;
}

export interface StorageCleanupPreviewRequest {
    readonly type: "storage_cleanup_preview";
    readonly area: StorageCleanupArea;
    readonly max_age_days: number;
}

export interface StorageCleanupRequest {
    readonly type: "storage_cleanup";
    readonly area: StorageCleanupArea;
    readonly max_age_days: number;
}

export type StorageRequest =
    | StorageMeasureRequest
    | StorageCleanupPreviewRequest
    | StorageCleanupRequest;

export interface StorageMeasuredResponse {
    readonly type: "storage_measured";
    readonly measurement: StorageMeasurement;
}

export interface StorageCleanupPreviewedResponse {
    readonly type: "storage_cleanup_previewed";
    readonly preview: StorageCleanupPreview;
}

export interface StorageCleanedResponse {
    readonly type: "storage_cleaned";
    readonly result: StorageCleanupResult;
}

export interface StorageFailedResponse {
    readonly type: "storage_failed";
    readonly operation: "measure" | "preview" | "cleanup";
    readonly reason: string;
}

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

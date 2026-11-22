import { relativeTime } from "../../protocol/sessions.ts";
import type { StorageArea } from "../../protocol/storage.ts";

export interface StorageAreaRow {
    readonly area: StorageArea;
    readonly label: string;
    // A theme token, so the bar and legend follow the light and dark themes.
    readonly color: string;
}

export const STORAGE_AREA_ROWS: readonly StorageAreaRow[] = [
    { area: "sessions", label: "Sessions", color: "var(--vera-accent)" },
    { area: "scratch", label: "Scratch", color: "var(--vera-syntax-string)" },
    { area: "logs", label: "Logs", color: "var(--vera-syntax-number)" },
    { area: "caches", label: "Caches", color: "var(--vera-syntax-function)" },
    { area: "extensions", label: "Extensions", color: "var(--vera-syntax-keyword)" },
    { area: "browser", label: "Browser", color: "var(--vera-syntax-type)" },
    { area: "other", label: "Other", color: "var(--vera-text-dim)" },
];

export const OLD_SCRATCH_ROW: { readonly label: string; readonly color: string } = {
    label: "Old scratch",
    color: "var(--vera-text-disabled)",
};

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function storageSize(bytes: number): string {
    let value = Math.max(0, bytes);
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    if (unit === 0) return `${Math.round(value)} B`;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

// The measurement's timestamp is ISO text on the wire; a bad one reads as now.
export function checkedLabel(measuredAt: string, now: number): string {
    const time = Date.parse(measuredAt);
    return `Checked ${Number.isFinite(time) ? relativeTime(time, now) : "now"}`;
}

export function largestSize(items: readonly { readonly bytes: number }[]): number {
    return Math.max(0, ...items.map((item) => item.bytes));
}

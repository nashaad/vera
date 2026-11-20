/**
 * Schedules the daily catalog scan. The first run waits at least an hour after
 * start, and every later run waits a full interval after the previous one
 * finishes, so a restart never rescans immediately.
 */

import type { HostLog } from "./host-log.ts";

export const CATALOG_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export const CATALOG_SCAN_MIN_FIRST_DELAY_MS = 60 * 60 * 1_000;

export interface CatalogRefreshTimerOptions {
    readonly readLastScanAt: () => string | undefined;
    readonly scan: () => Promise<void>;
    readonly log?: HostLog;
    readonly now?: () => number;
    readonly minDelayMs?: number;
    readonly intervalMs?: number;
}

export interface CatalogRefreshTimer {
    close(): void;
}

export function firstCatalogScanDelay(
    lastScanAt: string | undefined,
    nowMs: number,
    options: { readonly minDelayMs?: number; readonly intervalMs?: number } = {},
): number {
    const intervalMs = options.intervalMs ?? CATALOG_SCAN_INTERVAL_MS;
    const minDelayMs = options.minDelayMs ?? CATALOG_SCAN_MIN_FIRST_DELAY_MS;
    const scannedAt = lastScanAt === undefined ? Number.NaN : Date.parse(lastScanAt);
    const target = Number.isNaN(scannedAt) ? intervalMs : scannedAt + intervalMs - nowMs;
    return Math.min(intervalMs, Math.max(minDelayMs, target));
}

export function startCatalogRefreshTimer(
    options: CatalogRefreshTimerOptions,
): CatalogRefreshTimer {
    const now = options.now ?? Date.now;
    const intervalMs = options.intervalMs ?? CATALOG_SCAN_INTERVAL_MS;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delayMs: number): void => {
        if (closed) return;
        timer = setTimeout(run, delayMs);
        timer.unref?.();
    };

    const run = (): void => {
        timer = undefined;
        void options.scan()
            .catch((error: unknown) => {
                options.log?.({
                    type: "model_catalog_scan_failed",
                    reason: error instanceof Error ? error.message : String(error),
                });
            })
            .finally(() => {
                if (!closed) schedule(intervalMs);
            });
    };

    let lastScanAt: string | undefined;
    try {
        lastScanAt = options.readLastScanAt();
    } catch {
        lastScanAt = undefined;
    }
    schedule(firstCatalogScanDelay(lastScanAt, now(), options));

    return {
        close: () => {
            closed = true;
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
        },
    };
}

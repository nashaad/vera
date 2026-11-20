import { afterEach, expect, jest, test } from "bun:test";

import {
    CATALOG_SCAN_INTERVAL_MS,
    CATALOG_SCAN_MIN_FIRST_DELAY_MS,
    firstCatalogScanDelay,
    startCatalogRefreshTimer,
} from "../../src/host/catalog-refresh-timer.ts";

const NOW = Date.parse("2026-11-20T15:00:00.000Z");

function ago(ms: number): string {
    return new Date(NOW - ms).toISOString();
}

async function flush(): Promise<void> {
    for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
    }
}

afterEach(() => {
    jest.useRealTimers();
});

test("the first delay is a full interval without a usable record", () => {
    expect(firstCatalogScanDelay(undefined, NOW)).toBe(CATALOG_SCAN_INTERVAL_MS);
    expect(firstCatalogScanDelay("not a date", NOW)).toBe(CATALOG_SCAN_INTERVAL_MS);
});

test("the first delay fills out the day since the last scan", () => {
    expect(firstCatalogScanDelay(ago(23 * 60 * 60 * 1_000), NOW)).toBe(60 * 60 * 1_000);
    expect(firstCatalogScanDelay(ago(60 * 60 * 1_000), NOW)).toBe(23 * 60 * 60 * 1_000);
});

test("the first delay never drops below an hour or above a day", () => {
    expect(firstCatalogScanDelay(ago(48 * 60 * 60 * 1_000), NOW)).toBe(CATALOG_SCAN_MIN_FIRST_DELAY_MS);
    expect(firstCatalogScanDelay(ago(-48 * 60 * 60 * 1_000), NOW)).toBe(CATALOG_SCAN_INTERVAL_MS);
});

test("nothing scans synchronously, then one interval later it does", async () => {
    jest.useFakeTimers();
    let scans = 0;
    const timer = startCatalogRefreshTimer({
        readLastScanAt: () => undefined,
        scan: async () => {
            scans += 1;
        },
        intervalMs: 5_000,
    });
    try {
        expect(scans).toBe(0);
        jest.advanceTimersByTime(4_999);
        await flush();
        expect(scans).toBe(0);
        jest.advanceTimersByTime(1);
        await flush();
        expect(scans).toBe(1);
    } finally {
        timer.close();
    }
});

test("a record from most of a day ago scans an hour after start", async () => {
    jest.useFakeTimers();
    let scans = 0;
    const timer = startCatalogRefreshTimer({
        readLastScanAt: () => ago(23 * 60 * 60 * 1_000),
        scan: async () => {
            scans += 1;
        },
        now: () => NOW,
        intervalMs: CATALOG_SCAN_INTERVAL_MS,
    });
    try {
        jest.advanceTimersByTime(CATALOG_SCAN_MIN_FIRST_DELAY_MS - 1);
        await flush();
        expect(scans).toBe(0);
        jest.advanceTimersByTime(1);
        await flush();
        expect(scans).toBe(1);
    } finally {
        timer.close();
    }
});

test("the next scan waits a full interval after the last one finishes", async () => {
    jest.useFakeTimers();
    let scans = 0;
    let release: (() => void) | undefined;
    const timer = startCatalogRefreshTimer({
        readLastScanAt: () => undefined,
        scan: () => {
            scans += 1;
            return new Promise<void>((resolve) => {
                release = resolve;
            });
        },
        intervalMs: 5_000,
    });
    try {
        jest.advanceTimersByTime(5_000);
        await flush();
        expect(scans).toBe(1);
        jest.advanceTimersByTime(60_000);
        await flush();
        expect(scans).toBe(1);
        release?.();
        await flush();
        jest.advanceTimersByTime(4_999);
        await flush();
        expect(scans).toBe(1);
        jest.advanceTimersByTime(1);
        await flush();
        expect(scans).toBe(2);
    } finally {
        timer.close();
    }
});

test("close stops the next scan", async () => {
    jest.useFakeTimers();
    let scans = 0;
    const timer = startCatalogRefreshTimer({
        readLastScanAt: () => undefined,
        scan: async () => {
            scans += 1;
        },
        intervalMs: 5_000,
    });
    timer.close();
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(scans).toBe(0);
});

test("a scan that rejects is logged and rescheduled", async () => {
    jest.useFakeTimers();
    let attempts = 0;
    const logged: Array<{ readonly type: string } & Record<string, unknown>> = [];
    const timer = startCatalogRefreshTimer({
        readLastScanAt: () => undefined,
        scan: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("provider fetch failed");
        },
        log: (entry) => {
            logged.push(entry);
            return true;
        },
        intervalMs: 5_000,
    });
    try {
        jest.advanceTimersByTime(5_000);
        await flush();
        expect(attempts).toBe(1);
        expect(logged).toEqual([{ type: "model_catalog_scan_failed", reason: "provider fetch failed" }]);
        jest.advanceTimersByTime(5_000);
        await flush();
        expect(attempts).toBe(2);
    } finally {
        timer.close();
    }
});

test("a record that cannot be read falls back to a full interval", async () => {
    jest.useFakeTimers();
    let scans = 0;
    const timer = startCatalogRefreshTimer({
        readLastScanAt: () => {
            throw new Error("record unreadable");
        },
        scan: async () => {
            scans += 1;
        },
        intervalMs: 5_000,
    });
    try {
        jest.advanceTimersByTime(4_999);
        await flush();
        expect(scans).toBe(0);
        jest.advanceTimersByTime(1);
        await flush();
        expect(scans).toBe(1);
    } finally {
        timer.close();
    }
});

test("the scheduled timer does not hold the process open", () => {
    const original = globalThis.setTimeout;
    const handles: Array<{ unref?: () => void }> = [];
    let unrefs = 0;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((callback: () => void, ms?: number) => {
        const handle = original(callback, ms);
        const unref = handle.unref;
        handle.unref = () => {
            unrefs += 1;
            return unref?.call(handle) ?? handle;
        };
        handles.push(handle);
        return handle;
    }) as typeof setTimeout;
    try {
        const timer = startCatalogRefreshTimer({
            readLastScanAt: () => undefined,
            scan: async () => {},
        });
        expect(handles).toHaveLength(1);
        expect(unrefs).toBe(1);
        timer.close();
    } finally {
        (globalThis as { setTimeout: typeof setTimeout }).setTimeout = original;
    }
});

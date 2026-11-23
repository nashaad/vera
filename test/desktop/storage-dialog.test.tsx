import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CleanupBody } from "../../clients/ui/src/pages/settings/FreeUpSpaceDialog.tsx";
import { loadStorage, StorageBody } from "../../clients/ui/src/pages/settings/StorageDialog.tsx";
import type {
    StorageCleanupPreview,
    StorageMeasurement,
} from "../../clients/ui/src/protocol/storage.ts";

const MEASUREMENT: StorageMeasurement = {
    categories: [
        { category: "sessions", bytes: 4096, items: 3, summary: "2 sessions and 1 database", largest: [{ name: "Plan the launch", bytes: 3000 }] },
        { category: "scratch", bytes: 2048, items: 4, summary: "2 session folders", largest: [{ name: "Old work", bytes: 1500 }] },
        { category: "logs", bytes: 1024, items: 2, summary: "2 log files", largest: [{ name: "workspace/a.jsonl", bytes: 900 }] },
        { category: "caches", bytes: 512, items: 1, summary: "1 cache file", largest: [{ name: "cache.bin", bytes: 512 }] },
        { category: "extensions", bytes: 256, items: 2, summary: "2 files", largest: [{ name: "skills/one", bytes: 200 }] },
        { category: "browser", bytes: 128, items: 1, summary: "1 browser data file", largest: [{ name: "chromium/Default", bytes: 128 }] },
        { category: "other", bytes: 64, items: 1, summary: "1 other file", largest: [{ name: "notes.txt", bytes: 64 }] },
    ],
    total_bytes: 8128,
    measured_at: "2026-11-22T12:00:00.000Z",
    partial: false,
    old_scratch: {
        category: "old_scratch",
        bytes: 32,
        items: 1,
        summary: "1 temporary session folder",
        largest: [{ name: "Left behind", bytes: 32 }],
    },
};

const PREVIEW: StorageCleanupPreview = {
    area: "scratch",
    max_age_days: 7,
    count: 2,
    bytes: 2048,
    names: ["Old work", "Another one"],
    more: 3,
    partial: false,
};

describe("the Storage dialog", () => {
    test("@core the bar, legend and one row per category render with sizes and largest items", () => {
        const html = renderToStaticMarkup(createElement(StorageBody, {
            measurement: MEASUREMENT,
            measuring: false,
            failure: undefined,
            onRefresh: () => undefined,
            onOpenFolder: () => undefined,
            onFree: () => undefined,
        }));
        expect(html).toContain('aria-label="Space used by category"');
        expect(html.match(/storage-bar-part/g) ?? []).toHaveLength(7);
        for (const label of ["Sessions", "Scratch", "Logs", "Caches", "Extensions", "Browser", "Other"]) {
            expect(html).toContain(`>${label}</div>`);
        }
        expect(html).toContain("Disk space used");
        expect(html).toContain("7.9 KB");
        expect(html).toContain("Plan the launch");
        expect(html).toContain("2 session folders");
        expect(html).toContain("Old scratch");
        expect(html).toContain("Outside the home");
        expect(html.match(/Free up space…/g) ?? []).toHaveLength(3);
        expect(html).toContain(">Refresh</button>");
        expect(html).toContain(">Open folder</button>");
    });

    test("a partial scan says at least, and measuring disables Refresh", () => {
        const html = renderToStaticMarkup(createElement(StorageBody, {
            measurement: { ...MEASUREMENT, partial: true },
            measuring: true,
            failure: undefined,
            onRefresh: () => undefined,
            onOpenFolder: () => undefined,
            onFree: () => undefined,
        }));
        expect(html).toContain("at least");
        expect(html).toContain("measuring again…");
        expect(html).toContain("disabled");
    });

    test("@core Refresh asks the host for a new scan and replaces the measurement", async () => {
        const calls: boolean[] = [];
        const measure = async (refresh: boolean) => {
            calls.push(refresh);
            return { ok: true as const, measurement: MEASUREMENT };
        };
        expect(await loadStorage(measure, true)).toEqual({ kind: "ready", measurement: MEASUREMENT });
        expect(await loadStorage(measure, false)).toEqual({ kind: "ready", measurement: MEASUREMENT });
        expect(calls).toEqual([true, false]);
        expect(await loadStorage(async () => ({ ok: false, reason: "The home could not be measured." }), true))
            .toEqual({ kind: "failed", reason: "The home could not be measured." });
    });
});

describe("the Free up space dialog", () => {
    function cleanup(acknowledged: boolean, preview: StorageCleanupPreview | undefined = PREVIEW): string {
        return renderToStaticMarkup(createElement(CleanupBody, {
            area: "scratch",
            age: "7",
            preview,
            acknowledged,
            busy: false,
            failure: undefined,
            onAgeChange: () => undefined,
            onAcknowledgedChange: () => undefined,
            onDelete: () => undefined,
            onClose: () => undefined,
        }));
    }

    test("@core Delete stays disabled until the confirmation box is checked", () => {
        expect(cleanup(false)).toContain('class="storage-delete-btn" disabled=""');
        expect(cleanup(true)).not.toContain('class="storage-delete-btn" disabled=""');
        expect(cleanup(true)).toContain("2 folders");
        expect(cleanup(true)).toContain("Old work");
        expect(cleanup(true)).toContain("and 3 more");
        expect(cleanup(true)).toContain("I understand this can&#x27;t be undone");
        expect(cleanup(true)).toContain(">Delete 2 folders</button>");
    });

    test("@core nothing is deleted when the preview is empty or the dialog is busy", () => {
        expect(cleanup(true, { ...PREVIEW, count: 0, bytes: 0, names: [], more: 0 }))
            .toContain("Nothing older than 7 days.");
        expect(cleanup(true, { ...PREVIEW, count: 0, bytes: 0, names: [], more: 0 }))
            .toContain('class="storage-delete-btn" disabled=""');
        expect(renderToStaticMarkup(createElement(CleanupBody, {
            area: "logs",
            age: "1",
            preview: { ...PREVIEW, area: "logs" },
            acknowledged: true,
            busy: true,
            failure: undefined,
            onAgeChange: () => undefined,
            onAcknowledgedChange: () => undefined,
            onDelete: () => undefined,
            onClose: () => undefined,
        }))).toContain('class="storage-delete-btn" disabled=""');
    });

    test("the Delete button names the files it would remove", () => {
        const html = renderToStaticMarkup(createElement(CleanupBody, {
            area: "logs",
            age: "7",
            preview: { ...PREVIEW, area: "logs", count: 1, names: ["workspace/a.jsonl"], more: 0 },
            acknowledged: true,
            busy: false,
            failure: undefined,
            onAgeChange: () => undefined,
            onAcknowledgedChange: () => undefined,
            onDelete: () => undefined,
            onClose: () => undefined,
        }));
        expect(html).toContain(">Delete 1 file</button>");
    });
});

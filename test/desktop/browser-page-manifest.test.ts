import { describe, expect, test } from "bun:test";

import { MAX_PAGE_PATH_LENGTH, parseDesktopManifest } from "../../clients/ui/src/extensions/manifest.ts";
import { parsePageResult } from "../../clients/desktop/src/extension-commands/page-result.ts";

function manifest(page: unknown = "page.js", icon: unknown = "pointer") {
    return {
        id: "test.page", version: "1", engine: "vera-gui@^1",
        contributes: {
            commands: [{ command: "test.page.select", title: "Select element", page }],
            menus: { browser: [{ command: "test.page.select", icon }] },
        },
    };
}

describe("browser page manifests", () => {
    test("@core accepts a page-only command and a browser pointer entry", () => {
        const result = parseDesktopManifest(manifest());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.manifest.commands[0]?.page).toBe("page.js");
        expect(result.manifest.menus.browser[0]?.icon).toBe("pointer");
    });
    test("refuses paths outside the extension and oversized paths", () => {
        for (const path of ["../page.js", "/page.js", "C:\\page.js", "nested/../page.js", "", "page\0.js", " page.js ", "a".repeat(MAX_PAGE_PATH_LENGTH + 1), 42]) {
            expect(parseDesktopManifest(manifest(path)).ok).toBe(false);
        }
    });
    test("refuses unknown or missing icons and icons outside browser", () => {
        for (const icon of ["arrow", "", null, 42]) expect(parseDesktopManifest(manifest("page.js", icon)).ok).toBe(false);
        const value = manifest();
        delete (value.contributes.menus.browser[0] as { icon?: unknown }).icon;
        expect(parseDesktopManifest(value).ok).toBe(false);
        const other = manifest();
        Object.assign(other.contributes.menus, { theme: other.contributes.menus.browser });
        expect(parseDesktopManifest(other).ok).toBe(false);
    });
    test("refuses page combined with file or task, unknown places, excess entries", () => {
        for (const extra of [{ file: { label: "Files", extensions: ["txt"] } }, { task: "work" }]) {
            const value = manifest();
            Object.assign(value.contributes.commands[0]!, extra);
            expect(parseDesktopManifest(value).ok).toBe(false);
        }
        const value = manifest();
        Object.assign(value.contributes.menus, { unknown: [] });
        expect(parseDesktopManifest(value).ok).toBe(false);
        const many = manifest();
        many.contributes.menus.browser = Array.from({ length: 9 }, () => many.contributes.menus.browser[0]!);
        expect(parseDesktopManifest(many).ok).toBe(false);
    });
});

test("page results survive transport and reject malformed or oversized data", () => {
    const result = { rect: { x: 2, y: 3, width: 100, height: 40 }, text: "Selected in the Browser tab on https://example.test" };
    expect(parsePageResult(structuredClone(result))).toEqual(result);
    expect(parsePageResult({ ...result, rect: { ...result.rect, extra: "ignored" }, extra: "ignored" })).toEqual(result);
    expect(parsePageResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    for (const rect of [{ ...result.rect, x: NaN }, { ...result.rect, width: 0 }, { ...result.rect, height: 10001 }]) {
        expect(parsePageResult({ ...result, rect })).toBeUndefined();
    }
    expect(parsePageResult({ ...result, text: "x".repeat(16385) })).toBeUndefined();
    expect(parsePageResult({ ...result, details: {} })).toBeUndefined();
});

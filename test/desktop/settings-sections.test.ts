import { describe, expect, test } from "bun:test";

import { filterSettings } from "../../clients/ui/src/pages/settings/filter.ts";

const sections = [
    { id: "approvals", name: "Approvals", terms: "permission approve deny allow mode grant always" },
    { id: "appearance", name: "Appearance", terms: "theme font density" },
    { id: "providers", name: "Providers", terms: "model provider api key" },
];

describe("filterSettings", () => {
    test("an empty or blank query keeps every section in order", () => {
        expect(filterSettings(sections, "").map((section) => section.id)).toEqual(["approvals", "appearance", "providers"]);
        expect(filterSettings(sections, "   ").map((section) => section.id)).toEqual(["approvals", "appearance", "providers"]);
    });

    test("matches the section name, ignoring case", () => {
        expect(filterSettings(sections, "APPEAR").map((section) => section.id)).toEqual(["appearance"]);
    });

    test("matches keyword terms", () => {
        expect(filterSettings(sections, "api").map((section) => section.id)).toEqual(["providers"]);
        expect(filterSettings(sections, "theme").map((section) => section.id)).toEqual(["appearance"]);
    });

    test("every word must match, in any order", () => {
        expect(filterSettings(sections, "mode permission").map((section) => section.id)).toEqual(["approvals"]);
        expect(filterSettings(sections, "permission theme")).toEqual([]);
    });

    test("a query no section matches returns nothing", () => {
        expect(filterSettings(sections, "zzz")).toEqual([]);
    });
});

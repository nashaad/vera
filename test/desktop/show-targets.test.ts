import { expect, test } from "bun:test";

import { OVERLAY_COMMANDS } from "../../clients/ui/src/commands/overlay-ids.ts";
import { SETTINGS_SECTIONS } from "../../clients/ui/src/pages/settings/sections.ts";
import { pageCards } from "../../clients/ui/src/pages/tour.ts";
import { SHOW_TARGETS, findShowTarget, surfaceCanShow } from "../../src/help/show-targets.ts";

test("@core every window dialog is a show target with the window's own name", () => {
    for (const [key, entry] of Object.entries(OVERLAY_COMMANDS)) {
        expect(findShowTarget(`dialog.${key}`)?.label).toBe(entry.title);
    }
    expect(SHOW_TARGETS.filter((target) => target.kind === "dialog")).toHaveLength(Object.keys(OVERLAY_COMMANDS).length);
});

test("@core every settings section is a show target with the section's name", () => {
    for (const section of SETTINGS_SECTIONS) {
        expect(findShowTarget(`settings.${section.id}`)?.label).toBe(section.name);
    }
    expect(SHOW_TARGETS.filter((target) => target.kind === "settings")).toHaveLength(SETTINGS_SECTIONS.length);
});

test("@core every Tour page that opens without a folder is a show target", () => {
    const cards = pageCards("/work/crow").filter((card) => card.id !== "workspace");
    for (const card of cards) {
        expect(findShowTarget(`page.${card.id}`)?.label).toBe(card.name);
    }
    expect(SHOW_TARGETS.filter((target) => target.kind === "page")).toHaveLength(cards.length);
});

test("@core target ids are unique and the lookup refuses anything else", () => {
    const ids = SHOW_TARGETS.map((target) => target.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findShowTarget("dialog.pirate-map")).toBeUndefined();
    expect(findShowTarget(undefined)).toBeUndefined();
    expect(findShowTarget("toString")).toBeUndefined();
});

test("@core the window shows every target and the terminal only the ones it has a screen for", () => {
    const feedback = findShowTarget("dialog.feedback")!;
    const themes = findShowTarget("dialog.themes")!;
    expect(surfaceCanShow("window", feedback)).toBe(true);
    expect(surfaceCanShow("terminal", feedback)).toBe(false);
    expect(surfaceCanShow("terminal", themes)).toBe(true);
});

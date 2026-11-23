import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SidebarSettingsStore, sidebarSettingsPath } from "../../clients/desktop/src/sidebar-settings-store.ts";
import { DEFAULT_SIDEBAR_SETTINGS, parseSidebarSettings } from "../../clients/ui/src/protocol/sidebarSettings.ts";

function store(): { readonly path: string; readonly value: SidebarSettingsStore } {
    const home = mkdtempSync(join(tmpdir(), "vera-sidebar-settings-"));
    const path = sidebarSettingsPath(home);
    mkdirSync(join(home, "machine", "desktop"), { recursive: true });
    return { path, value: new SidebarSettingsStore(path) };
}

test("@core sidebar settings live beside pins and the layout", () => {
    expect(sidebarSettingsPath("/home/crow")).toBe("/home/crow/machine/desktop/sidebar.json");
});

test("@core Group by survives a save and a fresh store", () => {
    const { path, value } = store();
    expect(value.load()).toBeUndefined();
    expect(value.save({ groupBy: "folder" })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('{"groupBy":"folder"}\n');
    expect(new SidebarSettingsStore(path).load()).toEqual({ groupBy: "folder" });
    expect(DEFAULT_SIDEBAR_SETTINGS).toEqual({ groupBy: "none" });
});

test("@core a damaged or unknown settings file reads as the default, not a guess", () => {
    const { path, value } = store();
    writeFileSync(path, "{ not json", "utf8");
    expect(value.load()).toBeUndefined();
    expect(readFileSync(`${path}.bad`, "utf8")).toBe("{ not json");
    writeFileSync(path, '{"groupBy":"workspace"}', "utf8");
    expect(value.load()).toBeUndefined();
    expect(parseSidebarSettings({ groupBy: "none" })).toEqual({ groupBy: "none" });
    expect(parseSidebarSettings({ groupBy: "folder" })).toEqual({ groupBy: "folder" });
    expect(parseSidebarSettings({ groupBy: "workspace" })).toBeUndefined();
    expect(parseSidebarSettings([])).toBeUndefined();
});

test("a save of the wrong shape leaves the file alone", () => {
    const { path, value } = store();
    expect(value.save({ groupBy: "folder" })).toBe(true);
    expect(value.save({ groupBy: "workspace" })).toBe(false);
    expect(value.load()).toEqual({ groupBy: "folder" });
});

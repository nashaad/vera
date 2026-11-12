import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_DESKTOP_FLAGS, flagsPath, readFlags } from "../../clients/desktop/src/desktop-flags.ts";
import { parseFlags } from "../../clients/ui/src/state/desktopFlags.ts";

const homes: string[] = [];

function trialHome(): string {
    const home = mkdtempSync(join(tmpdir(), "vera-desktop-flags-"));
    homes.push(home);
    return home;
}

afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function writeFlags(home: string, text: string): string {
    const path = flagsPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
}

test("@core reasoning is hidden until the flags file turns it on with a boolean true", () => {
    expect(DEFAULT_DESKTOP_FLAGS.showReasoning).toBe(false);
    expect(parseFlags({ showReasoning: true }).showReasoning).toBe(true);
    for (const value of [false, "true", 1, null, undefined]) expect(parseFlags({ showReasoning: value }).showReasoning).toBe(false);
    for (const value of [null, "flags", 3, []]) expect(parseFlags(value)).toEqual(DEFAULT_DESKTOP_FLAGS);
});

test("the flags file lives in the desktop's own folder under the home", () => {
    expect(flagsPath("/crow/home")).toBe(join("/crow/home", "machine", "desktop", "flags.json"));
});

test("a missing, unreadable or oversized flags file leaves every flag at its default", () => {
    const home = trialHome();
    expect(readFlags(flagsPath(home))).toEqual(DEFAULT_DESKTOP_FLAGS);
    expect(readFlags(writeFlags(home, "not json"))).toEqual(DEFAULT_DESKTOP_FLAGS);
    expect(readFlags(writeFlags(home, JSON.stringify({ showReasoning: true, note: "x".repeat(5_000) })))).toEqual(DEFAULT_DESKTOP_FLAGS);
});

test("a flags file with showReasoning true is read back on", () => {
    const home = trialHome();
    expect(readFlags(writeFlags(home, "{\"showReasoning\": true}"))).toEqual({ showReasoning: true });
});

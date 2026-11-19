import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_DESKTOP_FLAGS, FlagsStore, MAX_FLAGS_BYTES, flagsPath, readFlags } from "../../clients/desktop/src/desktop-flags.ts";
import {
    FLAG_KEYS,
    FLAG_SPECS,
    defaultFlags,
    flagSpec,
    parseFlagPatch,
    parseFlags,
} from "../../clients/ui/src/state/desktopFlags.ts";

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

test("@core every optional part has one flag, and core parts have none", () => {
    expect([...FLAG_KEYS].sort()).toEqual([
        "browser", "buildLine", "configure", "contextPill", "coverage", "customize", "devices", "diagnostics",
        "doctor", "extensions", "failures", "files", "nudges", "output", "plan", "review", "search", "showReasoning",
        "tour", "work",
    ]);
    expect(FLAG_SPECS.map((spec) => spec.key).sort()).toEqual([...FLAG_KEYS].sort());
});

test("@core packaged defaults hide the developer group and keep shipped behavior", () => {
    const packaged = defaultFlags(true);
    expect(packaged).toEqual(DEFAULT_DESKTOP_FLAGS);
    for (const spec of FLAG_SPECS.filter((entry) => entry.group === "developer")) expect(packaged[spec.key]).toBe("off");
    expect(packaged.showReasoning).toBe("off");
    expect(packaged.browser).toBe("on");
    for (const key of ["search", "work", "customize", "review", "plan", "files", "output", "contextPill", "doctor"] as const) {
        expect(packaged[key]).toBe("auto");
    }
});

test("@core development defaults turn the developer group on and leave the window group alone", () => {
    const development = defaultFlags(false);
    for (const spec of FLAG_SPECS.filter((entry) => entry.group === "developer")) expect(development[spec.key]).toBe("on");
    for (const spec of FLAG_SPECS.filter((entry) => entry.group === "window")) expect(development[spec.key]).toBe(defaultFlags(true)[spec.key]);
});

test("@core only parts with an auto condition offer auto", () => {
    const withoutAuto = FLAG_SPECS.filter((spec) => !spec.auto).map((spec) => spec.key).sort();
    expect(withoutAuto).toEqual([
        "browser", "buildLine", "configure", "coverage", "devices", "diagnostics", "extensions", "failures", "nudges",
        "showReasoning", "tour",
    ]);
});

test("@core reasoning reads the first version's boolean: true is on, false is off", () => {
    expect(parseFlags({ showReasoning: true }).showReasoning).toBe("on");
    expect(parseFlags({ showReasoning: false }).showReasoning).toBe("off");
    expect(parseFlags({ showReasoning: "on" }).showReasoning).toBe("on");
    for (const value of ["true", 1, null, undefined, "auto", "yes"]) expect(parseFlags({ showReasoning: value }).showReasoning).toBe("off");
    expect(parseFlags({ search: true }).search).toBe("auto");
    for (const value of [null, "flags", 3, []]) expect(parseFlags(value)).toEqual(DEFAULT_DESKTOP_FLAGS);
});

test("@core auto on a part with no auto condition reads as the build default", () => {
    expect(parseFlags({ devices: "auto" }, defaultFlags(true)).devices).toBe("off");
    expect(parseFlags({ devices: "auto" }, defaultFlags(false)).devices).toBe("on");
    expect(parseFlags({ browser: "auto" }).browser).toBe("on");
    expect(parseFlags({ search: "auto" }).search).toBe("auto");
});

test("@core a bad, misspelled or unknown entry never changes the other flags", () => {
    const flags = parseFlags({ work: "off", plan: "maybe", reveiw: "off", files: 3, extra: "on" });
    expect(flags).toEqual({ ...DEFAULT_DESKTOP_FLAGS, work: "off" });
});

test("a flag spec is found by key", () => {
    expect(flagSpec("browser").auto).toBe(false);
    expect(flagSpec("review").auto).toBe(true);
});

test("@core a patch names known flags with values their part offers", () => {
    expect(parseFlagPatch({ work: "off", plan: "on", files: "auto" })).toEqual({ work: "off", plan: "on", files: "auto" });
    expect(parseFlagPatch({ devices: "on" })).toEqual({ devices: "on" });
    for (const bad of [
        {},
        null,
        [],
        "work",
        { work: "maybe" },
        { work: true },
        { nope: "on" },
        { work: "off", nope: "on" },
        { devices: "auto" },
        { browser: "auto" },
        { showReasoning: "auto" },
    ]) {
        expect(parseFlagPatch(bad)).toBeUndefined();
    }
});

test("the flags file lives in the desktop's own folder under the home", () => {
    expect(flagsPath("/crow/home")).toBe(join("/crow/home", "machine", "desktop", "flags.json"));
});

test("@core a missing, unreadable or oversized flags file leaves every flag at its default", () => {
    const home = trialHome();
    expect(readFlags(flagsPath(home))).toEqual(DEFAULT_DESKTOP_FLAGS);
    expect(readFlags(writeFlags(home, "not json"))).toEqual(DEFAULT_DESKTOP_FLAGS);
    expect(readFlags(writeFlags(home, JSON.stringify({ work: "off", note: "x".repeat(MAX_FLAGS_BYTES + 1) })))).toEqual(DEFAULT_DESKTOP_FLAGS);
    expect(readFlags(writeFlags(home, "not json"), false)).toEqual(defaultFlags(false));
});

test("a flags file is read against the build's defaults", () => {
    const home = trialHome();
    const path = writeFlags(home, "{\"showReasoning\": true, \"work\": \"on\"}");
    expect(readFlags(path)).toEqual({ ...DEFAULT_DESKTOP_FLAGS, showReasoning: "on", work: "on" });
    expect(readFlags(path, false)).toEqual({ ...defaultFlags(false), showReasoning: "on", work: "on" });
});

test("reading never rewrites or moves the file", () => {
    const home = trialHome();
    const path = writeFlags(home, "not json");
    readFlags(path);
    expect(readFileSync(path, "utf8")).toBe("not json");
    expect(existsSync(`${path}.bad`)).toBe(false);
});

test("@core saving writes only what was chosen, keeps keys it does not know, and returns the flags after", () => {
    const home = trialHome();
    const path = flagsPath(home);
    const store = new FlagsStore(path, true);
    expect(store.update({ work: "off" })).toEqual({ ...DEFAULT_DESKTOP_FLAGS, work: "off" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ work: "off" });
    writeFileSync(path, JSON.stringify({ work: "off", futureFlag: "on" }));
    expect(store.update({ plan: "on" })).toEqual({ ...DEFAULT_DESKTOP_FLAGS, work: "off", plan: "on" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ work: "off", futureFlag: "on", plan: "on" });
});

test("a saved choice survives a new store on the same file, in either build", () => {
    const home = trialHome();
    const path = flagsPath(home);
    new FlagsStore(path, false).update({ tour: "off" });
    expect(new FlagsStore(path, false).read().tour).toBe("off");
    expect(new FlagsStore(path, true).read().tour).toBe("off");
    expect(new FlagsStore(path, false).read().devices).toBe("on");
});

test("@core a refused patch leaves the file as it was", () => {
    const home = trialHome();
    const path = flagsPath(home);
    const store = new FlagsStore(path, true);
    store.update({ work: "off" });
    const before = readFileSync(path, "utf8");
    for (const bad of [{ devices: "auto" }, { nope: "on" }, { work: 1 }, {}, null]) expect(store.update(bad)).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(before);
});

test("saving refuses a file past the size cap", () => {
    const home = trialHome();
    const path = flagsPath(home);
    const empty = JSON.stringify({ work: "off", note: "" }).length;
    writeFlags(home, JSON.stringify({ work: "off", note: "x".repeat(MAX_FLAGS_BYTES - empty - 4) }));
    const store = new FlagsStore(path, true);
    expect(store.update({ plan: "on" })).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf8")).work).toBe("off");
});

test("saving over an unreadable file keeps it aside and writes the choice alone", () => {
    const home = trialHome();
    const path = writeFlags(home, "not json");
    const store = new FlagsStore(path, true);
    expect(store.update({ files: "off" })).toEqual({ ...DEFAULT_DESKTOP_FLAGS, files: "off" });
    expect(readFileSync(`${path}.bad`, "utf8")).toBe("not json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ files: "off" });
});

test("the saved file is private to the owner", () => {
    const home = trialHome();
    const path = flagsPath(home);
    new FlagsStore(path, true).update({ work: "off" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
});

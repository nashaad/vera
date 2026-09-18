import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extensionRegistryPathFor } from "../src/extensions/manager.ts";
import {
    assertProfileLayout,
    legacyLayoutEntries,
    unrecognisedHomeEntries,
    VeraProfileError,
    veraProfileDirectory,
    veraRuntimeDirectory,
    veraMachineDirectory,
    veraHomeDirectory,
} from "../src/profile-paths.ts";

const home = "/home/nash";

test("the home is one directory, not a profile child", () => {
    expect(veraHomeDirectory(home)).toBe(join(home, ".vera"));
    expect(veraProfileDirectory({}, home)).toBe(join(home, ".vera"));
    expect(veraRuntimeDirectory({}, home)).toBe(join(home, ".vera", "runtime"));
});

test("credentials sit in the machine tier beside config", () => {
    expect(veraMachineDirectory(home)).toBe(join(home, ".vera", "machine"));
});

test("runtime is always the home child, not a second island", () => {
    expect(veraRuntimeDirectory({ VERA_HOME: "/tmp/other" }, home))
        .toBe(join(home, ".vera", "runtime"));
});

test("an unmigrated profiles/ home is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "profiles", "default"), { recursive: true });

    expect(legacyLayoutEntries(root)).toEqual(["profiles"]);
    expect(() => assertProfileLayout(root)).toThrow(VeraProfileError);
    try {
        assertProfileLayout(root);
    } catch (error) {
        expect((error as Error).message).toContain("profiles/");
        expect((error as Error).message).toContain("vera migrate-home");
    }
});

test("the old machine-tier name is refused with the rename to run", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "user"), { recursive: true });
    expect(() => assertProfileLayout(root)).toThrow(VeraProfileError);
    try {
        assertProfileLayout(root);
    } catch (error) {
        expect((error as Error).message).toContain(veraMachineDirectory(root));
    }
});

test("a single-home layout is accepted", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "machine"), { recursive: true });
    mkdirSync(join(root, ".vera", "runtime"), { recursive: true });
    writeFileSync(join(root, ".vera", "config.json"), "{}");
    expect(legacyLayoutEntries(root)).toEqual([]);
    expect(() => assertProfileLayout(root)).not.toThrow();
});

test("tip history at the home root is owned, not leftover", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera"), { recursive: true });
    writeFileSync(join(root, ".vera", "tips.json"), "{}");
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

test("the extension registry the installer writes is owned", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "extensions"), { recursive: true });
    writeFileSync(
        extensionRegistryPathFor({ home: root }),
        "{}",
    );
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

test("state written outside the known root names is named", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "machine"), { recursive: true });
    mkdirSync(join(root, ".vera", "runtime"), { recursive: true });
    expect(unrecognisedHomeEntries(root)).toEqual([]);

    mkdirSync(join(root, ".vera", "chrome"));
    writeFileSync(join(root, ".vera", "tui.json"), "{}");
    writeFileSync(join(root, ".vera", "tips.json"), "{}");
    writeFileSync(join(root, ".vera", ".DS_Store"), "");
    expect(unrecognisedHomeEntries(root)).toEqual(["chrome"]);
});

test("storage for an installed extension is owned", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "extensions", "chrome"), { recursive: true });
    writeFileSync(
        join(root, ".vera", "extensions", "chrome", "vera.extension.json"),
        JSON.stringify({ id: "vera.chrome", version: "1.0.0" }),
    );
    mkdirSync(join(root, ".vera", "vera.chrome"));
    expect(unrecognisedHomeEntries(root)).toEqual([]);

    mkdirSync(join(root, ".vera", "vera.other"));
    expect(unrecognisedHomeEntries(root)).toEqual(["vera.other"]);
});

test("storage for a managed extension is owned", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "extensions", ".managed"), { recursive: true });
    writeFileSync(
        join(root, ".vera", "extensions", ".managed", "vera.btw.json"),
        "{}",
    );
    mkdirSync(join(root, ".vera", "vera.btw"));
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

test("a home that does not exist yet has nothing to complain about", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

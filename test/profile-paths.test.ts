import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    assertProfileLayout,
    DEFAULT_PROFILE_NAME,
    legacyLayoutEntries,
    unrecognisedHomeEntries,
    VERA_PROFILE_ENV,
    VERA_RUNTIME_DIR_ENV,
    VeraProfileError,
    veraProfileDirectory,
    veraProfileName,
    veraRuntimeDirectory,
    veraMachineDirectory,
    veraHomeDirectory,
} from "../src/profile-paths.ts";

const home = "/home/nash";

test("the home is one directory, not a profile child", () => {
    expect(veraHomeDirectory(home)).toBe(join(home, ".vera"));
    expect(veraProfileDirectory({}, home)).toBe(join(home, ".vera"));
    expect(veraRuntimeDirectory({}, home)).toBe(join(home, ".vera", "runtime"));
    expect(veraProfileDirectory({ [VERA_PROFILE_ENV]: "dogfood" }, home))
        .toBe(join(home, ".vera"));
});

test("credentials sit in the machine tier beside config", () => {
    expect(veraMachineDirectory(home)).toBe(join(home, ".vera", "machine"));
});

test("a profile name may not escape a profiles directory", () => {
    for (const name of ["../other", "a/b", ".", "-x", "~"]) {
        expect(() => veraProfileName({ [VERA_PROFILE_ENV]: name }))
            .toThrow(VeraProfileError);
    }
    expect(veraProfileName({})).toBe(DEFAULT_PROFILE_NAME);
});

test("VERA_RUNTIME_DIR is the explicit instance root", () => {
    const env = { [VERA_RUNTIME_DIR_ENV]: "/tmp/run" };
    expect(veraRuntimeDirectory(env, home)).toBe("/tmp/run");
    expect(veraProfileDirectory(env, home)).toBe(join(home, ".vera"));
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

test("state written outside the known root names is named", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "machine"), { recursive: true });
    mkdirSync(join(root, ".vera", "runtime"), { recursive: true });
    expect(unrecognisedHomeEntries(root)).toEqual([]);

    mkdirSync(join(root, ".vera", "chrome"));
    writeFileSync(join(root, ".vera", ".DS_Store"), "");
    expect(unrecognisedHomeEntries(root)).toEqual(["chrome"]);
});

test("a home that does not exist yet has nothing to complain about", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

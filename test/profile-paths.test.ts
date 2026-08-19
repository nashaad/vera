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
} from "../src/profile-paths.ts";

const home = "/home/nash";

test("an unset profile selects default", () => {
    expect(veraProfileName({})).toBe(DEFAULT_PROFILE_NAME);
    expect(veraProfileName({ [VERA_PROFILE_ENV]: "  " })).toBe(DEFAULT_PROFILE_NAME);
    expect(veraProfileDirectory({}, home))
        .toBe(join(home, ".vera", "profiles", "default"));
});

test("one selector resolves both the profile root and its runtime", () => {
    const env = { [VERA_PROFILE_ENV]: "dogfood" };
    expect(veraProfileDirectory(env, home))
        .toBe(join(home, ".vera", "profiles", "dogfood"));
    expect(veraRuntimeDirectory(env, home))
        .toBe(join(home, ".vera", "profiles", "dogfood", "runtime"));
});

test("credentials sit outside every profile", () => {
    expect(veraMachineDirectory(home)).toBe(join(home, ".vera", "machine"));
    expect(veraMachineDirectory(home))
        .not.toContain(veraProfileDirectory({}, home));
});

test("a profile name may not escape the profiles directory", () => {
    for (const name of ["../other", "a/b", ".", "-x", "~"]) {
        expect(() => veraProfileName({ [VERA_PROFILE_ENV]: name }))
            .toThrow(VeraProfileError);
    }
});

test("VERA_RUNTIME_DIR stays the lower-level override", () => {
    const env = { [VERA_PROFILE_ENV]: "dogfood", [VERA_RUNTIME_DIR_ENV]: "/tmp/run" };
    expect(veraRuntimeDirectory(env, home)).toBe("/tmp/run");
    expect(veraProfileDirectory(env, home))
        .toBe(join(home, ".vera", "profiles", "dogfood"));
});

test("the old flat layout is refused rather than read as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera"), { recursive: true });
    writeFileSync(join(root, ".vera", "auth.json"), "{}");
    mkdirSync(join(root, ".vera", "sessions"));

    expect(legacyLayoutEntries(root)).toEqual(["auth.json", "sessions"]);
    expect(() => assertProfileLayout(root)).toThrow(VeraProfileError);
    try {
        assertProfileLayout(root);
    } catch (error) {
        expect((error as Error).message).toBe(
            `${join(root, ".vera")} uses the old flat layout and Vera no longer reads it.\n`
            + "Found old entries: auth.json, sessions\n"
            + "Run these commands, then start Vera again:\n"
            + `  mkdir -p ${veraMachineDirectory(root)} ${join(root, ".vera", "profiles", "default")}\n`
            + `  mv ${join(root, ".vera", "auth.json")} ${veraMachineDirectory(root)}/\n`
            + `  mv ${join(root, ".vera", "sessions")} ${join(root, ".vera", "profiles", "default")}/`,
        );
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

test("a tiered home is accepted", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "machine"), { recursive: true });
    mkdirSync(join(root, ".vera", "profiles", "default"), { recursive: true });
    expect(legacyLayoutEntries(root)).toEqual([]);
    expect(() => assertProfileLayout(root)).not.toThrow();
});

test("state written outside the tiers is named", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "machine"), { recursive: true });
    mkdirSync(join(root, ".vera", "profiles", "default"), { recursive: true });
    expect(unrecognisedHomeEntries(root)).toEqual([]);

    mkdirSync(join(root, ".vera", "chrome"));
    writeFileSync(join(root, ".vera", ".DS_Store"), "");
    expect(unrecognisedHomeEntries(root)).toEqual(["chrome"]);
});

test("a home that does not exist yet has nothing to complain about", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

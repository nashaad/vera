import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extensionStorage } from "../../src/extensions/storage.ts";
import {
    EXTENSION_DATA_DIRECTORY,
    VERA_HOME_ENV,
} from "../../src/profile-paths.ts";

const previousHome = process.env[VERA_HOME_ENV];

afterEach(() => {
    if (previousHome === undefined) delete process.env[VERA_HOME_ENV];
    else process.env[VERA_HOME_ENV] = previousHome;
});

function useTemporaryHome(): string {
    const home = join(mkdtempSync(join(tmpdir(), "vera-storage-")), ".vera");
    mkdirSync(home, { recursive: true });
    process.env[VERA_HOME_ENV] = home;
    return home;
}

test("extension data sits under its own directory, not beside Vera's files", () => {
    const home = useTemporaryHome();
    const storage = extensionStorage("vera.chrome");
    expect(storage.profile).toBe(
        join(home, EXTENSION_DATA_DIRECTORY, "vera.chrome"),
    );
    expect(storage.machine).toBe(
        join(home, "machine", EXTENSION_DATA_DIRECTORY, "vera.chrome"),
    );
    expect(existsSync(storage.profile)).toBe(true);
});

test("data left at the tier root moves to the new directory", () => {
    const home = useTemporaryHome();
    mkdirSync(join(home, "vera.chrome"), { recursive: true });
    writeFileSync(join(home, "vera.chrome", "pairing.json"), "{\"kept\":true}");

    const moved = extensionStorage("vera.chrome").profile;

    expect(moved).toBe(join(home, EXTENSION_DATA_DIRECTORY, "vera.chrome"));
    expect(readFileSync(join(moved, "pairing.json"), "utf8")).toBe(
        "{\"kept\":true}",
    );
    expect(existsSync(join(home, "vera.chrome"))).toBe(false);
});

test("an already migrated extension leaves the old directory alone", () => {
    const home = useTemporaryHome();
    mkdirSync(join(home, EXTENSION_DATA_DIRECTORY, "vera.chrome"), {
        recursive: true,
    });
    writeFileSync(
        join(home, EXTENSION_DATA_DIRECTORY, "vera.chrome", "state.json"),
        "current",
    );
    mkdirSync(join(home, "vera.chrome"), { recursive: true });
    writeFileSync(join(home, "vera.chrome", "state.json"), "stale");

    const path = extensionStorage("vera.chrome").profile;

    expect(readFileSync(join(path, "state.json"), "utf8")).toBe("current");
    expect(existsSync(join(home, "vera.chrome"))).toBe(true);
});

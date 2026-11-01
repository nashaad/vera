import { afterEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
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

test("a home directory named like the extension id is left in place", () => {
    const home = useTemporaryHome();
    mkdirSync(join(home, "hooks"), { recursive: true });
    writeFileSync(join(home, "hooks", "audit.json"), "{\"kept\":true}");

    const path = extensionStorage("hooks").profile;

    expect(path).toBe(join(home, EXTENSION_DATA_DIRECTORY, "hooks"));
    expect(readdirSync(path)).toEqual([]);
    expect(readFileSync(join(home, "hooks", "audit.json"), "utf8")).toBe(
        "{\"kept\":true}",
    );
});

test("home files named like the extension id are left in place", () => {
    const home = useTemporaryHome();
    mkdirSync(join(home, "machine"), { recursive: true });
    writeFileSync(join(home, "config.json"), "{\"theme\":\"dark\"}");
    writeFileSync(join(home, "machine", "auth.json"), "{\"token\":\"t\"}");

    const config = extensionStorage("config.json");
    const auth = extensionStorage("auth.json");

    expect(config.profile).toBe(
        join(home, EXTENSION_DATA_DIRECTORY, "config.json"),
    );
    expect(auth.machine).toBe(
        join(home, "machine", EXTENSION_DATA_DIRECTORY, "auth.json"),
    );
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(
        "{\"theme\":\"dark\"}",
    );
    expect(readFileSync(join(home, "machine", "auth.json"), "utf8")).toBe(
        "{\"token\":\"t\"}",
    );
    expect(statSync(config.profile).isDirectory()).toBe(true);
    expect(statSync(auth.machine).isDirectory()).toBe(true);
});

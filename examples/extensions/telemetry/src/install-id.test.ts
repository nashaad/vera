import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTALL_ID_FILE, readOrCreateInstallId } from "./install-id.ts";

const directories: string[] = [];

async function scratch(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "telemetry-install-"));
    directories.push(directory);
    return directory;
}

afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("readOrCreateInstallId", () => {
    test("creates a UUID once and keeps it", async () => {
        const directory = await scratch();
        const first = readOrCreateInstallId(directory);
        expect(first).toMatch(UUID);
        expect((await readFile(join(directory, INSTALL_ID_FILE), "utf8")).trim()).toBe(first);
        expect(readOrCreateInstallId(directory)).toBe(first);
    });

    test("replaces a damaged file with a new id", async () => {
        const directory = await scratch();
        await writeFile(join(directory, INSTALL_ID_FILE), "not a uuid\n");
        const id = readOrCreateInstallId(directory);
        expect(id).toMatch(UUID);
        expect((await readFile(join(directory, INSTALL_ID_FILE), "utf8")).trim()).toBe(id);
    });

    test("creates the profile directory when it is missing", async () => {
        const directory = join(await scratch(), "nested");
        expect(readOrCreateInstallId(directory)).toMatch(UUID);
    });
});

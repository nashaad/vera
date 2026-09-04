import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
    devInstanceDirectory,
    devInstancePath,
    dropDevInstance,
    listDevInstances,
    processIsDevelopmentInstance,
    registerDevInstance,
} from "../src/dev-instances.ts";
import { releasesDirectory } from "../src/release/layout.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function tempDir(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function tempHome(): string {
    const home = join(tempDir("vera-dev-instance-"), ".vera");
    mkdirSync(home, { recursive: true });
    return home;
}

test("the registry sits outside every Vera home", () => {
    const root = tempDir("vera-dev-root-");
    const directory = devInstanceDirectory(root);
    expect(directory).toBe(join(root, ".vera-dev", "instances"));
    expect(directory.split(sep)).not.toContain(".vera");
});

test("code under the install prefix is the one Vera a person runs on purpose", () => {
    const installed = tempDir("vera-installed-");
    const release = join(installed, "vera-abc123", "clients", "host");
    mkdirSync(release, { recursive: true });
    const packed = join(release, "main.ts");
    writeFileSync(packed, "");

    expect(processIsDevelopmentInstance(packed, installed)).toBe(false);
    expect(
        processIsDevelopmentInstance(
            fileURLToPath(import.meta.url),
            installed,
        ),
    ).toBe(true);
});

test("a checkout run reports itself as development", () => {
    expect(
        processIsDevelopmentInstance(fileURLToPath(import.meta.url)),
    ).toBe(true);
    expect(releasesDirectory()).toContain(join("share", "vera", "releases"));
});

test("one home keeps one entry however often it is relaunched", () => {
    const root = tempDir("vera-dev-root-");
    const home = tempHome();
    const source = fileURLToPath(import.meta.url);

    const first = registerDevInstance({ source, home, root });
    const second = registerDevInstance({ source, home, root });

    expect(devInstancePath(home, root)).toBe(devInstancePath(home, root));
    expect(listDevInstances(root)).toEqual([second]);
    expect(first.home).toBe(second.home);
});

test("an entry whose home is gone is dropped as the registry is read", () => {
    const root = tempDir("vera-dev-root-");
    const kept = tempHome();
    const removed = tempHome();
    const source = fileURLToPath(import.meta.url);
    registerDevInstance({ source, home: kept, root });
    registerDevInstance({ source, home: removed, root });
    expect(listDevInstances(root)).toHaveLength(2);

    rmSync(removed, { recursive: true, force: true });

    expect(listDevInstances(root).map((entry) => entry.home)).toEqual([kept]);
});

test("an unreadable entry is discarded, not thrown over", () => {
    const root = tempDir("vera-dev-root-");
    const home = tempHome();
    registerDevInstance({ source: fileURLToPath(import.meta.url), home, root });
    const directory = devInstanceDirectory(root);
    writeFileSync(join(directory, "junk.json"), "{not json");
    writeFileSync(
        join(directory, "old.json"),
        JSON.stringify({ schema_version: 0, home }),
    );

    expect(listDevInstances(root).map((entry) => entry.home)).toEqual([home]);
});

test("dropping an entry that was never written is not an error", () => {
    const root = tempDir("vera-dev-root-");
    expect(() => dropDevInstance("/nowhere/.vera", root)).not.toThrow();
    expect(listDevInstances(root)).toEqual([]);
});

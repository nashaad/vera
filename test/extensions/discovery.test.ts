import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverExtensionConfigs } from "../../src/extensions/discovery.ts";
import { EXTENSION_MANIFEST_FILENAME } from "../../src/extensions/manifest.ts";

function extensionAt(root: string, name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, EXTENSION_MANIFEST_FILENAME), "{}");
    return path;
}

test("a symlinked extension is discovered", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-discovery-"));
    const elsewhere = extensionAt(root, "elsewhere");
    const directory = join(root, "extensions");
    mkdirSync(directory);
    symlinkSync(elsewhere, join(directory, "linked"));

    expect(discoverExtensionConfigs(directory).map((e) => e.path))
        .toEqual([join(directory, "linked")]);
});

test("a symlink without a manifest is not discovered", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-discovery-"));
    const plain = join(root, "plain");
    mkdirSync(plain);
    const file = join(root, "file.txt");
    writeFileSync(file, "");
    const directory = join(root, "extensions");
    mkdirSync(directory);
    symlinkSync(plain, join(directory, "no-manifest"));
    symlinkSync(file, join(directory, "not-a-directory"));
    symlinkSync(join(root, "missing"), join(directory, "broken"));

    expect(discoverExtensionConfigs(directory)).toEqual([]);
});

test("directories and symlinks are discovered together in name order", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-discovery-"));
    const elsewhere = extensionAt(root, "elsewhere");
    const directory = join(root, "extensions");
    mkdirSync(directory);
    extensionAt(directory, "b-real");
    symlinkSync(elsewhere, join(directory, "a-linked"));

    expect(discoverExtensionConfigs(directory).map((e) => e.path)).toEqual([
        join(directory, "a-linked"),
        join(directory, "b-real"),
    ]);
});

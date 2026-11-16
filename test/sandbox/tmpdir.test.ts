import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ensureOwnerOnlyDirectory,
    sandboxTmpDir,
} from "../../src/sandbox/tmpdir.ts";

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function directory(): string {
    const path = mkdtempSync(join(tmpdir(), "vera-sandbox-tmpdir-"));
    directories.push(path);
    return path;
}

test("@core the temp folder is read from the wrapped command", () => {
    expect(sandboxTmpDir([
        "bash",
        "-c",
        "env SANDBOX_RUNTIME=1 TMPDIR=/private/sandbox-tmp "
            + "/usr/bin/sandbox-exec -p '(version 1)' bash -c 'echo x'",
    ])).toBe("/private/sandbox-tmp");
    expect(sandboxTmpDir([
        "bash",
        "-c",
        "env SANDBOX_RUNTIME=1 TMPDIR='/private/with space' /usr/bin/sandbox-exec",
    ])).toBe("/private/with space");
    expect(sandboxTmpDir([
        "bwrap",
        "--setenv",
        "TMPDIR",
        "/private/linux-tmp",
        "--",
        "bash",
        "-c",
        "echo x",
    ])).toBe("/private/linux-tmp");
    expect(sandboxTmpDir(["bash", "-c", "echo x"])).toBeUndefined();
});

test("@core the temp folder is created owner-only", () => {
    const root = directory();
    const path = join(root, "nested", "folder");
    expect(ensureOwnerOnlyDirectory(path)).toBeUndefined();
    const stat = statSync(path);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    if (typeof process.getuid === "function") {
        expect(stat.uid).toBe(process.getuid());
    }
    expect(ensureOwnerOnlyDirectory(path)).toBeUndefined();
});

test("@core a temp folder that is not ours to use is refused", () => {
    const root = directory();
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    expect(ensureOwnerOnlyDirectory(file)).toContain("is not a directory");

    const link = join(root, "a-link");
    symlinkSync(root, link);
    expect(ensureOwnerOnlyDirectory(link)).toContain("is a symbolic link");
});

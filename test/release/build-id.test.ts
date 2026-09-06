import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    releaseBuildId,
    releaseSourceIdentity,
} from "../../src/release/build-id.ts";

function git(cwd: string, args: readonly string[]): string {
    const result = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString() || args.join(" "));
    }
    return result.stdout.toString().trim();
}

function initRepo(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-build-id-"));
    git(directory, ["init", "-q"]);
    git(directory, ["config", "user.email", "nashaad@gmail.com"]);
    git(directory, ["config", "user.name", "nashaad"]);
    writeFileSync(join(directory, "file.txt"), "clean\n");
    git(directory, ["add", "file.txt"]);
    git(directory, ["commit", "-q", "-m", "init"]);
    return directory;
}

test("a clean commit is vera-shortsha with no dirty suffix", () => {
    const directory = initRepo();
    try {
        const identity = releaseSourceIdentity(directory);
        const short = git(directory, ["rev-parse", "--short", "HEAD"]);
        const full = git(directory, ["rev-parse", "HEAD"]);
        expect(identity.dirty).toBe(false);
        expect(identity.shortRevision).toBe(short);
        expect(identity.sourceRevision).toBe(full);
        expect(identity.buildId).toBe(`vera-${short}`);
        expect(releaseBuildId(directory)).toBe(identity.buildId);
        expect(releaseBuildId(directory)).toBe(releaseBuildId(directory));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("untracked directory and broken symlinks hash their targets without following them", () => {
    const directory = initRepo();
    try {
        const link = join(directory, "skill");
        symlinkSync(".", link);
        const first = releaseBuildId(directory);
        expect(releaseBuildId(directory)).toBe(first);
        unlinkSync(link);
        symlinkSync("missing-target", link);
        expect(releaseBuildId(directory)).not.toBe(first);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("two dirty states of the same commit produce different build ids", () => {
    const directory = initRepo();
    try {
        const clean = releaseBuildId(directory);
        writeFileSync(join(directory, "file.txt"), "first dirty\n");
        const first = releaseBuildId(directory);
        writeFileSync(join(directory, "file.txt"), "second dirty\n");
        const second = releaseBuildId(directory);
        writeFileSync(join(directory, "extra.txt"), "untracked\n");
        const third = releaseBuildId(directory);

        expect(first).not.toBe(clean);
        expect(second).not.toBe(first);
        expect(third).not.toBe(second);
        expect(first).toMatch(/^vera-[0-9a-f]+\+[0-9a-f]{12}$/);
        expect(second).toMatch(/^vera-[0-9a-f]+\+[0-9a-f]{12}$/);
        expect(third).toMatch(/^vera-[0-9a-f]+\+[0-9a-f]{12}$/);
        expect(first.startsWith(`${clean}+`)).toBe(true);
        expect(second.startsWith(`${clean}+`)).toBe(true);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

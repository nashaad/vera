import { afterAll, beforeAll, expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    realpath,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    resolveRealTarget,
    resolveRealTargets,
} from "../../src/tools/real-target.ts";

// `root` is left unresolved: on macOS the temp folder is itself behind a link.
let root: string;
let realRoot: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vera-real-target-"));
    realRoot = await realpath(root);
    await mkdir(join(root, "ship", "charts"), { recursive: true });
    await mkdir(join(root, "island", "vault"), { recursive: true });
    await writeFile(join(root, "ship", "log.txt"), "arr");
    await symlink("../island/vault", join(root, "ship", "hold"));
    await symlink(join(root, "nowhere", "chest"), join(root, "ship", "sunk"));
    await symlink("loop-b", join(root, "ship", "loop-a"));
    await symlink("loop-a", join(root, "ship", "loop-b"));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

test("an existing path resolves through the links above it", async () => {
    expect(await resolveRealTarget(join(root, "ship", "charts")))
        .toBe(join(realRoot, "ship", "charts"));
});

test("a new file under a linked folder lands where the link points", async () => {
    expect(await resolveRealTarget(`${root}/ship/hold/map.txt`))
        .toBe(join(realRoot, "island", "vault", "map.txt"));
});

test("`..` after a link climbs from the link's target", async () => {
    expect(await resolveRealTarget(`${root}/ship/hold/../gold`))
        .toBe(join(realRoot, "island", "gold"));
});

test("missing folders are kept as written", async () => {
    expect(await resolveRealTarget(`${root}/ship/new/deeper/file`))
        .toBe(join(realRoot, "ship", "new", "deeper", "file"));
});

test("a dangling link resolves to the file it would create", async () => {
    expect(await resolveRealTarget(`${root}/ship/sunk`))
        .toBe(join(realRoot, "nowhere", "chest"));
});

test("paths that cannot be followed are unresolved", async () => {
    expect(await resolveRealTarget(`${root}/ship/log.txt/x`)).toBeUndefined();
    expect(await resolveRealTarget(`${root}/ship/new/../hold/x`))
        .toBeUndefined();
    expect(await resolveRealTarget(`${root}/ship/loop-a/x`)).toBeUndefined();
    expect(await resolveRealTarget("ship/charts")).toBeUndefined();
});

test("the map keeps each requested path once and drops unresolved ones", async () => {
    const hold = `${root}/ship/hold/map.txt`;
    const resolved = await resolveRealTargets([
        hold,
        hold,
        `${root}/ship/log.txt/x`,
    ]);
    expect([...resolved]).toEqual([
        [hold, join(realRoot, "island", "vault", "map.txt")],
    ]);
});

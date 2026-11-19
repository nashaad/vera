import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundledInstallPreflight } from "../../clients/desktop/src/install-preflight.ts";
import { BUNDLED_RELEASE_TARBALL } from "../../clients/desktop/src/release-install.ts";
import { currentReleaseBuildId, releasesDirectory } from "../../src/release/layout.ts";
import { writeFixtureBundle, type FixtureRelease } from "../support/packed-release-fixture.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): { readonly prefix: string; readonly bundle: string } {
    const root = mkdtempSync(join(tmpdir(), "vera-install-preflight-"));
    roots.push(root);
    return { prefix: join(root, "prefix"), bundle: join(root, "bundle") };
}

function release(buildId: string, productVersion: string): FixtureRelease {
    return { buildId, productVersion, builtAt: "2026-11-01T00:00:00.000Z" };
}

function hooks(): { readonly installing: () => void; readonly count: () => number } {
    let count = 0;
    return { installing: () => { count += 1; }, count: () => count };
}

function bundle(where: { readonly bundle: string }, next: FixtureRelease): void {
    rmSync(where.bundle, { recursive: true, force: true });
    writeFixtureBundle(where.bundle, next);
}

test("@core a first install continues with no notice and reports the installing state", async () => {
    const where = scratch();
    bundle(where, release("vera-first", "0.1.0"));
    const seen = hooks();
    const result = await bundledInstallPreflight(where.bundle, where.prefix)(seen);
    expect(result).toEqual({ kind: "continue" });
    expect(seen.count()).toBe(1);
    expect(currentReleaseBuildId(where.prefix)).toBe("vera-first");
});

test("a release that is already in place continues without an installing state", async () => {
    const where = scratch();
    bundle(where, release("vera-first", "0.1.0"));
    await bundledInstallPreflight(where.bundle, where.prefix)(hooks());
    const seen = hooks();
    expect(await bundledInstallPreflight(where.bundle, where.prefix)(seen)).toEqual({ kind: "continue" });
    expect(seen.count()).toBe(0);
});

test("@core a failed install over a working command continues with a notice naming the reason", async () => {
    const where = scratch();
    bundle(where, release("vera-old", "0.1.0"));
    await bundledInstallPreflight(where.bundle, where.prefix)(hooks());
    bundle(where, release("vera-new", "0.2.0"));
    writeFileSync(join(where.bundle, BUNDLED_RELEASE_TARBALL), "not an archive\n");

    const seen = hooks();
    const result = await bundledInstallPreflight(where.bundle, where.prefix)(seen);
    expect(result).toEqual({
        kind: "continue",
        notice: "The bundled archive does not match its checksum. Vera is using the release you already had.",
    });
    expect(seen.count()).toBe(1);
    expect(currentReleaseBuildId(where.prefix)).toBe("vera-old");
    expect(readdirSync(releasesDirectory(where.prefix))).toEqual(["vera-old"]);
});

test("@core a failed first install stops with the message and Try again", async () => {
    const where = scratch();
    bundle(where, release("vera-first", "0.1.0"));
    writeFileSync(join(where.bundle, BUNDLED_RELEASE_TARBALL), "not an archive\n");

    const result = await bundledInstallPreflight(where.bundle, where.prefix)(hooks());
    expect(result).toEqual({
        kind: "stop",
        message: "Vera could not install the release inside this app. The bundled archive does not match its checksum. Choose Try again to retry.",
    });
    expect(currentReleaseBuildId(where.prefix)).toBeUndefined();
});

test("two boots at once install once and the second finds the release in place", async () => {
    const where = scratch();
    bundle(where, release("vera-first", "0.1.0"));
    const preflight = bundledInstallPreflight(where.bundle, where.prefix);
    const first = hooks();
    const second = hooks();
    const results = await Promise.all([preflight(first), preflight(second)]);
    expect(results).toEqual([{ kind: "continue" }, { kind: "continue" }]);
    expect([first.count(), second.count()]).toEqual([1, 0]);
    expect(readdirSync(releasesDirectory(where.prefix))).toEqual(["vera-first"]);
});

import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { currentReleaseBuildId, releasesDirectory } from "../../src/release/layout.ts";
import { cachedShellTarball, stageShell, sweepShellLeftovers } from "../../src/release/shell-update.ts";
import { swapPaths } from "../../src/release/swap-paths.ts";
import {
    NEW_VERSION,
    SHELL_ASSET,
    desktopAssetUrl,
    desktopRoutes,
    desktopTarball,
    fixtureAppPath,
    shellLabel,
    shellRoutes,
    shellTarball,
    writeShellApp,
    withDesktopUpdate,
    type DesktopUpdateRun,
    type FakeRoute,
} from "./update-fixtures.ts";
import { finalLine, jsonRun } from "./update-json-support.ts";

// A feed whose desktop package needs shell API `needs`, and whose shell archive is `shell` when one is given.
function feedWith(setup: DesktopUpdateRun, needs: number, shell?: string): Record<string, FakeRoute> {
    return {
        ...setup.feed(),
        ...desktopRoutes(NEW_VERSION, desktopTarball(setup.root, "vera-new", NEW_VERSION, needs)),
        ...(shell === undefined ? {} : shellRoutes(NEW_VERSION, shell)),
    };
}

function leftovers(setup: DesktopUpdateRun): string[] {
    return readdirSync(dirname(fixtureAppPath(setup.prefix))).filter((name) => name !== "Vera.app");
}

test("@core a package that needs a newer shell replaces Vera.app with the pair", async () => {
    await withDesktopUpdate(async (setup) => {
        const app = fixtureAppPath(setup.prefix);
        writeShellApp(app, 1);
        const feed = feedWith(setup, 2, shellTarball(setup.root, 2));
        const run = await jsonRun(setup, feed);
        expect(run.lines.map((line) => line.phase ?? line.result)).toContain("switching");
        expect(finalLine(run)).toEqual({ result: "done", version: NEW_VERSION, build: "vera-new", changed: true });
        expect(shellLabel(app)).toBe("shell-api-2");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
        expect(leftovers(setup)).toEqual([]);
        expect(existsSync(cachedShellTarball(setup.prefix, `v${NEW_VERSION}`, "darwin", "arm64"))).toBe(false);
    });
});

test("a shell that is new enough is left alone and its archive is never fetched", async () => {
    await withDesktopUpdate(async (setup) => {
        const app = fixtureAppPath(setup.prefix);
        writeShellApp(app, 2, { label: "kept" });
        const run = await jsonRun(setup, feedWith(setup, 2));
        expect(finalLine(run)).toMatchObject({ result: "done", changed: true });
        expect(shellLabel(app)).toBe("kept");
    });
});

test("@core an app that is too old and cannot be replaced holds the update with nothing switched", async () => {
    const cases: Array<{
        readonly name: string;
        readonly prepare: (setup: DesktopUpdateRun) => void;
        readonly shell: (setup: DesktopUpdateRun) => string | undefined;
        readonly says: string;
    }> = [
        {
            name: "no app at the recorded path",
            prepare: () => undefined,
            shell: (setup) => shellTarball(setup.root, 2),
            says: "there is no app at",
        },
        {
            name: "something else at the recorded path",
            prepare: (setup) => writeShellApp(fixtureAppPath(setup.prefix), 1, { bundleId: "com.example.other" }),
            shell: (setup) => shellTarball(setup.root, 2),
            says: "is not the Vera desktop app, so it was left alone",
        },
        {
            name: "a folder that cannot be written",
            prepare: (setup) => {
                writeShellApp(fixtureAppPath(setup.prefix), 1);
                chmodSync(dirname(fixtureAppPath(setup.prefix)), 0o555);
            },
            shell: (setup) => shellTarball(setup.root, 2),
            says: "is not writable",
        },
        {
            name: "a release without the shell archive",
            prepare: (setup) => writeShellApp(fixtureAppPath(setup.prefix), 1),
            shell: () => undefined,
            says: "the release does not include one yet",
        },
        {
            name: "an archive whose shell is still too old",
            prepare: (setup) => writeShellApp(fixtureAppPath(setup.prefix), 1),
            shell: (setup) => shellTarball(setup.root, 1),
            says: "is older than the desktop package needs",
        },
        {
            name: "an archive that holds more than the app",
            prepare: (setup) => writeShellApp(fixtureAppPath(setup.prefix), 1),
            shell: (setup) => shellTarball(setup.root, 2, { extraTop: true }),
            says: "does not hold only Vera.app",
        },
        {
            name: "an archive whose app is not a Vera shell",
            prepare: (setup) => writeShellApp(fixtureAppPath(setup.prefix), 1),
            shell: (setup) => shellTarball(setup.root, 2, { bundleId: "com.example.other" }),
            says: "is not the Vera desktop app",
        },
    ];
    for (const item of cases) {
        await withDesktopUpdate(async (setup) => {
            item.prepare(setup);
            const before = shellLabel(fixtureAppPath(setup.prefix));
            const run = await jsonRun(setup, feedWith(setup, 2, item.shell(setup)));
            try {
                expect(finalLine(run), item.name).toMatchObject({ result: "held", changed: false });
                expect(String(finalLine(run).message), item.name).toContain(item.says);
                expect(run.lines.some((line) => line.phase === "switching"), item.name).toBe(false);
                expect(currentReleaseBuildId(setup.prefix), item.name).toBe("vera-old");
                expect(shellLabel(fixtureAppPath(setup.prefix)), item.name).toBe(before);
                expect(leftovers(setup).filter((name) => name.startsWith(".")), item.name).toEqual([]);
            } finally {
                chmodSync(dirname(fixtureAppPath(setup.prefix)), 0o755);
            }
        });
    }
});

test("a shell archive that fails its checksum fails the update with nothing changed, and a retry completes", async () => {
    await withDesktopUpdate(async (setup) => {
        const app = fixtureAppPath(setup.prefix);
        writeShellApp(app, 1);
        const archive = shellTarball(setup.root, 2);
        const bad = { ...feedWith(setup, 2), ...shellRoutes(NEW_VERSION, archive, "0".repeat(64)) };
        const failed = await jsonRun(setup, bad);
        expect(finalLine(failed)).toMatchObject({ result: "failed", changed: false });
        expect(String(finalLine(failed).message)).toContain("Checksum mismatch");
        expect(shellLabel(app)).toBe("shell-api-1");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        expect(existsSync(cachedShellTarball(setup.prefix, `v${NEW_VERSION}`, "darwin", "arm64"))).toBe(false);

        const retry = await jsonRun(setup, feedWith(setup, 2, archive));
        expect(finalLine(retry)).toMatchObject({ result: "done", changed: true });
        expect(shellLabel(app)).toBe("shell-api-2");
    });
});

test("@core download only keeps the shell archive, a check reports it, and the next update fetches nothing", async () => {
    await withDesktopUpdate(async (setup) => {
        const app = fixtureAppPath(setup.prefix);
        writeShellApp(app, 1);
        const feed = feedWith(setup, 2, shellTarball(setup.root, 2));
        const staged = await jsonRun(setup, feed, { downloadOnly: true });
        expect(finalLine(staged)).toEqual({ result: "downloaded", version: NEW_VERSION, build: "vera-new", changed: false });
        expect(shellLabel(app)).toBe("shell-api-1");
        const cached = cachedShellTarball(setup.prefix, `v${NEW_VERSION}`, "darwin", "arm64");
        expect(existsSync(cached)).toBe(true);
        const check = await jsonRun(setup, feed, {}, "check");
        expect(check.lines[0]).toMatchObject({ status: "downloaded", latest_version: NEW_VERSION });

        // With the archive gone the check no longer calls the update downloaded.
        rmSync(cached);
        const missing = await jsonRun(setup, feed, {}, "check");
        expect(missing.lines[0]).toMatchObject({ status: "available" });

        const again = await jsonRun(setup, feed, { downloadOnly: true });
        expect(finalLine(again).result).toBe("downloaded");
        const onlyApi = Object.fromEntries(Object.entries(feed).filter(([url]) => !url.includes("vera-desktop-shell")
            && !url.includes("vera-darwin") && !url.includes("vera-desktop-darwin")));
        const switched = await jsonRun(setup, onlyApi);
        expect(finalLine(switched)).toMatchObject({ result: "done", changed: true });
        expect(shellLabel(app)).toBe("shell-api-2");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
    });
});

test("a check reports held when the installed app cannot take the package", async () => {
    await withDesktopUpdate(async (setup) => {
        writeShellApp(fixtureAppPath(setup.prefix), 1, { bundleId: "com.example.other" });
        const feed = feedWith(setup, 2);
        await jsonRun(setup, feed, { downloadOnly: true });
        const check = await jsonRun(setup, feed, {}, "check");
        expect(check.lines[0]).toMatchObject({ status: "held", latest_version: NEW_VERSION });
        expect(String(check.lines[0]!.message)).toContain("is not the Vera desktop app");
    });
});

test("an update that left the old app aside puts it back before it starts", async () => {
    await withDesktopUpdate(async (setup) => {
        const app = fixtureAppPath(setup.prefix);
        // Above the pid range of every platform the app runs on, so no process holds it.
        const gonePid = 4_194_303;
        const aside = join(dirname(app), `.Vera.app.old-${gonePid}`);
        writeShellApp(aside, 1, { label: "old-app" });
        const half = join(dirname(app), `.Vera.app.new-${gonePid}`);
        mkdirSync(half, { recursive: true });
        writeFileSync(join(half, "partial"), "x");
        sweepShellLeftovers(setup.prefix);
        expect(shellLabel(app)).toBe("old-app");
        expect(readdirSync(dirname(app))).toEqual(["Vera.app"]);
    });
});

test("a finished update removes an old app that was kept aside", async () => {
    await withDesktopUpdate(async (setup) => {
        const app = fixtureAppPath(setup.prefix);
        writeShellApp(app, 2, { label: "installed" });
        const aside = join(dirname(app), ".Vera.app.old-4194303");
        writeShellApp(aside, 1, { label: "old-app" });
        sweepShellLeftovers(setup.prefix);
        expect(shellLabel(app)).toBe("installed");
        expect(readdirSync(dirname(app))).toEqual(["Vera.app"]);
    });
});

test("the shell archive is requested only for the release being installed", async () => {
    await withDesktopUpdate(async (setup) => {
        writeShellApp(fixtureAppPath(setup.prefix), 1);
        const calls: string[] = [];
        const feed = feedWith(setup, 2, shellTarball(setup.root, 2));
        await jsonRun(setup, feed, { fetch: ((input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            calls.push(url);
            const route = feed[url];
            return Promise.resolve(route === undefined
                ? new Response("not found", { status: 404 })
                : new Response(route.body ?? "", { status: route.status ?? 200 }));
        }) as typeof fetch });
        expect(calls.filter((url) => url.endsWith(SHELL_ASSET))).toEqual([desktopAssetUrl(NEW_VERSION, SHELL_ASSET)]);
        expect(readdirSync(releasesDirectory(setup.prefix)).sort()).toEqual(["vera-new", "vera-old"]);
    });
});

test("the app is replaced by an exchange, and by two renames where the volume cannot exchange", async () => {
    for (const swap of [swapPaths, () => false]) {
        await withDesktopUpdate(async (setup) => {
            const app = fixtureAppPath(setup.prefix);
            writeShellApp(app, 1);
            const staged = await stageShell({
                kind: "swap",
                appPath: app,
                tarball: shellTarball(setup.root, 2),
                requiredApi: 2,
                version: NEW_VERSION,
            }, setup.prefix, undefined, swap);
            expect(shellLabel(app)).toBe("shell-api-1");
            expect(leftovers(setup).some((name) => name.startsWith(".Vera.app.new-"))).toBe(true);
            staged.commit();
            expect(shellLabel(app)).toBe("shell-api-2");
            expect(leftovers(setup)).toEqual([]);
        });
    }
});

test("a discarded shell leaves the installed app and no staging beside it", async () => {
    await withDesktopUpdate(async (setup) => {
        const app = fixtureAppPath(setup.prefix);
        writeShellApp(app, 1);
        const staged = await stageShell({
            kind: "swap",
            appPath: app,
            tarball: shellTarball(setup.root, 2),
            requiredApi: 2,
            version: NEW_VERSION,
        }, setup.prefix);
        staged.discard();
        expect(shellLabel(app)).toBe("shell-api-1");
        expect(leftovers(setup)).toEqual([]);
    });
});

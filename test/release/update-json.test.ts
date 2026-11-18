import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { installRelease } from "../../src/release/install.ts";
import {
    currentReleaseBuildId,
    releasesDirectory,
    rollbackSymlinkPath,
} from "../../src/release/layout.ts";
import {
    API,
    NEW_VERSION,
    assetUrl,
    desktopRoutes,
    desktopTarball,
    fakeFetch,
    releaseJson,
    streamedBody,
    withDesktopUpdate,
} from "./update-fixtures.ts";
import { finalLine, jsonRun } from "./update-json-support.ts";

test("@core a check prints one JSON object and exits 0 for each state", async () => {
    await withDesktopUpdate(async (setup) => {
        const available = await jsonRun(setup, setup.feed(), {}, "check");
        expect(available.exit).toBe(0);
        expect(available.lines).toEqual([{
            status: "available",
            current_version: "0.1.0-alpha.1",
            current_build: "vera-old",
            latest_version: NEW_VERSION,
        }]);

        const current = await jsonRun(setup, { [API]: { body: releaseJson({ version: "0.1.0-alpha.1" }) } }, {}, "check");
        expect(current.lines).toEqual([{
            status: "up_to_date",
            current_version: "0.1.0-alpha.1",
            current_build: "vera-old",
            latest_version: "0.1.0-alpha.1",
        }]);

        const offline = await jsonRun(setup, { [API]: { status: 503, body: "down" } }, {}, "check");
        expect(offline.exit).toBe(0);
        expect(offline.lines).toHaveLength(1);
        expect(offline.lines[0]).toMatchObject({ status: "unavailable", current_version: "0.1.0-alpha.1" });
        expect(String(offline.lines[0]!.message)).toContain("HTTP 503");

        const checkout = await jsonRun(setup, setup.feed(), { running: undefined, prefix: undefined }, "check");
        expect(checkout.exit).toBe(0);
        expect(checkout.lines[0]).toMatchObject({ status: "unavailable", current_version: "", current_build: "" });
        expect(String(checkout.lines[0]!.message)).toContain("bun run install:local");
    });
});

test("@core a staged release is downloaded, and one with no desktop package is held", async () => {
    await withDesktopUpdate(async (setup) => {
        const held = await jsonRun(setup, setup.feed(), { downloadOnly: true });
        expect(finalLine(held)).toMatchObject({ result: "held", version: NEW_VERSION, build: "vera-new", changed: false });
        const heldCheck = await jsonRun(setup, setup.feed(), {}, "check");
        expect(heldCheck.lines[0]).toMatchObject({ status: "held", latest_version: NEW_VERSION });
        expect(String(heldCheck.lines[0]!.message)).toContain("desktop app");

        const desktop = desktopTarball(setup.root, "vera-new", NEW_VERSION);
        const routes = { ...setup.feed(), ...desktopRoutes(NEW_VERSION, desktop) };
        const staged = await jsonRun(setup, routes, { downloadOnly: true });
        expect(finalLine(staged)).toEqual({ result: "downloaded", version: NEW_VERSION, build: "vera-new", changed: false });
        expect(staged.exit).toBe(0);
        const check = await jsonRun(setup, routes, {}, "check");
        expect(check.lines[0]).toMatchObject({ status: "downloaded", latest_version: NEW_VERSION });
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
    });
});

test("@core download only stages the host and desktop package, and the next update only switches", async () => {
    await withDesktopUpdate(async (setup) => {
        const desktop = desktopTarball(setup.root, "vera-new", NEW_VERSION);
        const routes = { ...setup.feed(), ...desktopRoutes(NEW_VERSION, desktop) };
        const staged = await jsonRun(setup, routes, { downloadOnly: true });
        expect(finalLine(staged).result).toBe("downloaded");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        expect(existsSync(rollbackSymlinkPath(setup.prefix))).toBe(false);
        expect(readdirSync(releasesDirectory(setup.prefix)).sort()).toEqual(["vera-new", "vera-old"]);

        // Only the release list is reachable now: a switch needs no other download.
        const switched = await jsonRun(setup, { [API]: routes[API]! });
        expect(switched.lines.map((line) => line.phase ?? line.result)).toEqual(["checking", "switching", "done"]);
        expect(finalLine(switched)).toEqual({ result: "done", version: NEW_VERSION, build: "vera-new", changed: true });
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
    });
});

test("@core an update prints progress lines in order and ends with exactly one result", async () => {
    await withDesktopUpdate(async (setup) => {
        const desktop = desktopTarball(setup.root, "vera-new", NEW_VERSION);
        const routes = { ...setup.feed(), ...desktopRoutes(NEW_VERSION, desktop) };
        const run = await jsonRun(setup, routes);
        expect(run.exit).toBe(0);
        const names = run.lines.map((line) => line.phase ?? line.result);
        expect(names[0]).toBe("checking");
        expect(names.at(-2)).toBe("switching");
        expect(names.at(-1)).toBe("done");
        expect(names.filter((name) => name === "done")).toHaveLength(1);
        expect(names.slice(1, -2).every((name) => name === "downloading")).toBe(true);
        expect(finalLine(run)).toEqual({ result: "done", version: NEW_VERSION, build: "vera-new", changed: true });
        expect(run.notes).toBeString();
    });
});

test("download progress adds up across files and carries the declared total", async () => {
    await withDesktopUpdate(async (setup) => {
        const hostBytes = new Uint8Array(readFileSync(setup.tarball));
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                if (path === "/api") return new Response(releaseJson({ version: NEW_VERSION }));
                const file = path.split("/").pop()!;
                if (file === "vera-darwin-arm64.tar.gz") return new Response(hostBytes);
                if (file === "vera-darwin-arm64.tar.gz.sha256") {
                    return new Response(setup.feed()[`${assetUrl(NEW_VERSION)}.sha256`]!.body as string);
                }
                return new Response("not found", { status: 404 });
            },
        });
        try {
            const run = await jsonRun(setup, {}, {
                fetch: undefined,
                releasesApi: `http://localhost:${server.port}/api`,
                downloadBase: `http://localhost:${server.port}/mirror`,
                downloadOnly: true,
                running: { root: setup.oldRoot, prefix: setup.prefix, version: "0.1.0-alpha.1", buildId: "vera-old" },
                platform: "darwin",
                arch: "arm64",
            });
            const progress = run.lines.filter((line) => line.phase === "downloading");
            expect(progress.length).toBeGreaterThan(0);
            expect(progress.at(-1)).toMatchObject({ bytes: hostBytes.length, total: hostBytes.length });
            expect(finalLine(run).result).toBe("held");
        } finally {
            server.stop(true);
        }
    });
});

test("@core a failed update ends failed with nothing changed, and a retry completes", async () => {
    await withDesktopUpdate(async (setup) => {
        const bad = { ...setup.feed(), [`${assetUrl(NEW_VERSION)}.sha256`]: { body: `${"0".repeat(64)}  x\n` } };
        const failed = await jsonRun(setup, bad);
        expect(failed.exit).toBe(1);
        expect(finalLine(failed)).toMatchObject({ result: "failed", changed: false });
        expect(String(finalLine(failed).message)).toContain("Checksum mismatch");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        expect(readdirSync(releasesDirectory(setup.prefix))).toEqual(["vera-old"]);

        const retry = await jsonRun(setup, setup.feed(), {}, "update");
        expect(finalLine(retry)).toMatchObject({ result: "done", changed: true });
    }, { recorded: false });
});

test("@core cancel before the switch ends cancelled, changes nothing and leaves no staging", async () => {
    await withDesktopUpdate(async (setup) => {
        const controller = new AbortController();
        const hostBytes = new Uint8Array(readFileSync(setup.tarball));
        const stalling = {
            ...setup.feed(),
            [assetUrl(NEW_VERSION)]: { body: streamedBody(hostBytes, 40, true) as unknown as Uint8Array },
        };
        const run = jsonRun(setup, stalling, {
            signal: controller.signal,
            timeoutMs: 60_000,
            fetch: (async (input: string | URL | Request) => {
                const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
                if (url === assetUrl(NEW_VERSION)) {
                    return new Response(streamedBody(hostBytes, 40, true));
                }
                return fakeFetch(stalling)(input);
            }) as typeof fetch,
            onProgress: () => controller.abort(),
        });
        const result = await run;
        expect(finalLine(result)).toEqual({ result: "cancelled", changed: false });
        expect(result.exit).toBe(1);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        expect(readdirSync(releasesDirectory(setup.prefix))).toEqual(["vera-old"]);
        expect(result.lines.some((line) => line.phase === "switching")).toBe(false);
    }, { recorded: false });
});

test("@core a signal after switching is ignored and the switch runs to the end", async () => {
    await withDesktopUpdate(async (setup) => {
        let sawSignalDuringSwitch = false;
        const run = await jsonRun(setup, setup.feed(), {
            install: async (options) => {
                process.emit("SIGTERM");
                process.emit("SIGINT");
                sawSignalDuringSwitch = true;
                return await installRelease({ ...options, readLiveHost: async () => undefined });
            },
        });
        expect(sawSignalDuringSwitch).toBe(true);
        expect(finalLine(run)).toMatchObject({ result: "done", changed: true });
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
    }, { recorded: false });
});

test("a signal before the switch cancels through the process handlers", async () => {
    await withDesktopUpdate(async (setup) => {
        const run = await jsonRun(setup, setup.feed(), {
            onPhase: (phase) => {
                if (phase.phase === "checking") process.emit("SIGTERM");
            },
        });
        expect(finalLine(run)).toEqual({ result: "cancelled", changed: false });
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
    }, { recorded: false });
});

test("handlers are removed once the run ends", async () => {
    await withDesktopUpdate(async (setup) => {
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
        await jsonRun(setup, setup.feed());
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    }, { recorded: false });
});

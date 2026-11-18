import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireHostStartupClaim } from "../../src/host/startup-claim.ts";
import { activateRelease, repointRollbackLink } from "../../src/release/activate.ts";
import { reconcileColdHost } from "../../src/release/cold-host-reconcile.ts";
import { downloadToFile } from "../../src/release/download.ts";
import {
    currentReleaseBuildId,
    desktopPackagesDirectory,
    launcherPath,
    releaseDirectory,
    releasesDirectory,
    rollbackReleaseBuildId,
    veraShareRoot,
} from "../../src/release/layout.ts";
import { rollbackLocalInstall } from "../../src/release/rollback.ts";
import { sweepStaleStaging } from "../../src/release/staging-sweep.ts";
import { acquireUpdateLock, updateLockPath, UpdateInProgressError } from "../../src/release/update-lock.ts";
import { runUpdateCheckJson } from "../../src/release/update-json.ts";
import { readUpgradeJournal, recoverInterruptedUpgrade, writeUpgradeJournal } from "../../src/release/upgrade.ts";
import { runUpdate } from "../../src/release/update.ts";
import {
    NEW_VERSION,
    assetUrl,
    prefixWithOldRelease,
    withDesktopUpdate,
    withTempEnvironment,
    writeVerifiableRelease,
} from "./update-fixtures.ts";
import { baseOptions, finalLine, jsonRun } from "./update-json-support.ts";

const GONE_PID = 4_194_303;

test("@core a second update or rollback while one runs is refused, and the lock is released after", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-lock-"));
    try {
        const release = acquireUpdateLock(root);
        const refused = (() => { try { acquireUpdateLock(root); } catch (error) { return error; } })();
        expect(refused).toBeInstanceOf(UpdateInProgressError);
        expect((refused as Error).message).toContain("Another vera update or rollback is running");
        release();
        expect(existsSync(updateLockPath(root))).toBe(false);
        acquireUpdateLock(root)();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a lock left by a process that is gone, or held for hours, is taken over", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-lock-"));
    try {
        const write = (pid: number, createdAt: string): void => {
            mkdirSync(veraShareRoot(root), { recursive: true });
            writeFileSync(updateLockPath(root), `${JSON.stringify({ pid, token: "t", created_at: createdAt })}\n`);
        };
        write(GONE_PID, new Date().toISOString());
        acquireUpdateLock(root)();
        write(process.pid, new Date(Date.now() - 7 * 60 * 60_000).toISOString());
        acquireUpdateLock(root)();
        writeFileSync(updateLockPath(root), "not json");
        acquireUpdateLock(root)();
        expect(existsSync(updateLockPath(root))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("giving up a lock that was taken over leaves the new holder's lock alone", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-lock-"));
    try {
        const first = acquireUpdateLock(root, { isAlive: () => true, now: () => Date.now() });
        const taken = acquireUpdateLock(root, { isAlive: () => false });
        first();
        expect(existsSync(updateLockPath(root))).toBe(true);
        taken();
        expect(existsSync(updateLockPath(root))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core an update that finds another running ends failed with nothing changed, and runs once it is over", async () => {
    await withDesktopUpdate(async (setup) => {
        const release = acquireUpdateLock(setup.prefix);
        const blocked = await jsonRun(setup, setup.feed());
        expect(finalLine(blocked)).toMatchObject({ result: "failed", changed: false });
        expect(String(finalLine(blocked).message)).toContain("Another vera update or rollback is running");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        expect(readdirSync(releasesDirectory(setup.prefix))).toEqual(["vera-old"]);
        await expect(rollbackLocalInstall(setup.prefix, {
            drainHost: async () => "absent",
            startHost: async () => undefined,
        })).rejects.toBeInstanceOf(UpdateInProgressError);
        release();
        const retry = await jsonRun(setup, setup.feed());
        expect(finalLine(retry)).toMatchObject({ result: "done", changed: true });
    }, { recorded: false });
});

test("a check runs while an update holds the lock", async () => {
    await withDesktopUpdate(async (setup) => {
        const release = acquireUpdateLock(setup.prefix);
        try {
            const check = await jsonRun(setup, setup.feed(), {}, "check");
            expect(check.lines[0]).toMatchObject({ status: "available" });
        } finally {
            release();
        }
    }, { recorded: false });
});

test("the sweep removes what a dead update left and nothing a live one owns", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-sweep-"));
    try {
        const { prefix } = prefixWithOldRelease(root);
        const releases = releasesDirectory(prefix);
        const share = veraShareRoot(prefix);
        const packages = join(desktopPackagesDirectory(prefix), "vera-old");
        mkdirSync(packages, { recursive: true });
        const mine = process.pid;
        const dead = [
            join(releases, `.staging-${GONE_PID}-update`),
            join(packages, `.tmp-${GONE_PID}-abcd`),
        ];
        const live = [
            join(releases, `.staging-${mine}-update`),
            join(packages, `.tmp-${mine}-abcd`),
            join(releases, ".install-XXXXXX"),
        ];
        for (const path of [...dead, ...live]) {
            mkdirSync(path, { recursive: true });
            writeFileSync(join(path, "file"), "x");
        }
        const links = [join(share, `.current.${GONE_PID}`), join(share, `.rollback.${GONE_PID}`), join(share, `.current.${mine}`)];
        const launcherTemp = [`${launcherPath(prefix)}.${GONE_PID}.tmp`, `${launcherPath(prefix)}.${mine}.tmp`];
        for (const path of [...links, ...launcherTemp]) writeFileSync(path, "x");
        const oldLock = join(share, ".update.lock.old.tmp");
        const newLock = join(share, ".update.lock.new.tmp");
        writeFileSync(oldLock, "x");
        writeFileSync(newLock, "x");
        const past = new Date(Date.now() - 10 * 60_000);
        utimesSync(oldLock, past, past);

        sweepStaleStaging(prefix);

        for (const path of [...dead, links[0]!, links[1]!, launcherTemp[0]!, oldLock]) expect(existsSync(path), path).toBe(false);
        for (const path of [...live, links[2]!, launcherTemp[1]!, newLock]) expect(existsSync(path), path).toBe(true);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a download that ends before its declared length is an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-short-"));
    try {
        const fetchShort = (async () => new Response(new Uint8Array(10), { headers: { "content-length": "25" } })) as unknown as typeof fetch;
        await expect(downloadToFile("https://x.test/a.tar.gz", join(root, "a"), { fetch: fetchShort }))
            .rejects.toThrow("Download of https://x.test/a.tar.gz ended early: 10 of 25 bytes.");
        const whole = (async () => new Response(new Uint8Array(25), { headers: { "content-length": "25" } })) as unknown as typeof fetch;
        await downloadToFile("https://x.test/a.tar.gz", join(root, "b"), { fetch: whole });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a connection that drops mid-download or a file that arrives short changes nothing, and a retry completes", async () => {
    await withDesktopUpdate(async (setup) => {
        const bytes = new Uint8Array(await Bun.file(setup.tarball).arrayBuffer());
        const feed = setup.feed();
        const respond = (input: string | URL | Request, body: (url: string) => Response | undefined): Response => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            return body(url) ?? new Response(feed[url]?.body ?? "not found", { status: feed[url] === undefined ? 404 : 200 });
        };
        const dropped = (async (input: string | URL | Request) => respond(input, (url) => {
            if (url !== assetUrl(NEW_VERSION)) return undefined;
            let sent = false;
            return new Response(new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (sent) controller.error(new Error("connection reset"));
                    else { sent = true; controller.enqueue(bytes.slice(0, 100)); }
                },
            }));
        })) as typeof fetch;
        const short = (async (input: string | URL | Request) => respond(input, (url) => url === assetUrl(NEW_VERSION)
            ? new Response(bytes.slice(0, 100), { headers: { "content-length": String(bytes.length) } })
            : undefined)) as typeof fetch;
        for (const fetchImpl of [dropped, short]) {
            const failed = await jsonRun(setup, feed, { fetch: fetchImpl });
            expect(finalLine(failed)).toMatchObject({ result: "failed", changed: false });
            expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
            expect(readdirSync(releasesDirectory(setup.prefix))).toEqual(["vera-old"]);
        }
        const retry = await jsonRun(setup, feed);
        expect(finalLine(retry)).toMatchObject({ result: "done", changed: true });
    }, { recorded: false });
});

test("a stalled update check reports unavailable inside its limit", async () => {
    await withDesktopUpdate(async (setup) => {
        const out: string[] = [];
        const started = Date.now();
        await withTempEnvironment(join(setup.root, "home"), () => runUpdateCheckJson({
            ...baseOptions(setup, setup.feed()),
            fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
            timeoutMs: 60_000,
            checkLimitMs: 150,
            output: (text) => out.push(text),
        }));
        expect(Date.now() - started).toBeLessThan(5_000);
        const status = JSON.parse(out.join("")) as Record<string, unknown>;
        expect(status.status).toBe("unavailable");
        expect(String(status.message)).toContain("The update check took longer than");
    }, { recorded: false });
});

test("a run that outlasts its limit before the switch ends failed with nothing changed", async () => {
    await withDesktopUpdate(async (setup) => {
        const run = await jsonRun(setup, setup.feed(), {
            fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
            timeoutMs: 60_000,
            runLimitMs: 300,
        });
        expect(finalLine(run)).toMatchObject({ result: "failed", changed: false });
        expect(String(finalLine(run).message)).toContain("The update ran longer than 1 second");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
    }, { recorded: false });
});

test("the wait for a booting host ends at its cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-reconcile-"));
    try {
        const home = join(root, "home");
        mkdirSync(home, { recursive: true });
        const { prefix } = prefixWithOldRelease(root);
        await withTempEnvironment(home, async () => {
            const claim = await acquireHostStartupClaim({ path: join(home, "boot.lock"), maxClaimAgeMs: 15 * 60_000 });
            try {
                const started = Date.now();
                await reconcileColdHost(prefix, async () => undefined, async () => undefined, 600);
                const waited = Date.now() - started;
                expect(waited).toBeGreaterThanOrEqual(500);
                expect(waited).toBeLessThan(5_000);
            } finally {
                await claim.release();
            }
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core recovery puts the rollback pin back when the switch it undoes had moved it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-pin-"));
    try {
        const { prefix } = prefixWithOldRelease(root);
        await withTempEnvironment(join(root, "home"), async () => {
            for (const [name, version] of [["vera-b", "0.1.0-alpha.2"], ["vera-c", "0.1.0-alpha.3"]] as const) {
                writeVerifiableRelease(releaseDirectory(name, prefix), name, version);
            }
            activateRelease(releaseDirectory("vera-b", prefix), prefix);
            expect([currentReleaseBuildId(prefix), rollbackReleaseBuildId(prefix)]).toEqual(["vera-b", "vera-old"]);
            // The state a kill leaves between the two link writes: the pin already names what stays current.
            writeUpgradeJournal({
                phase: "activating",
                from_build_id: "vera-b",
                to_build_id: "vera-c",
                host_was_running: false,
                previous_pin: "vera-old",
            }, prefix);
            repointRollbackLink("vera-b", prefix);
            expect(rollbackReleaseBuildId(prefix)).toBe("vera-b");

            const recovered = await recoverInterruptedUpgrade({ prefix, startHost: async () => undefined, operation: "install" });
            expect(recovered.recovered).toBe(true);
            expect([currentReleaseBuildId(prefix), rollbackReleaseBuildId(prefix)]).toEqual(["vera-b", "vera-old"]);
            expect(await readUpgradeJournal(prefix)).toBeUndefined();
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the text update prints the wait once for each set of sessions and ends with the held message", async () => {
    await withDesktopUpdate(async (setup) => {
        const output: string[] = [];
        let now = 0;
        const sessions = [{ id: "a1", title: "Fix the build" }];
        const code = await withTempEnvironment(join(setup.root, "home"), () => runUpdate({
            ...baseOptions(setup, setup.feed()),
            output: (text) => output.push(text),
            idle: {
                readLiveHost: async () => ({
                    schema_version: 3, pid: GONE_PID, started_at: "x", socket_path: "/none", build_id: "vera-old",
                }),
                listBusy: async () => sessions,
                limitMs: 4_000,
                pollMs: 1_000,
                now: () => now,
                sleep: async (ms) => { now += ms; },
            },
        }));
        expect(code).toBe(0);
        const text = output.join("");
        expect(text.match(/Waiting for Fix the build/g)).toHaveLength(1);
        expect(text).toContain("Waiting for Fix the build to finish before updating (up to 4 seconds). Press Ctrl-C to stop waiting.");
        expect(text).toContain("Vera is still busy after 4 seconds: Fix the build. Nothing was changed.");
    }, { recorded: false });
});

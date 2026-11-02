import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    STALE_TEST_ROOT_AGE_MS,
    sweepStaleTestRoots,
} from "./temp-root.ts";

const LEAK_CHILD = "VERA_TEMP_ROOT_LEAK_CHILD";

function makeDir(parent: string, name: string, ageMs: number): string {
    const path = join(parent, name);
    mkdirSync(path);
    writeFileSync(join(path, "file"), "x");
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
    return path;
}

if (process.env[LEAK_CHILD] !== undefined) {
    test("leaves a temp dir behind on purpose", () => {
        mkdtempSync(join(tmpdir(), "vera-leak-"));
    });
} else {
    const stale = STALE_TEST_ROOT_AGE_MS + 60_000;

    test("sweep removes only stale roots with the exact root name", () => {
        const parent = mkdtempSync(join(tmpdir(), "sweep-"));
        const oldRoot = makeDir(parent, "vt-aB3xY9", stale);
        const freshRoot = makeDir(parent, "vt-Zz09aa", 1_000);
        const production = [
            "vera-session-trash-aB3xY9",
            "vera-ephemeral-agent-aB3xY9",
            "vera-sdk-aB3xY9",
            "vera-sdk-instance-aB3xY9",
            "vera-npm-package-aB3xY9",
            "vera-npm-validate-aB3xY9",
            "vera-shot-chrome-aB3xY9",
            "vera-usage-shot-aB3xY9",
            "vera-dev",
            "vera-dropped-images",
            "vt-short",
            "vt-toolonglong",
            "other-aB3xY9",
        ].map((name) => makeDir(parent, name, stale));
        const nested = makeDir(oldRoot, "vt-nested", stale);
        // Adding the child touched the parent; age it again.
        const when = new Date(Date.now() - stale);
        utimesSync(oldRoot, when, when);

        const removed = sweepStaleTestRoots(parent);

        expect(removed).toEqual([oldRoot]);
        expect(existsSync(oldRoot)).toBe(false);
        expect(existsSync(nested)).toBe(false);
        expect(existsSync(freshRoot)).toBe(true);
        for (const path of production) {
            expect(existsSync(path)).toBe(true);
        }
    });

    test("sweep ignores a plain file with a root name", () => {
        const parent = mkdtempSync(join(tmpdir(), "sweep-"));
        const file = join(parent, "vt-aB3xY9");
        writeFileSync(file, "x");
        const when = new Date(Date.now() - stale);
        utimesSync(file, when, when);

        expect(sweepStaleTestRoots(parent)).toEqual([]);
        expect(existsSync(file)).toBe(true);
    });

    test("sweep of a missing parent removes nothing", () => {
        expect(sweepStaleTestRoots(join(tmpdir(), "does-not-exist"))).toEqual([]);
    });

    test("a test run leaves nothing in its temp dir", async () => {
        const scratch = mkdtempSync(join(tmpdir(), "run-"));
        const veraHome = mkdtempSync(join(tmpdir(), "run-home-"));
        const child = Bun.spawn(["bun", "test", import.meta.path], {
            env: {
                ...process.env,
                TMPDIR: scratch,
                VERA_HOME: veraHome,
                [LEAK_CHILD]: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [code, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
        ]);

        expect(stderr).toContain("1 pass");
        expect(code).toBe(0);
        expect(readdirSync(scratch)).toEqual([]);
    }, 60_000);
}

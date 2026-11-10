import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One temp root per test process. Every `tmpdir()` call after
 * `enterTestTempRoot` resolves inside it, so a single `rmSync` at the end of
 * the run removes everything the suite created.
 *
 * The prefix is short on purpose: the host socket lives at
 * `<home>/runtime/host.sock` and unix socket paths top out near 103 bytes.
 */
export const TEST_TEMP_ROOT_PREFIX = "vt-";

// mkdtemp appends exactly six characters from this alphabet.
const TEST_TEMP_ROOT_NAME = /^vt-[A-Za-z0-9]{6}$/;

export const STALE_TEST_ROOT_AGE_MS = 60 * 60 * 1000;

export interface TestTempRoot {
    readonly path: string;
    remove(): void;
}

/**
 * `tmpdir()` on macOS sits under `/var/folders/...`, which leaves no room for
 * a host socket under the 104-byte limit, so roots go under `/tmp` when present.
 */
export function testTempBase(): string {
    const configured = process.env.VERA_TEST_TEMP_BASE;
    if (configured !== undefined && configured.length > 0) return configured;
    return existsSync("/tmp") ? "/tmp" : tmpdir();
}

/** Points `TMPDIR` at a fresh root; children spawned later inherit it. */
export function enterTestTempRoot(): TestTempRoot {
    const path = realpathSync(mkdtempSync(join(testTempBase(), TEST_TEMP_ROOT_PREFIX)));
    process.env.TMPDIR = path;
    return {
        path,
        remove() {
            rmSync(path, { recursive: true, force: true });
        },
    };
}

/**
 * Removes roots left by runs that were killed before their `afterAll`.
 * Only direct children of `parent` that match the root name exactly and have
 * not been modified within `maxAgeMs` are touched.
 */
export function sweepStaleTestRoots(
    parent: string,
    now: number = Date.now(),
    maxAgeMs: number = STALE_TEST_ROOT_AGE_MS,
): readonly string[] {
    const removed: string[] = [];
    let names: string[];
    try {
        names = readdirSync(parent);
    } catch {
        return removed;
    }
    for (const name of names) {
        if (!TEST_TEMP_ROOT_NAME.test(name)) continue;
        const path = join(parent, name);
        try {
            const stat = statSync(path);
            if (!stat.isDirectory() || now - stat.mtimeMs <= maxAgeMs) continue;
            rmSync(path, { recursive: true, force: true });
            removed.push(path);
        } catch {
            // Another process removed it first, or it is not ours to read.
        }
    }
    return removed;
}

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    PreimageStash,
    stashKey,
    sweepStaleStashes,
} from "../../src/store/preimage-stash.ts";

async function withRoot(
    run: (root: string) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "vera-stash-"));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("capture writes the pre-image blob and sidecar", async () => {
    await withRoot(async (root) => {
        const stash = new PreimageStash("session-1", root);
        await stash.capture("/vault/plan.md", "original content\n");

        const key = stashKey("/vault/plan.md");
        const blob = await Bun.file(join(root, "session-1", key)).text();
        expect(blob).toBe("original content\n");

        const sidecar = await Bun.file(
            join(root, "session-1", `${key}.json`),
        ).json();
        expect(sidecar).toMatchObject({
            path: "/vault/plan.md",
            sessionId: "session-1",
            bytes: 17,
        });
        expect(typeof sidecar.capturedAt).toBe("string");
    });
});

test("the first capture for a path wins within a session", async () => {
    await withRoot(async (root) => {
        const stash = new PreimageStash("session-1", root);
        await stash.capture("/vault/plan.md", "good version");
        await stash.capture("/vault/plan.md", "clobbered stub");

        const key = stashKey("/vault/plan.md");
        const blob = await Bun.file(join(root, "session-1", key)).text();
        expect(blob).toBe("good version");
    });
});

test("distinct paths capture independently", async () => {
    await withRoot(async (root) => {
        const stash = new PreimageStash("session-1", root);
        await stash.capture("/a.md", "content a");
        await stash.capture("/b.md", "content b");

        const entries = await readdir(join(root, "session-1"));
        expect(entries.length).toBe(4);
    });
});

test("a session that captures nothing leaves no directory", async () => {
    await withRoot(async (root) => {
        void new PreimageStash("session-1", root);
        expect(await readdir(root)).toEqual([]);
    });
});

test("oversized contents are skipped", async () => {
    await withRoot(async (root) => {
        const stash = new PreimageStash("session-1", root);
        const huge = "x".repeat(51 * 1024 * 1024);
        await stash.capture("/vault/huge.bin", huge);
        expect(await readdir(root)).toEqual([]);
    });
});

test("sweep removes only directories older than the retention age", async () => {
    await withRoot(async (root) => {
        await mkdir(join(root, "old-session"));
        await mkdir(join(root, "new-session"));
        const now = Date.now();
        const { utimes } = await import("node:fs/promises");
        const stale = new Date(now - 31 * 24 * 60 * 60 * 1000);
        await utimes(join(root, "old-session"), stale, stale);

        await sweepStaleStashes(root, 30, now);
        expect(await readdir(root)).toEqual(["new-session"]);
    });
});

test("sweep of a missing root is a no-op", async () => {
    await sweepStaleStashes(join(tmpdir(), "vera-stash-none"), 30);
});

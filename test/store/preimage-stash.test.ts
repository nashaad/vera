import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    PreimageStash,
    SessionChangedFileCounts,
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

test("summarizeStash reports sessions, blobs, bytes, and the oldest capture", async () => {
    await withRoot(async (root) => {
        const { summarizeStash } = await import(
            "../../src/store/preimage-stash.ts"
        );
        expect(summarizeStash(root)).toBeUndefined();

        const first = new PreimageStash("session-1", root);
        await first.capture("/a.md", "content a");
        const second = new PreimageStash("session-2", root);
        await second.capture("/b.md", "longer content b");

        const summary = summarizeStash(root);
        expect(summary).toMatchObject({
            sessions: 2,
            preimages: 2,
            bytes: 25,
        });
        expect(typeof summary?.oldestCapturedAt).toBe("string");
    });
});


test("cached stash counts follow captures, incomplete sidecars, removal and root changes", async () => {
    await withRoot(async (root) => {
        const counts = new SessionChangedFileCounts();
        expect(counts.read("crow", root)).toBe(0);
        const stash = new PreimageStash("crow", root);
        await stash.capture("/crow.txt", "pirate crow");
        expect(counts.read("crow", root)).toBe(1);
        expect(counts.read("crow", root)).toBe(1);
        const path = join(stash.directory, "incomplete.json");
        await Bun.write(path, "{");
        expect(counts.read("crow", root)).toBe(1);
        await Bun.write(path, JSON.stringify({ path: "/nest.txt", sessionId: "crow", capturedAt: new Date().toISOString(), bytes: 3 }));
        expect(counts.read("crow", root)).toBe(2);
        expect(counts.read("crow", join(root, "elsewhere"))).toBe(0);
        expect(counts.read("crow", root)).toBe(2);
        await rm(stash.directory, { recursive: true });
        expect(counts.read("crow", root)).toBe(0);
        await new PreimageStash("crow", root).capture("/feather.txt", "crow");
        expect(counts.read("crow", root)).toBe(1);
    });
});

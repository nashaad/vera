import { describe, expect, test } from "bun:test";

import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Inbox } from "../../src/store/inbox.ts";
import { WatchAdmission } from "../../src/watch/admission.ts";
import {
    createFilesystemConnector,
    listingDigest,
    parseFilesystemConfig,
    MIN_INTERVAL_MS,
    FILESYSTEM_SOURCE_FAMILY,
} from "../../src/watch/filesystem-connector.ts";
import {
    WatchFatalError,
    type SourceCheckpoint,
    type SourceEvent,
    type WatchRuntimeContext,
} from "../../src/watch/source.ts";
import type { JsonObject } from "../../src/extensions/contributions.ts";

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "vera-fswatch-"));
}

function context(
    inbox: Inbox,
    config: JsonObject,
    controller: AbortController,
): { context: WatchRuntimeContext; admission: WatchAdmission } {
    const admission = new WatchAdmission({
        inbox,
        watchId: "vera.coord/files",
        address: "coordinator",
        flood: "shed",
    });
    return {
        admission,
        context: {
            watchId: "vera.coord/files",
            sourceFamily: FILESYSTEM_SOURCE_FAMILY,
            config,
            address: "coordinator",
            flood: "shed",
            signal: controller.signal,
            cursor: (): string | null => admission.cursor(),
            admit: async (events: readonly SourceEvent[]): Promise<void> => {
                admission.admit(events);
            },
            checkpoint: (checkpoint: SourceCheckpoint): void => {
                admission.checkpoint(checkpoint.cursor);
            },
            recordGap: (): void => undefined,
            healthy: (): void => undefined,
        },
    };
}

/** Runs the poll loop for a fixed number of passes, then aborts it. */
function steppedSleep(
    controller: AbortController,
    passes: number,
    between: (pass: number) => void,
): (ms: number, signal: AbortSignal) => Promise<void> {
    let seen = 0;
    return async () => {
        seen += 1;
        if (seen >= passes) {
            controller.abort();
            return;
        }
        between(seen);
    };
}

describe("filesystem watch config", () => {
    test("a missing path is a configuration failure, not a retry", () => {
        expect(() => parseFilesystemConfig({})).toThrow(WatchFatalError);
    });

    test("an interval below the floor is raised rather than honoured", () => {
        expect(parseFilesystemConfig({ path: "/tmp", interval_ms: 1 }).intervalMs)
            .toBe(MIN_INTERVAL_MS);
    });

    test("recursive defaults to off", () => {
        expect(parseFilesystemConfig({ path: "/tmp" }).recursive).toBe(false);
    });

    test("a non-boolean recursive is rejected", () => {
        expect(() => parseFilesystemConfig({ path: "/tmp", recursive: "yes" }))
            .toThrow(WatchFatalError);
    });
});

describe("listing digest", () => {
    test("a missing directory is empty rather than an error", async () => {
        const dir = tempDir();
        const result = await listingDigest(join(dir, "absent"), false);
        expect(result.count).toBe(0);
        rmSync(dir, { recursive: true });
    });

    test("content changes move the digest even when size holds", async () => {
        const dir = tempDir();
        writeFileSync(join(dir, "a.json"), "aaaa");
        const first = await listingDigest(dir, false);
        writeFileSync(join(dir, "b.json"), "bbbb");
        const second = await listingDigest(dir, false);
        expect(second.digest).not.toBe(first.digest);
        expect(second.count).toBe(2);
        rmSync(dir, { recursive: true });
    });

    test("nested files count only when recursive is asked for", async () => {
        const dir = tempDir();
        mkdirSync(join(dir, "nested"));
        writeFileSync(join(dir, "nested", "c.json"), "c");
        expect((await listingDigest(dir, false)).count).toBe(0);
        expect((await listingDigest(dir, true)).count).toBe(1);
        rmSync(dir, { recursive: true });
    });
});

describe("symlinks in the listing", () => {
    // The sibling name starts with the watched name to catch a bare prefix check.
    function layout(): { base: string; watched: string; sibling: string } {
        const base = tempDir();
        const watched = join(base, "watch");
        const sibling = join(base, "watch-other");
        mkdirSync(watched);
        mkdirSync(sibling);
        return { base, watched, sibling };
    }

    test("a link to a sibling directory is not walked when recursive", async () => {
        const { base, watched, sibling } = layout();
        writeFileSync(join(sibling, "outside.json"), "one");
        symlinkSync(sibling, join(watched, "via"));

        const first = await listingDigest(watched, true);
        writeFileSync(join(sibling, "outside.json"), "two, and longer");
        const second = await listingDigest(watched, true);

        expect(first.count).toBe(0);
        expect(second.digest).toBe(first.digest);
        rmSync(base, { recursive: true, force: true });
    });

    test("a link to a file outside the path is not listed when not recursive", async () => {
        const { base, watched, sibling } = layout();
        writeFileSync(join(sibling, "outside.json"), "one");
        symlinkSync(join(sibling, "outside.json"), join(watched, "outside.json"));

        const first = await listingDigest(watched, false);
        writeFileSync(join(sibling, "outside.json"), "two, and longer");
        const second = await listingDigest(watched, false);

        expect(first.count).toBe(0);
        expect(second.digest).toBe(first.digest);
        rmSync(base, { recursive: true, force: true });
    });

    test("an unreadable directory behind an outside link does not fail the walk", async () => {
        const { base, watched, sibling } = layout();
        const locked = join(sibling, "locked");
        mkdirSync(locked, { mode: 0o000 });
        symlinkSync(locked, join(watched, "direct"));
        symlinkSync(sibling, join(watched, "via"));
        writeFileSync(join(watched, "kept.json"), "{}");

        const result = await listingDigest(watched, true);

        expect(result.count).toBe(1);
        chmodSync(locked, 0o700);
        rmSync(base, { recursive: true, force: true });
    });

    test("a link whose target is missing is skipped without failing", async () => {
        const { base, watched } = layout();
        symlinkSync(join(base, "absent"), join(watched, "dangling"));

        const result = await listingDigest(watched, true);

        expect(result.count).toBe(0);
        rmSync(base, { recursive: true, force: true });
    });

    test("a link that climbs out through a nested directory is not walked", async () => {
        const { base, watched, sibling } = layout();
        mkdirSync(join(watched, "deep"));
        writeFileSync(join(sibling, "outside.json"), "one");
        symlinkSync(sibling, join(watched, "deep", "up"));

        const result = await listingDigest(watched, true);

        expect(result.count).toBe(0);
        rmSync(base, { recursive: true, force: true });
    });

    test("a file link that resolves inside the path is listed as its own row", async () => {
        const { base, watched } = layout();
        writeFileSync(join(watched, "a.json"), "a");
        symlinkSync("a.json", join(watched, "b.json"));

        expect((await listingDigest(watched, false)).count).toBe(2);
        rmSync(base, { recursive: true, force: true });
    });

    test("a link back to the watch path lists each real file once", async () => {
        const { base, watched } = layout();
        mkdirSync(join(watched, "sub"));
        writeFileSync(join(watched, "a.json"), "a");
        writeFileSync(join(watched, "sub", "b.json"), "b");
        symlinkSync(".", join(watched, "loop"));
        symlinkSync("..", join(watched, "sub", "up"));

        const first = await listingDigest(watched, true);
        const second = await listingDigest(watched, true);

        expect(first.count).toBe(2);
        expect(second.digest).toBe(first.digest);
        rmSync(base, { recursive: true, force: true });
    });

    test("a directory reached directly and through links is listed once", async () => {
        const { base, watched } = layout();
        mkdirSync(join(watched, "data"));
        writeFileSync(join(watched, "data", "x.json"), "x");
        symlinkSync("data", join(watched, "first"));
        symlinkSync("data", join(watched, "second"));

        expect((await listingDigest(watched, true)).count).toBe(1);
        rmSync(base, { recursive: true, force: true });
    });

    test("a watch path that is itself a link to a directory is walked", async () => {
        const { base, sibling } = layout();
        writeFileSync(join(sibling, "inside.json"), "x");
        const entry = join(base, "entry");
        symlinkSync(sibling, entry);

        expect((await listingDigest(entry, true)).count).toBe(1);
        rmSync(base, { recursive: true, force: true });
    });

    test("under a linked watch path, only links within its real target are followed", async () => {
        const { base, sibling } = layout();
        const beyond = join(base, "watch-other-beyond");
        mkdirSync(beyond);
        writeFileSync(join(sibling, "inside.json"), "one");
        writeFileSync(join(beyond, "outside.json"), "one");
        symlinkSync("inside.json", join(sibling, "alias.json"));
        symlinkSync(beyond, join(sibling, "gate"));
        const entry = join(base, "entry");
        symlinkSync(sibling, entry);

        const first = await listingDigest(entry, true);
        writeFileSync(join(beyond, "outside.json"), "two, and longer");
        const second = await listingDigest(entry, true);

        expect(first.count).toBe(2);
        expect(second.digest).toBe(first.digest);
        rmSync(base, { recursive: true, force: true });
    });

    test("editing a file behind an outside link emits no event", async () => {
        const { base, watched, sibling } = layout();
        writeFileSync(join(sibling, "outside.json"), "one");
        symlinkSync(sibling, join(watched, "via"));
        const inbox = Inbox.open(":memory:");
        const controller = new AbortController();
        const { context: ctx } = context(inbox, { path: watched, recursive: true }, controller);
        const connector = createFilesystemConnector({
            sleep: steppedSleep(controller, 3, (pass) => {
                if (pass === 1) writeFileSync(join(sibling, "outside.json"), "two, and longer");
            }),
        });

        await connector.run(ctx);

        expect(inbox.readAfter(0, { limit: 10 }).length).toBe(0);
        inbox.close();
        rmSync(base, { recursive: true, force: true });
    });
});

describe("filesystem connector", () => {
    test("the first poll is a baseline and emits nothing", async () => {
        const inbox = Inbox.open(":memory:");
        const dir = tempDir();
        writeFileSync(join(dir, "a.json"), "a");
        const controller = new AbortController();
        const { context: ctx } = context(inbox, { path: dir }, controller);
        const connector = createFilesystemConnector({
            sleep: steppedSleep(controller, 2, () => undefined),
        });

        await connector.run(ctx);

        expect(inbox.readAfter(0, { limit: 10 }).length).toBe(0);
        inbox.close();
        rmSync(dir, { recursive: true });
    });

    test("a change after the baseline emits one coarse event", async () => {
        const inbox = Inbox.open(":memory:");
        const dir = tempDir();
        const controller = new AbortController();
        const { context: ctx } = context(inbox, { path: dir }, controller);
        const connector = createFilesystemConnector({
            sleep: steppedSleep(controller, 3, (pass) => {
                if (pass === 1) writeFileSync(join(dir, "task-1.json"), "{}");
            }),
        });

        await connector.run(ctx);

        const entries = inbox.readAfter(0, { limit: 10 });
        expect(entries.length).toBe(1);
        expect(entries[0]?.kind).toBe("filesystem.changed");
        inbox.close();
        rmSync(dir, { recursive: true });
    });

    test("an unreadable directory is fatal, not a silent empty listing", async () => {
        const dir = tempDir();
        const locked = join(dir, "locked");
        mkdirSync(locked, { mode: 0o000 });
        const inbox = Inbox.open(":memory:");
        const controller = new AbortController();
        const { context: ctx } = context(inbox, { path: locked }, controller);
        const connector = createFilesystemConnector({
            sleep: steppedSleep(controller, 2, () => undefined),
        });

        await expect(connector.run(ctx)).rejects.toThrow(WatchFatalError);
        inbox.close();
        chmodSync(locked, 0o700);
        rmSync(dir, { recursive: true, force: true });
    });
});

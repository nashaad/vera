import { describe, expect, test } from "bun:test";

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        const result = await listingDigest(join(tempDir(), "absent"), false);
        expect(result.count).toBe(0);
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

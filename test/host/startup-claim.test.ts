import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    acquireHostStartupClaim,
    HostStartupInProgressError,
} from "../../src/host/startup-claim.ts";

test("one live process owns the host startup claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-host-claim-"));
    const path = join(root, "host.starting");
    const first = await acquireHostStartupClaim({
        path,
        pid: 101,
        createToken: () => "first",
        isProcessAlive: () => true,
        now: () => Date.parse("2026-08-20T00:00:00Z"),
    });
    try {
        await expect(acquireHostStartupClaim({
            path,
            pid: 202,
            createToken: () => "second",
            isProcessAlive: () => true,
            now: () => Date.parse("2026-08-20T00:00:10Z"),
        })).rejects.toBeInstanceOf(HostStartupInProgressError);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
            pid: 101,
            token: "first",
            created_at: "2026-08-20T00:00:00.000Z",
        });
    } finally {
        await first.release();
        await rm(root, { recursive: true, force: true });
    }
});

test("a dead or malformed startup claim is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-host-claim-"));
    const path = join(root, "host.starting");
    await writeFile(path, "partial json");
    const claim = await acquireHostStartupClaim({
        path,
        pid: 202,
        createToken: () => "replacement",
        isProcessAlive: () => false,
        now: () => Date.parse("2026-08-20T00:00:00Z"),
    });
    try {
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
            pid: 202,
            token: "replacement",
            created_at: "2026-08-20T00:00:00.000Z",
        });
    } finally {
        await claim.release();
        await rm(root, { recursive: true, force: true });
    }
});

test("an over-age startup claim stops blocking even with its owner alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-host-claim-"));
    const path = join(root, "host.starting");
    await writeFile(path, `${JSON.stringify({
        pid: 101,
        token: "hung",
        created_at: "2026-08-20T00:00:00.000Z",
    })}\n`);
    const stale: number[] = [];
    const claim = await acquireHostStartupClaim({
        path,
        pid: 202,
        createToken: () => "replacement",
        isProcessAlive: () => true,
        maxClaimAgeMs: 5 * 60 * 1_000,
        now: () => Date.parse("2026-08-20T00:06:00Z"),
        onStaleClaim: (holder) => stale.push(holder.pid),
    });
    try {
        expect(stale).toEqual([101]);
        expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
            pid: 202,
            token: "replacement",
        });
    } finally {
        await claim.release();
        await rm(root, { recursive: true, force: true });
    }
});

test("a live claim inside the age bound still blocks and names its holder", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-host-claim-"));
    const path = join(root, "host.starting");
    await writeFile(path, `${JSON.stringify({
        pid: 101,
        token: "starting",
        created_at: "2026-08-20T00:00:00.000Z",
    })}\n`);
    try {
        const attempt = acquireHostStartupClaim({
            path,
            pid: 202,
            createToken: () => "second",
            isProcessAlive: () => true,
            maxClaimAgeMs: 5 * 60 * 1_000,
            now: () => Date.parse("2026-08-20T00:01:00Z"),
        });
        await expect(attempt).rejects.toBeInstanceOf(HostStartupInProgressError);
        await expect(attempt).rejects.toMatchObject({ holderPid: 101 });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a claim without created_at never expires by age", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-host-claim-"));
    const path = join(root, "host.starting");
    await writeFile(path, `${JSON.stringify({ pid: 101, token: "old" })}\n`);
    try {
        await expect(acquireHostStartupClaim({
            path,
            pid: 202,
            createToken: () => "second",
            isProcessAlive: () => true,
            maxClaimAgeMs: 1,
            now: () => Date.parse("2030-01-01T00:00:00Z"),
        })).rejects.toBeInstanceOf(HostStartupInProgressError);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an old owner cannot remove a replacement claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-host-claim-"));
    const path = join(root, "host.starting");
    const old = await acquireHostStartupClaim({
        path,
        pid: 101,
        createToken: () => "old",
    });
    await writeFile(path, `${JSON.stringify({ pid: 202, token: "new" })}\n`);

    try {
        await old.release();
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
            pid: 202,
            token: "new",
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

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
    });
    try {
        await expect(acquireHostStartupClaim({
            path,
            pid: 202,
            createToken: () => "second",
            isProcessAlive: () => true,
        })).rejects.toBeInstanceOf(HostStartupInProgressError);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
            pid: 101,
            token: "first",
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
    });
    try {
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
            pid: 202,
            token: "replacement",
        });
    } finally {
        await claim.release();
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

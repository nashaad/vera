import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reserveSessionIdentity } from "../../src/host/session-identity-reservation.ts";

test("session identity reservations are durable and never reused", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-identity-reservation-"));
    try {
        expect(await reserveSessionIdentity(root, "session-a", "calm-wren:0001"))
            .toBe("reserved");
        expect(await reserveSessionIdentity(root, "session-a", "calm-wren:0001"))
            .toBe("owned");
        expect(await reserveSessionIdentity(root, "session-b", "calm-wren:0001"))
            .toBe("taken");

        const entries = (await readdir(join(root, ".identities")))
            .filter((entry) => entry.endsWith(".json"));
        expect(entries).toHaveLength(1);
        expect(await readFile(join(root, ".identities", entries[0]!), "utf8"))
            .toContain('"session_id":"session-a"');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("concurrent claims choose exactly one session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-identity-reservation-"));
    try {
        const outcomes = await Promise.all([
            reserveSessionIdentity(root, "session-a", "calm-wren:0001"),
            reserveSessionIdentity(root, "session-b", "calm-wren:0001"),
        ]);
        expect(outcomes.sort()).toEqual(["reserved", "taken"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

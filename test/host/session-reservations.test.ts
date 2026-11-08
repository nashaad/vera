import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withSessionReservation, withSessionReservations, type RestoringSessions } from "../../src/host/session-host/storage.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

test("a tree reservation waits for each member while other sessions proceed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-tree-reservation-"));
    const paths = ["parent", "child", "other"].map((name) => join(root, name));
    const [parent, child, other] = paths as [string, string, string];
    const reservations: RestoringSessions = new Map();
    const childEntered = deferred();
    const releaseChild = deferred();
    const moveEntered = deferred();
    const releaseMove = deferred();
    let held: Promise<void> | undefined;
    let move: Promise<void> | undefined;
    let parentRequest: Promise<void> | undefined;
    try {
        await Promise.all(paths.map((path) => writeFile(path, "")));
        const canonicalParent = await realpath(parent);
        held = withSessionReservation(child, reservations, async () => {
            childEntered.resolve();
            await releaseChild.promise;
        });
        await childEntered.promise;
        move = withSessionReservations([parent, child], reservations, async () => {
            moveEntered.resolve();
            await releaseMove.promise;
        });
        const deadline = Date.now() + 5_000;
        while (!reservations.has(canonicalParent)) {
            if (Date.now() >= deadline) throw new Error("Timed out waiting for tree reservation");
            await Bun.sleep(5);
        }
        let parentEntered = false;
        parentRequest = withSessionReservation(parent, reservations, async () => { parentEntered = true; });
        expect(await withSessionReservation(other, reservations, async () => "available")).toBe("available");
        expect(parentEntered).toBe(false);
        releaseChild.resolve();
        await moveEntered.promise;
        expect(parentEntered).toBe(false);
        releaseMove.resolve();
        await Promise.all([held, move, parentRequest]);
        expect(parentEntered).toBe(true);
        expect(reservations.size).toBe(0);
    } finally {
        releaseChild.resolve();
        releaseMove.resolve();
        await Promise.allSettled([held, move, parentRequest].filter((promise) => promise !== undefined));
        await rm(root, { recursive: true, force: true });
    }
}, 10_000);

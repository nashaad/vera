import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitForSocketLoss } from "../../clients/host/socket-watch.ts";

async function settled(promise: Promise<void>, ms: number): Promise<boolean> {
    let done = false;
    void promise.then(() => {
        done = true;
    });
    await Bun.sleep(ms);
    return done;
}

test("resolves once the socket's home is deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-socket-watch-"));
    const path = join(root, "host.sock");
    await writeFile(path, "");
    const wait = waitForSocketLoss(path, { intervalMs: 10 });
    try {
        expect(await settled(wait.promise, 40)).toBe(false);

        await rm(root, { recursive: true, force: true });
        await wait.promise;
    } finally {
        wait.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

test("resolves once another file takes the socket path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-socket-watch-"));
    const path = join(root, "host.sock");
    await writeFile(path, "");
    const wait = waitForSocketLoss(path, { intervalMs: 10 });
    try {
        expect(await settled(wait.promise, 40)).toBe(false);

        await rm(path);
        await writeFile(path, "");
        await wait.promise;
    } finally {
        wait.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

test("an error other than a missing file keeps the host running", async () => {
    let calls = 0;
    const wait = waitForSocketLoss("/unused", {
        intervalMs: 10,
        identify: () => {
            calls += 1;
            if (calls === 1) return "1:1";
            throw Object.assign(new Error("busy"), { code: "EACCES" });
        },
    });
    try {
        expect(await settled(wait.promise, 50)).toBe(false);
        expect(calls).toBeGreaterThan(2);
    } finally {
        wait.dispose();
    }
});

test("a socket unreadable at start is adopted once it reads", async () => {
    let calls = 0;
    const wait = waitForSocketLoss("/unused", {
        intervalMs: 10,
        identify: () => {
            calls += 1;
            if (calls === 1) {
                throw Object.assign(new Error("busy"), { code: "EIO" });
            }
            return "1:1";
        },
    });
    try {
        expect(await settled(wait.promise, 50)).toBe(false);
    } finally {
        wait.dispose();
    }
});

test("stops checking once disposed", async () => {
    let checks = 0;
    const wait = waitForSocketLoss("/unused", {
        intervalMs: 10,
        identify: () => {
            checks += 1;
            return "1:1";
        },
    });
    await Bun.sleep(35);
    wait.dispose();
    const seen = checks;
    await Bun.sleep(35);

    expect(seen).toBeGreaterThan(0);
    expect(checks).toBe(seen);
});

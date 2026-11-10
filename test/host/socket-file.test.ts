import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { removeSocketFile, removeUnusedSocketFile, socketFileIdentity } from "../../src/host/socket-file.ts";

test("stale cleanup keeps a socket with a listener", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "socket-listener-"));
    const path = join(home, "host.sock");
    const server = createServer();
    try {
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
        await removeUnusedSocketFile(path, await socketFileIdentity(path));
        expect(existsSync(path)).toBe(true);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
    }
});

test("socket cleanup keeps a replacement socket", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "socket-owner-"));
    const path = join(home, "host.sock");
    const first = createServer();
    const second = createServer();
    const listen = (server: Server) => new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
    });
    const close = (server: Server) => new Promise<void>((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
    });
    try {
        await listen(first);
        const original = await socketFileIdentity(path);
        await rename(path, join(home, "old.sock"));
        await listen(second);
        await removeSocketFile(path, original);
        expect(existsSync(path)).toBe(true);
    } finally {
        await close(first);
        await close(second);
        await rm(home, { recursive: true, force: true });
    }
});

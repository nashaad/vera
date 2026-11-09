import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { connectHost } from "../../src/host/connection.ts";
import { ControlPeer } from "../../src/host/master/control.ts";

interface CapturedFrames {
    next(): Promise<Buffer>;
}

function captureFrames(socket: Socket): CapturedFrames {
    let pending = Buffer.alloc(0);
    const frames: Buffer[] = [];
    const waiters: Array<(frame: Buffer) => void> = [];
    socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
            const newline = pending.indexOf(10);
            if (newline === -1) break;
            const frame = pending.subarray(0, newline + 1);
            pending = pending.subarray(newline + 1);
            const waiter = waiters.shift();
            if (waiter === undefined) frames.push(frame);
            else waiter(frame);
        }
    });
    return {
        next() {
            const frame = frames.shift();
            return frame === undefined ? new Promise<Buffer>((resolve) => waiters.push(resolve)) : Promise.resolve(frame);
        },
    };
}

async function withRawPeers(
    limits: readonly number[],
    run: (peers: readonly ControlPeer[], captures: readonly CapturedFrames[]) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "control-broadcast-"));
    const socketPath = join(root, "control.sock");
    const accepted = limits.map(() => Promise.withResolvers<Socket>());
    const peers: ControlPeer[] = [];
    const sockets: Socket[] = [];
    const captures: CapturedFrames[] = [];
    let index = 0;
    const server = createServer((socket) => accepted[index++]!.resolve(socket));
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        for (let slot = 0; slot < limits.length; slot += 1) {
            peers.push(new ControlPeer(await connectHost({ socketPath, maxLineBytes: limits[slot] })));
            const socket = await accepted[slot]!.promise;
            sockets.push(socket);
            captures.push(captureFrames(socket));
        }
        await run(peers, captures);
    } finally {
        for (const peer of peers) peer.close();
        for (const socket of sockets) socket.destroy();
        await Promise.all(peers.map((peer) => peer.closed));
        await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
        await rm(root, { recursive: true, force: true });
    }
}

test("broadcast serializes once and preserves each peer's original bytes and ordering", async () => {
    await withRawPeers([1024, 1024, 1024], async (peers, captures) => {
        const value = { summaries: [{ id: "crow", title: "海 🦜\n\\\"" }], workIndex: { rows: [] } };
        await peers[0]!.event("snapshot", value);
        const original = await captures[0]!.next();
        let encodes = 0;
        const observed = { toJSON() { encodes += 1; return value; } };
        const before = peers.map((peer) => peer.event("before", 1));
        ControlPeer.broadcastEvent(peers, "snapshot", observed);
        const after = peers.map((peer) => peer.event("after", 2));
        await Promise.all([...before, ...after]);
        expect(encodes).toBe(1);
        for (const capture of captures) {
            expect((await capture.next()).toString()).toBe('{"type":"event","event":"before","value":1}\n');
            expect(await capture.next()).toEqual(original);
            expect((await capture.next()).toString()).toBe('{"type":"event","event":"after","value":2}\n');
        }
    });
});

test("an oversized or closed peer does not block the other peers or later frames", async () => {
    await withRawPeers([128, 1024, 1024], async (peers, captures) => {
        peers[2]!.close();
        const value = { title: "x".repeat(200) };
        ControlPeer.broadcastEvent(peers, "snapshot", value);
        await Promise.all(peers.slice(0, 2).map((peer) => peer.event("after", true)));
        expect((await captures[0]!.next()).toString()).toBe('{"type":"event","event":"after","value":true}\n');
        expect((await captures[1]!.next()).toString()).toBe(`${JSON.stringify({ type: "event", event: "snapshot", value })}\n`);
        expect((await captures[1]!.next()).toString()).toBe('{"type":"event","event":"after","value":true}\n');
    });
});

test("a frame exactly at the receiving connection's byte limit is sent", async () => {
    const value = { title: "海 🦜" };
    const line = JSON.stringify({ type: "event", event: "snapshot", value });
    await withRawPeers([Buffer.byteLength(line)], async (peers, captures) => {
        ControlPeer.broadcastEvent(peers, "snapshot", value);
        expect(await captures[0]!.next()).toEqual(Buffer.from(`${line}\n`));
    });
});

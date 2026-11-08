import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { acceptHostConnection, connectHost } from "../../src/host/connection.ts";
import { ControlPeer } from "../../src/host/master/control.ts";

test("control requests run in both directions and preserve optional arguments", async () => {
    await withPeers(async (master, worker) => {
        master.setHandler(async (_method, args) => {
            expect(args).toEqual(["crow", undefined, null]);
            return "returned";
        });
        worker.setHandler(async (_method, args) => await worker.request("return", args));
        expect(await master.request<string>("roundtrip", ["crow", undefined, null])).toBe("returned");
    });
});

test("control cancellation and disconnect release both sides", async () => {
    await withPeers(async (master, worker) => {
        const entered = Promise.withResolvers<void>();
        const cancelled = Promise.withResolvers<void>();
        worker.setHandler(async (_method, _args, signal) => {
            entered.resolve();
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
                cancelled.resolve();
                resolve();
            }, { once: true }));
            signal.throwIfAborted();
        });
        const controller = new AbortController();
        const call = master.request("ask", [], controller.signal);
        await entered.promise;
        controller.abort();
        await expect(call).rejects.toThrow();
        await cancelled.promise;

        const waiting = Promise.withResolvers<void>();
        worker.setHandler(async () => { waiting.resolve(); return await new Promise(() => {}); });
        const abandoned = master.request("investigate");
        await waiting.promise;
        worker.close();
        await expect(abandoned).rejects.toThrow();
        await Promise.all([master.closed, worker.closed]);
    });
});

async function withPeers(run: (master: ControlPeer, worker: ControlPeer) => Promise<void>): Promise<void> {
    const root = await mkdtemp("/private/tmp/vera-dev/hs4-control-");
    const socketPath = join(root, "control.sock");
    const accepted = Promise.withResolvers<ControlPeer>();
    const server: Server = createServer((socket) => accepted.resolve(new ControlPeer(acceptHostConnection(socket))));
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    const master = new ControlPeer(await connectHost({ socketPath }));
    const worker = await accepted.promise;
    try {
        await run(master, worker);
    } finally {
        master.close();
        worker.close();
        await Promise.all([master.closed, worker.closed]);
        await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
        await rm(root, { recursive: true, force: true });
    }
}

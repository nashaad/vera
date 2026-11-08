import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { acceptHostConnection, connectHost, MAX_FRAME_BYTES, type HostConnection } from "../../src/host/connection.ts";
import { ControlPeer } from "../../src/host/master/control.ts";
import { ExtensionCommandUnavailableError, InvalidExtensionCommandResultError } from "../../src/extensions/commands.ts";
import { ExtensionOperationTimeoutError } from "../../src/extensions/operation.ts";

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

test("extension command failures retain their types across the control channel", async () => {
    await withPeers(async (master, worker) => {
        const errors = [
            new ExtensionCommandUnavailableError("unavailable"),
            new InvalidExtensionCommandResultError("invalid"),
            new ExtensionOperationTimeoutError("timeout"),
        ];
        for (const error of errors) {
            worker.setHandler(async () => { throw error; });
            const returned = await master.request("command").then(() => undefined, (failure: unknown) => failure);
            expect(returned).toBeInstanceOf(error.constructor);
            expect((returned as Error).message).toBe(error.message);
        }
    });
});

test("a tool result larger than one frame reaches the requesting worker intact", async () => {
    await withPeers(async (master, worker) => {
        const value = `start${"x".repeat(MAX_FRAME_BYTES)}end`;
        master.setHandler(async () => ({ kind: "output", output: value, isError: false }));
        const received = await worker.request<{ output: string }>("extension.executeTool");
        expect(received.output.length).toBe(value.length);
        expect(received.output.startsWith("start")).toBe(true);
        expect(received.output.endsWith("end")).toBe(true);
        expect(received.output === value).toBe(true);
    });
}, 30_000);

test("large concurrent responses preserve escaped text and stay independent", async () => {
    await withPeers(async (master, worker) => {
        const first = "\\\n😊".repeat(300_000);
        const second = "two".repeat(400_000);
        master.setHandler(async (_method, args) => args[0] === "first" ? first : second);
        const received = await Promise.all([
            worker.request<string>("first", ["first"]),
            worker.request<string>("second", ["second"]),
        ]);
        expect(received[0] === first).toBe(true);
        expect(received[1] === second).toBe(true);
    });
}, 30_000);

test("a failed response send returns an error", async () => {
    const answered = Promise.withResolvers<unknown>();
    const closed = Promise.withResolvers<Error>();
    let received = false;
    let isClosed = false;
    const connection: HostConnection = {
        async send(value) {
            const response = value as { value?: unknown; error?: unknown };
            if (response.value !== undefined) throw new Error("host connection line exceeds maximum size");
            answered.resolve(response);
        },
        async receive() {
            if (!received) {
                received = true;
                return { type: "request", id: "one", method: "large", args: [] };
            }
            throw await closed.promise;
        },
        async receiveWithin() { throw new Error("not used"); },
        closedReason: () => closed.promise,
        expectPeerClose() {},
        close() { isClosed = true; closed.resolve(new Error("closed")); },
        get closed() { return isClosed; },
    };
    const peer = new ControlPeer(connection);
    peer.setHandler(async () => "large result");
    try {
        expect(await answered.promise).toMatchObject({
            type: "response", id: "one", error: { message: "host connection line exceeds maximum size" },
        });
    } finally {
        peer.close();
        await peer.closed;
    }
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

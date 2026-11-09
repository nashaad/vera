import { expect, spyOn } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { connectHost } from "../../src/host/connection.ts";
import { ControlPeer } from "../../src/host/pool/control.ts";
import { HOST_PROTOCOL_VERSION, requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import * as hostServer from "../../src/host/server.ts";

socketTest("a forwarded shutdown reply is delivered before the worker stops", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs6-reply-");
    const frameHeld = Promise.withResolvers<void>();
    const releaseFrame = Promise.withResolvers<void>();
    const shutdownNotified = Promise.withResolvers<void>();
    const originalRequest = ControlPeer.prototype.request;
    const frameSpy = spyOn(ControlPeer.prototype, "request").mockImplementation(function <T>(
        this: ControlPeer, method: string, args: readonly unknown[] = [], signal?: AbortSignal,
    ): Promise<T> {
        const frame = args[1] as { type?: unknown } | undefined;
        if (method === "public.frame" && frame?.type === "shutdown_if_idle_accepted") {
            frameHeld.resolve();
            return releaseFrame.promise.then(() => originalRequest.call(this, method, args, signal)) as Promise<T>;
        }
        return originalRequest.call(this, method, args, signal) as Promise<T>;
    });
    const originalStart = hostServer.startHostServer;
    const serverSpy = spyOn(hostServer, "startHostServer").mockImplementation(async (options = {}) =>
        await originalStart({
            ...options,
            onShutdownAccepted: () => {
                shutdownNotified.resolve();
                return options.onShutdownAccepted?.();
            },
        })
    );
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let response: Promise<unknown> | undefined;
    let workerPid: number | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
            },
        });
        const hostIdentity = await requestHostIdentity(host.server.socketPath);
        const workerPath = join(home, "runtime", "w0.sock");
        workerPid = (await requestHostIdentity(workerPath))!.pid;
        response = request(workerPath, {
            type: "shutdown_if_idle", pid: hostIdentity!.pid, started_at: hostIdentity!.started_at,
            requester_protocol_version: HOST_PROTOCOL_VERSION,
        });
        void response.catch(() => {});
        let stopping = false;
        void host.shutdownRequested.then(() => { stopping = true; });
        await within(Promise.all([frameHeld.promise, shutdownNotified.promise]));
        await Promise.resolve();
        expect(stopping).toBe(false);
        expect(() => process.kill(workerPid!, 0)).not.toThrow();
        releaseFrame.resolve();
        expect(await within(response)).toMatchObject({ type: "shutdown_if_idle_accepted" });
        expect(() => process.kill(workerPid!, 0)).not.toThrow();
        await within(host.shutdownRequested);
    } finally {
        releaseFrame.resolve();
        await response?.catch(() => {});
        const annexPid = host?.annexPid;
        await host?.close();
        frameSpy.mockRestore();
        serverSpy.mockRestore();
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

async function request(socketPath: string, message: object): Promise<unknown> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send(message);
        return await connection.receiveWithin(8_000, "Timed out waiting for the host");
    } finally {
        connection.close();
    }
}

async function within<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Timed out waiting for shutdown")), 8_000);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

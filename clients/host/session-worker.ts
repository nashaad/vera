#!/usr/bin/env bun

import { connectHost } from "../../src/host/connection.ts";
import { ControlPeer } from "../../src/host/master/control.ts";
import { startControlledWorker, type WorkerBootstrap, type WorkerHello } from "../../src/host/master/worker-control.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";
import { forbidWorkerConfigWrites } from "../../src/config.ts";
import { forbidWorkerAuthWrites } from "../../src/providers/auth-storage.ts";
import { forbidWorkerPoolWrites } from "../../src/model/pool-file-store.ts";
import { forbidWorkerCatalogWrites } from "../../src/model/catalog-cache.ts";

function option(name: string): string {
    const index = process.argv.indexOf(name);
    const value = index < 0 ? undefined : process.argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing ${name}`);
    return value;
}

async function main(): Promise<void> {
    forbidWorkerConfigWrites();
    forbidWorkerAuthWrites();
    forbidWorkerPoolWrites();
    forbidWorkerCatalogWrites();
    const index = Number(option("--worker-index"));
    const count = Number(option("--worker-count"));
    const generation = Number(option("--worker-generation"));
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || count <= index
        || !Number.isSafeInteger(generation) || generation <= 0) {
        throw new Error("Invalid worker index or count");
    }
    const control = option("--control");
    const socket = option("--socket");
    const hello: WorkerHello = {
        id: `w${index}`, index, count, pid: process.pid,
        started_at: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        build_id: thisProcessBuildId(), socket,
    };
    const peer = new ControlPeer(await connectHost({ socketPath: control }));
    const shutdown = Promise.withResolvers<void>();
    const onSignal = (): void => shutdown.resolve();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    try {
        const bootstrap = await peer.request<WorkerBootstrap>("hello", [hello]);
        const worker = await startControlledWorker(peer, bootstrap, hello, generation, onSignal);
        try {
            await Promise.race([peer.closed, shutdown.promise]);
        } finally {
            await worker.close();
        }
    } finally {
        peer.close();
        await peer.closed;
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
    }
}

try {
    await main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

#!/usr/bin/env bun

import { connectHost } from "../../src/host/connection.ts";
import { ControlPeer } from "../../src/host/pool/control.ts";
import { WorkerControlLink } from "../../src/host/pool/worker-link.ts";
import { startControlledWorker, type WorkerBootstrap, type WorkerHello } from "../../src/host/pool/worker-control.ts";
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
    let peer = new ControlPeer(await connectHost({ socketPath: control }));
    const link = new WorkerControlLink();
    const shutdown = Promise.withResolvers<void>();
    const onSignal = (): void => shutdown.resolve();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    try {
        const bootstrap = await peer.request<WorkerBootstrap>("hello", [hello]);
        link.bind(peer);
        const worker = await startControlledWorker(link, bootstrap, hello, generation, onSignal);
        let hostLost = false;
        try {
            while (true) {
                const ended = await Promise.race([
                    peer.closed.then(() => "lost" as const),
                    shutdown.promise.then(() => "shutdown" as const),
                ]);
                if (ended === "shutdown") break;
                link.unbind(peer);
                const deadline = performance.now() + (bootstrap.hostGraceMs ?? 30_000);
                let adopted = false;
                while (performance.now() < deadline) {
                    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
                    let candidate: ControlPeer | undefined;
                    try {
                        const signal = AbortSignal.timeout(Math.max(1, Math.min(remaining, 1_000)));
                        candidate = new ControlPeer(await connectHost({ socketPath: control, signal }));
                        const next = await candidate.request<WorkerBootstrap>("hello", [hello], signal);
                        if (next.adopt !== true || next.buildId !== hello.build_id) throw new Error("Invalid worker adoption");
                        link.bind(candidate, false);
                        await worker.adopt(AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))), next.heartbeatIntervalMs);
                        peer = candidate;
                        adopted = true;
                        break;
                    } catch {
                        if (candidate !== undefined) {
                            link.unbind(candidate);
                            candidate.close();
                            await candidate.closed;
                        }
                    }
                    const delay = Math.min(deadline - performance.now(), 100 + Math.floor(Math.random() * 150));
                    if (delay <= 0) break;
                    const stopped = await Promise.race([
                        Bun.sleep(delay).then(() => false),
                        shutdown.promise.then(() => true),
                    ]);
                    if (stopped) break;
                }
                if (!adopted) { hostLost = true; break; }
            }
        } finally {
            await worker.close(hostLost);
        }
    } finally {
        link.unbind(peer);
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

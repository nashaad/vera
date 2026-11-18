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
import { createHostLogger } from "../../src/host/host-log.ts";
import type { HostShutdownSignal } from "./process-lifecycle.ts";

interface WorkerStopReason {
    readonly reason: string;
    readonly signal?: HostShutdownSignal;
    readonly error?: string;
    readonly stack?: string;
}

function option(name: string): string {
    const index = process.argv.indexOf(name);
    const value = index < 0 ? undefined : process.argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing ${name}`);
    return value;
}

async function runSessionWorker(
    startedAt: string,
    shutdown: Promise<void>,
    requestStop: (reason: WorkerStopReason) => void,
    stopReason: () => WorkerStopReason | undefined,
    recordStop: (reason: WorkerStopReason) => void,
): Promise<void> {
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
        started_at: startedAt,
        build_id: thisProcessBuildId(), socket,
    };
    let peer = new ControlPeer(await connectHost({ socketPath: control }));
    const link = new WorkerControlLink();
    try {
        const bootstrap = await peer.request<WorkerBootstrap>("hello", [hello]);
        link.bind(peer);
        const worker = await startControlledWorker(link, bootstrap, hello, generation, () => requestStop({ reason: "host_request" }));
        let hostLost = false;
        try {
            while (true) {
                const ended = await Promise.race([
                    peer.closed.then(() => "lost" as const),
                    shutdown.then(() => "shutdown" as const),
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
                        shutdown.then(() => true),
                    ]);
                    if (stopped) break;
                }
                if (!adopted) { hostLost = true; break; }
            }
        } catch (error) {
            recordStop({
                reason: "exception",
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
            });
            throw error;
        } finally {
            recordStop(stopReason() ?? { reason: hostLost ? "host_lost" : "worker_shutdown" });
            await worker.close(hostLost);
        }
    } finally {
        link.unbind(peer);
        peer.close();
        await peer.closed;
    }
}

export async function runSessionWorkerEntrypoint(): Promise<void> {
    const startedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
    const index = process.argv.indexOf("--worker-index");
    const workerId = index < 0 ? undefined : process.argv[index + 1];
    const generationIndex = process.argv.indexOf("--worker-generation");
    const generation = generationIndex < 0 ? undefined : Number(process.argv[generationIndex + 1]);
    const log = createHostLogger();
    let stopped = false;
    let requested: WorkerStopReason | undefined;
    const shutdown = Promise.withResolvers<void>();
    const recordStop = (reason: WorkerStopReason): void => {
        if (stopped) return;
        stopped = true;
        log({
            type: "host_stopping", role: "worker", pid: process.pid,
            started_at: startedAt, build_id: thisProcessBuildId(),
            ...(workerId === undefined ? {} : { worker_id: `w${workerId}` }),
            ...(generation === undefined || !Number.isSafeInteger(generation) ? {} : { generation }),
            ...reason,
        });
    };
    const requestStop = (reason: WorkerStopReason): void => {
        requested ??= reason;
        shutdown.resolve();
    };
    const onInterrupt = (): void => requestStop({ reason: "signal", signal: "SIGINT" });
    const onTerminate = (): void => requestStop({ reason: "signal", signal: "SIGTERM" });
    const onHangup = (): void => requestStop({ reason: "signal", signal: "SIGHUP" });
    const onFault = (reason: string, error: unknown): void => {
        recordStop({
            reason,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        });
        process.exit(1);
    };
    const onUncaught = (error: Error): void => onFault("uncaught_exception", error);
    const onUnhandled = (error: unknown): void => onFault("unhandled_rejection", error);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    process.once("SIGHUP", onHangup);
    process.once("uncaughtException", onUncaught);
    process.once("unhandledRejection", onUnhandled);
    try {
        await runSessionWorker(startedAt, shutdown.promise, requestStop, () => requested, recordStop);
    } catch (error) {
        recordStop(requested ?? {
            reason: "exception",
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        });
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    } finally {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
        process.off("SIGHUP", onHangup);
        process.off("uncaughtException", onUncaught);
        process.off("unhandledRejection", onUnhandled);
    }
}

if (import.meta.main) {
    await runSessionWorkerEntrypoint();
}

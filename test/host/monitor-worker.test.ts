import { expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { processCommandLine } from "../../src/host/process-identity.ts";
import { readProcessGroupSnapshot } from "../../src/process-group.ts";
import * as supervisor from "../../src/host/pool/supervisor.ts";
import { HostRouter } from "../../src/host/pool/router.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { ProcessObservationCoordinator } from "../../src/host/process-observations.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { defaultInboxPath } from "../../src/store/inbox.ts";
import { defaultSessionDirectory } from "../../src/store/session-store.ts";
import { readPoolWorkerPids } from "../support/pool-worker-pids.ts";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";

for (const fault of ["none", "lost-acknowledgement", "admission", "lost-executor", "wake-failure"] as const) {
    const lostAcknowledgement = fault === "lost-acknowledgement";
    const admissionFailure = fault === "admission";
    const wakeFailure = fault === "wake-failure";
    const lostExecutor = fault === "lost-executor" || wakeFailure;
    socketAndLoopbackTest(lostAcknowledgement
        ? "@core a pooled worker recovers a persisted start after its acknowledgement is lost"
        : admissionFailure
            ? "@core a pooled worker reports failed outcome admission and replays it after restart"
            : wakeFailure
                ? "@core a failed post-replacement wake is reported and the owner can retry"
            : lostExecutor
                ? "@core pooled executor loss stops the command and delivers one interruption to its owner"
                : "@core the default session worker sends monitor outcomes through the host inbox", async () => {
    await mkdir(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "monitor-worker-"));
    let requests = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests += 1;
            const call = requests === 1;
            const content = requests === 2 ? "Crow is watching."
                : requests === 3 ? "Crow saw the map." : "Crow is ready again.";
            const delta = call ? { role: "assistant", tool_calls: [{
                index: 0, id: "crow-call", type: "function", function: {
                    name: "monitor", arguments: JSON.stringify({
                        command: lostExecutor ? "exec sleep 30" : "sleep 0.3; printf 'crow found the map\\n'; exit 7",
                        description: "Crow checks the hold",
                    }),
                },
            }] } : { role: "assistant", content };
            const chunk = {
                id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }],
            };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
    const original = ProcessObservationCoordinator.prototype.start;
    let injected = false;
    if (lostAcknowledgement) {
        ProcessObservationCoordinator.prototype.start = function(executor, observation) {
            original.call(this, executor, observation);
            if (!injected) { injected = true; throw new Error("crow acknowledgement lost"); }
        };
    }
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    let database: Database | undefined;
    let workerPids: number[] = [];
    const supervised: supervisor.SessionWorkerSupervisor[] = [];
    const startSupervisor = supervisor.startSessionWorkerSupervisor;
    const probe = lostExecutor ? spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
        const worker = await startSupervisor({
            ...options,
            onSpawn(pid, startedAt) { workerPids.push(pid); options.onSpawn?.(pid, startedAt); },
        });
        supervised.push(worker);
        return worker;
    }) : undefined;
    let rejectWake = false;
    const originalResume = HostRouter.prototype.resume;
    const resumeProbe = wakeFailure ? spyOn(HostRouter.prototype, "resume").mockImplementation(async function(this: HostRouter, path, reservedPaths) {
        if (rejectWake) { rejectWake = false; throw new Error("crow wake refused"); }
        return await originalResume.call(this, path, reservedPaths);
    }) : undefined;
    const options = {
        home, processWorker: true, skipStartupDiscovery: true,
        config: {
            schema_version: 1 as const, provider: "stub", model: "stub-model",
            approval_mode: lostExecutor ? "full_access" as const : "auto" as const, curated_models_url: "",
            providers: { stub: { protocol: "openai-chat" as const, base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" as const } },
        },
    };
    try {
        host = await startResidentHost(options);
        workerPids = await readPoolWorkerPids(home);
        const owner = await createAgentThroughHost(host.server.socketPath, home);
        const other = lostExecutor ? await createAgentThroughHost(host.server.socketPath, home) : undefined;
        if (other !== undefined) expect(other.location!.worker_id).toBe(owner.location!.worker_id);
        let socket = owner.location!.socket_path;
        expect((await requestHostIdentity(socket))!.pid).not.toBe(process.pid);
        if (admissionFailure) {
            database = new Database(defaultInboxPath(home));
            database.exec("CREATE TRIGGER crow_refuse_admission BEFORE INSERT ON admitted_entries BEGIN SELECT RAISE(ABORT, 'crow admission refused'); END");
        }
        client = await attachAgent({ socketPath: socket, agentId: owner.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Watch the crow command." });
        const first = await readToFinished(client);
        expect(JSON.stringify(first)).toContain(lostAcknowledgement ? "crow acknowledgement lost" : "Started process");
        client.close();
        client = undefined;
        const path = join(defaultSessionDirectory(home), `${owner.id}.jsonl`);
        let commandPid: number | undefined;
        if (lostExecutor) {
            database = new Database(defaultInboxPath(home), { readonly: true });
            const observation = database.query<{ pid: number; owner_id: string; outcome: string }, []>(
                "SELECT pid, owner_id, outcome FROM process_observations",
            ).get()!;
            expect(observation).toMatchObject({ owner_id: owner.id, outcome: "running" });
            commandPid = observation.pid;
            expect(readProcessGroupSnapshot()?.some((entry) => entry.group === commandPid && entry.pid === commandPid)).toBe(true);
            const workerPid = (await requestHostIdentity(socket))!.pid;
            const worker = supervised.find((candidate) => candidate.pid === workerPid)!;
            expect(worker).toBeDefined();
            expect(processCommandLine(workerPid)).toContain(join(process.cwd(), "clients/host/session-worker.ts"));
            expect(workerPids).toContain(workerPid);
            rejectWake = wakeFailure;
            worker.kill();
            await worker.exited;
            await waitFor(async () => {
                const snapshot = readProcessGroupSnapshot();
                return snapshot !== undefined && !snapshot.some((entry) => entry.group === commandPid && !/^[ZX]/.test(entry.state));
            });
            await waitFor(async () => database!.query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM producer_entries WHERE producer_source = 'vera.process-observation'",
            ).get()!.count === 1);
            expect(database.query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM process_observations WHERE outcome = 'running'",
            ).get()!.count).toBe(0);
            expect(database.query<{ kind: string; address: string }, []>(
                "SELECT entries.kind, entries.address FROM entries JOIN producer_entries USING (seq) WHERE producer_source = 'vera.process-observation'",
            ).all()).toEqual([{ kind: "process.interrupted", address: owner.id }]);
            if (wakeFailure) {
                await waitFor(async () => host!.health.workers?.[0]?.reason?.includes("process_observation_wake_failed") === true);
                expect(host.health.workers![0]!.reason).toContain("reopen them to receive saved outcomes");
                socket = (await resumeAgentThroughHost(host.server.socketPath, path)).location!.socket_path;
            }
        }
        if (admissionFailure) {
            await waitFor(async () => (await readFile(path, "utf8")).includes("Could not confirm delivery of monitored process"));
            expect(database!.query<{ outcome: string; exit_code: number }, []>(
                "SELECT outcome, exit_code FROM process_observations",
            ).all()).toEqual([{ outcome: "settled", exit_code: 7 }]);
            database!.exec("DROP TRIGGER crow_refuse_admission");
            database!.close();
            database = undefined;
            await host.close();
            host = await startResidentHost(options);
            workerPids.push(...await readPoolWorkerPids(home));
            socket = (await resumeAgentThroughHost(host.server.socketPath, path)).location!.socket_path;
        }
        await waitFor(async () => (await readFile(path, "utf8")).includes("Crow saw the map."));
        const transcript = await readFile(path, "utf8");
        expect(transcript).toContain("Crow checks the hold");
        if (lostAcknowledgement || lostExecutor) {
            expect(transcript).toContain("Interrupted before its outcome could be confirmed");
        } else {
            expect(transcript).toContain("Exited with code 7");
            expect(transcript).toContain("crow found the map");
        }
        await waitFor(async () => (await listAgentsThroughHost(host!.server.socketPath)).find((row) => row.id === owner.id)?.status === "idle");
        if (other !== undefined) expect((await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === other.id)).toBeUndefined();
        client = await attachAgent({ socketPath: socket, agentId: owner.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Are you ready?" });
        expect(JSON.stringify(await readToFinished(client))).toContain("Crow is ready again.");
        if (lostExecutor) expect(requests).toBe(4);
    } finally {
        ProcessObservationCoordinator.prototype.start = original;
        resumeProbe?.mockRestore();
        probe?.mockRestore();
        database?.close();
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        try {
            for (const pid of workerPids) expect(() => process.kill(pid, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
    }, 30_000);
}

async function readToFinished(client: AttachedAgentClient): Promise<unknown[]> {
    const updates: unknown[] = [];
    while (true) {
        const update = await client.receive(AbortSignal.timeout(10_000));
        updates.push(update);
        if (update.type === "turn_finished") return updates;
    }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!await predicate()) {
        if (Date.now() >= deadline) throw new Error("Worker monitor wake timed out");
        await Bun.sleep(10);
    }
}

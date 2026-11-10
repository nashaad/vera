import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdirSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { connectHost } from "../../src/host/connection.ts";
import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { blockSessionThroughHost } from "../../src/host/session-block-client.ts";
import { isSessionBlockedSync, sessionBlockPath } from "../../src/host/session-block.ts";
import { veraBlockedDirectory } from "../../src/profile-paths.ts";
import { defaultSessionDirectory, SessionStore } from "../../src/store/session-store.ts";

for (const owner of ["host", "worker"] as const) {
    socketTest(`block fences a late descendant on the ${owner}`, async () => {
        mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
        const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs4-block-"));
        const host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
            },
        });
        const workerPid = (await requestHostIdentity(inProcessWorkerSocket(home)))!.pid;
        const starting = Promise.withResolvers<void>();
        const continueStart = Promise.withResolvers<void>();
        const originalStart = host.registry.start;
        let child: Promise<unknown> | undefined;
        let block: Promise<unknown> | undefined;
        let admitted = false;
        let parentId: string | undefined;
        try {
            const parent = await host.registry.create({ workspace: home });
            parentId = parent.id;
            const childId = `late-${owner}`;
            if (owner === "host") {
                host.registry.start = async (...args) => {
                    if (args[0].header.id === childId) {
                        starting.resolve();
                        await continueStart.promise;
                    }
                    return await originalStart.apply(host.registry, args);
                };
                child = host.registry.createWithKind(
                    { id: childId, workspace: home }, "background", { approvalMode: "auto", parentId: parent.id },
                );
                await starting.promise;
            } else {
                admitted = await host.registry.subagentAdmission!.reserveSubagentStart(parent.id, 1);
                expect(admitted).toBe(true);
            }
            block = blockSessionThroughHost(host.server.socketPath, {
                targetAgentId: parent.id, sessionIds: [parent.id], reason: null,
            });
            const directory = veraBlockedDirectory(home);
            await waitFor(() => existsSync(sessionBlockPath(directory, parent.id)));
            expect(await Promise.race([block.then(() => "finished"), Bun.sleep(25).then(() => "waiting")])).toBe("waiting");
            if (owner === "host") {
                continueStart.resolve();
                await child;
            } else {
                const path = join(defaultSessionDirectory(home), `${childId}.jsonl`);
                await SessionStore.create(path, { sessionId: childId, cwd: home, parentId: parent.id });
                const connection = await connectHost({ socketPath: host.server.socketPath });
                try {
                    await connection.send({ type: "locate_agent", agent_id: childId });
                    expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0" });
                } finally {
                    connection.close();
                }
                await host.registry.subagentAdmission!.releaseSubagentStart(parent.id);
                admitted = false;
            }
            expect(await block).toEqual({ status: "blocked", sessionIds: [parent.id, childId] });
            expect(isSessionBlockedSync(directory, parent.id)).toBe(true);
            expect(isSessionBlockedSync(directory, childId)).toBe(true);
        } finally {
            continueStart.resolve();
            if (admitted && parentId !== undefined) await host.registry.subagentAdmission!.releaseSubagentStart(parentId);
            await child?.catch(() => {});
            await block?.catch(() => {});
            host.registry.start = originalStart;
            const annexPid = host.annexPid;
            await host.close();
            try {
                expect(() => process.kill(workerPid, 0)).toThrow();
                if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        }
    }, 20_000);
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the block");
        await Bun.sleep(10);
    }
}

import { tmpdir } from "node:os";
import { expect, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import type { AttachedAgentClient } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_AGENT_HISTORY_PAGING, CLIENT_CAPABILITIES } from "../../src/host/capabilities.ts";
import { HostRouter } from "../../src/host/pool/router.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { readPoolWorkerPids } from "../support/pool-worker-pids.ts";
import { socketTest } from "../support/socket-probe.ts";

socketTest("a pooled session serves every history page through its worker", async () => {
    await mkdir(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "histport-pool-"));
    const directory = join(home, "runtime", "sessions");
    const path = join(directory, "crow.jsonl");
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    let workerPids: number[] = [];
    let restoreRouting: (() => void) | undefined;
    try {
        await mkdir(directory, { recursive: true });
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: home });
        for (let index = 0; index < 500; index += 1) {
            await store.appendMessage({ role: "user", content: [{ type: "text", text: `message ${index}` }] });
        }
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
            },
        });
        workerPids = await readPoolWorkerPids(home);
        const ready = await resumeAgentThroughHost(host.server.socketPath, path);
        expect(ready.location?.worker_id).toBe("w0");
        const location = ready.location!;
        expect((await requestHostIdentity(location.socket_path))?.pid).toBe(workerPids[0]);
        client = await attachReconnectingAgent({
            socketPath: () => host!.server.socketPath,
            agentId: ready.id,
            buildId: thisProcessBuildId(),
            interactive: true,
            clientId: "history-paging-test",
            failOnDisconnect: true,
            requestedCapabilities: CLIENT_CAPABILITIES,
            initialLocation: location,
        });
        expect(client.supportsHostCapability(HOST_CAPABILITY_AGENT_HISTORY_PAGING)).toBe(true);
        const tail = await client.receive(AbortSignal.timeout(15_000));
        if (tail.type !== "history" || tail.page === undefined) throw new Error("Expected a paged history");
        expect(tail.page.hasMore).toBe(true);
        const routing = spyOn(HostRouter.prototype, "socketFor");
        restoreRouting = () => routing.mockRestore();
        let entries = [...tail.entries];
        let page = tail.page;
        let requests = 0;
        while (page.hasMore) {
            if (page.olderBefore === undefined || requests >= 10) throw new Error("History cursor did not advance");
            const earlier = await client.requestHistoryPage(page.olderBefore);
            entries = [...earlier.entries, ...entries];
            page = earlier.page;
            requests += 1;
        }
        expect(requests).toBeGreaterThan(0);
        expect(entries.map((entry) => entry.kind === "user" ? entry.text : "")).toEqual(
            Array.from({ length: 500 }, (_, index) => `message ${index}`),
        );
        expect(routing).not.toHaveBeenCalled();
    } finally {
        restoreRouting?.();
        client?.close();
        const annexPid = host?.annexPid;
        try {
            await host?.close();
            for (const pid of workerPids) expect(() => process.kill(pid, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 60_000);

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, spyOn } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { listAgentPageThroughHost } from "../../src/host/agent-list-client.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import * as supervisor from "../../src/host/pool/supervisor.ts";
import { readPoolWorkerPids } from "../support/pool-worker-pids.ts";

socketAndLoopbackTest("@core pooled lists refresh background counts before returning", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs6-background-list-"));
    const processPidPath = join(home, "background.pid");
    let requestNumber = 0;
    let suppressRoster = false;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch() {
            requestNumber += 1;
            let delta: Record<string, unknown>;
            if (requestNumber === 1 || requestNumber === 3) {
                const starting = requestNumber === 1;
                const command = starting
                    ? `echo $$ > '${processPidPath}'; exec sleep 60`
                    : `kill -TERM "$(cat '${processPidPath}')"`;
                delta = {
                    role: "assistant",
                    tool_calls: [{
                        index: 0,
                        id: starting ? "background-start" : "background-kill",
                        type: "function",
                        function: {
                            name: "bash",
                            arguments: JSON.stringify({ command, ...(starting ? { yield_after: 0 } : {}) }),
                        },
                    }],
                };
            } else {
                delta = { role: "assistant", content: "The crow checked the map." };
            }
            const chunk = {
                id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }],
            };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
    const start = supervisor.startSessionWorkerSupervisor;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) =>
        await start({
            ...options,
            onEvent(event, value) {
                if (suppressRoster && event === "roster_delta") return;
                options.onEvent(event, value);
            },
        })
    );
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    let poolPids: number[] = [];
    let processPid: number | undefined;
    try {
        host = await startResidentHost({
            home,
            processWorker: true,
            processWorkerCount: 1,
            skipStartupDiscovery: true,
            config: {
                schema_version: 1,
                provider: "stub",
                model: "stub-model",
                approval_mode: "ask",
                curated_models_url: "",
                providers: {
                    stub: {
                        protocol: "openai-chat",
                        base_url: `http://127.0.0.1:${stub.port}/v1`,
                        credential: "none",
                    },
                },
            },
        });
        poolPids = await readPoolWorkerPids(home);
        const agent = await createAgentThroughHost(host.server.socketPath, home);
        const socketPath = agent.location!.socket_path;
        client = await attachAgent({ socketPath, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        await waitUntil(async () => (await listAgentPageThroughHost(host!.server.socketPath))
            .agents.some((summary) => summary.id === agent.id));
        suppressRoster = true;

        await client.send({ type: "prompt", content: "Start a background command." });
        await receiveThroughToolFinished(client);
        processPid = await waitForPid(processPidPath);
        const started = await listAgentPageThroughHost(host.server.socketPath);
        expect(started.agents.find((summary) => summary.id === agent.id))
            .toMatchObject({ background_commands: 1 });
        await receiveTurnFinished(client);

        await client.send({ type: "prompt", content: "Kill the background command." });
        await receiveThroughToolFinished(client);
        const stopped = await listAgentPageThroughHost(host.server.socketPath);
        expect(stopped.agents.find((summary) => summary.id === agent.id))
            .not.toHaveProperty("background_commands");
        await receiveTurnFinished(client);
        await waitForExit(processPid);
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        probe.mockRestore();
        try {
            if (processPid !== undefined) expect(() => process.kill(processPid!, 0)).toThrow();
            for (const pid of poolPids) expect(() => process.kill(pid, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 60_000);

async function receiveThroughToolFinished(client: AttachedAgentClient): Promise<void> {
    while (true) {
        const update = await client.receive(AbortSignal.timeout(20_000));
        if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
            await client.send({
                type: "ui_response",
                requestId: update.requestId,
                response: { type: "tool_approval", decision: "allow_once" },
            });
        }
        if (update.type === "tool_finished") return;
    }
}

async function receiveTurnFinished(client: AttachedAgentClient): Promise<void> {
    while (true) {
        const update = await client.receive(AbortSignal.timeout(20_000));
        if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
            await client.send({
                type: "ui_response",
                requestId: update.requestId,
                response: { type: "tool_approval", decision: "allow_once" },
            });
        }
        if (update.type === "turn_finished") return;
    }
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(10);
    }
    throw new Error("Timed out waiting for host list update");
}

async function waitForPid(path: string): Promise<number> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        try {
            const pid = Number((await readFile(path, "utf8")).trim());
            if (Number.isSafeInteger(pid) && pid > 0) return pid;
        } catch {}
        await Bun.sleep(10);
    }
    throw new Error("Timed out waiting for background process pid");
}

async function waitForExit(pid: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
        await Bun.sleep(10);
    }
    throw new Error("Timed out waiting for background process exit");
}

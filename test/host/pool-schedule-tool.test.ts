import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import { defaultSessionDirectory, SessionStore } from "../../src/store/session-store.ts";

test("a schedule created by a worker session lands in the master scheduler", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7-tool-");
    const pidPath = join(home, "tool.pid");
    let command = "";
    let requests = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests += 1;
            const call = requests === 1;
            const delta = call
                ? { role: "assistant", tool_calls: [{
                    index: 0, id: "schedule", type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command, yield_after: 10 }) },
                }] }
                : { role: "assistant", content: "The schedule is set." };
            const chunk = {
                id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }],
            };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    let workerPid: number | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
                providers: {
                    stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" },
                },
            },
        });
        const agent = await createAgentThroughHost(host.server.socketPath, home);
        expect(agent.location?.worker_id).toBe("w0");
        const socket = agent.location!.socket_path;
        workerPid = (await requestHostIdentity(socket))!.pid;
        expect(workerPid).not.toBe(process.pid);
        const fixture = join(process.cwd(), "test/host/fixtures/schedule-from-session.ts");
        command = `exec ${[process.execPath, fixture, socket, agent.id, pidPath].map(shellQuote).join(" ")}`;
        client = await attachAgent({ socketPath: socket, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Create a schedule for this conversation." });
        let approvals = 0;
        while (true) {
            const update = await client.receive(AbortSignal.timeout(15_000));
            if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
                await client.send({
                    type: "ui_response", requestId: update.requestId,
                    response: { type: "tool_approval", decision: "allow_once" },
                });
                approvals += 1;
            }
            if (update.type === "turn_finished") break;
        }
        expect(approvals).toBe(1);
        expect(requests).toBe(2);
        const messages = (await SessionStore.open(join(defaultSessionDirectory(home), `${agent.id}.jsonl`))).messages();
        expect(messages.find((message) => message.role === "tool_result" && message.toolName === "bash"))
            .toMatchObject({ isError: false });
        expect(await runScheduleOperationThroughHost(host.server.socketPath, { action: "show", id: "from-worker" }))
            .toMatchObject({ schedule_id: "from-worker", address: agent.id, payload: { text: "Check the map." } });
        const toolPid = Number(await readFile(pidPath, "utf8"));
        expect(Number.isSafeInteger(toolPid) && toolPid > 0).toBe(true);
        expect(() => process.kill(toolPid, 0)).toThrow();
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

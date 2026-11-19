import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import { createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { applyAgentUpdate, createTuiState } from "../../clients/tui/state.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "auto",
} as const;

test("included view_image outcomes survive worker relay, store reopen, and TUI history", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-view-image-history-"));
    const image = await sharp({
        create: { width: 3, height: 2, channels: 3, background: "red" },
    }).png().toBuffer();
    await writeFile(join(home, "cove.png"), image);
    const call: AssistantMessage = {
        role: "assistant",
        content: [{ type: "tool_call", id: "image-call", name: "view_image", input: { path: "missing.png" } }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const success: AssistantMessage = {
        ...call,
        content: [{ type: "tool_call", id: "image-ok", name: "view_image", input: { path: "cove.png" } }],
    };
    const done: AssistantMessage = {
        ...call,
        content: [{ type: "text", text: "Done" }],
        stopReason: "stop",
    };
    const host = await startResidentHost({
        home,
        config,
        inProcessWorker: true,
        createAdapter: () => new FauxAdapter([call, success, done]),
    });
    let client: AttachedAgentClient | undefined;
    try {
        const agent = await createAgentThroughHost(host.server.socketPath, home);
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");

        await client.send({ type: "prompt", content: "View the images" });
        const finished: Extract<Awaited<ReturnType<AttachedAgentClient["receive"]>>, { type: "tool_finished" }>[] = [];
        let live = createTuiState();
        while (true) {
            const update = await client.receive(AbortSignal.timeout(5_000));
            live = applyAgentUpdate(live, update);
            if (update.type === "tool_finished") finished.push(update);
            if (update.type === "turn_finished") break;
        }
        expect(finished).toMatchObject([
            { tool: "view_image", isError: true, output: expect.stringContaining("not found") },
            { tool: "view_image", isError: false, output: expect.stringContaining("cove.png") },
        ]);
        expect(live.entries.filter((entry) => entry.kind === "tool_header")).toMatchObject([
            { header: "Failed", detailPreview: expect.stringContaining("not found") },
            { header: "Worked" },
        ]);
        const agents = await listAgentsThroughHost(host.server.socketPath);
        const sessionPath = agents.find((row) => row.id === agent.id)?.session_path;
        expect(sessionPath).toBeDefined();
        const reopened = await SessionStore.open(sessionPath!);
        const results = reopened.messages().filter((message) => message.role === "tool_result");
        expect(results).toMatchObject([
            { toolName: "view_image", isError: true },
            { toolName: "view_image", isError: false },
        ]);
        expect(results[0]!.content).toEqual([{ type: "text", text: expect.stringContaining("not found") }]);

        client.close();
        client = undefined;
        expect(await closeAgentThroughHost(host.server.socketPath, agent.id)).toEqual({
            status: "closed", sessionRetained: true,
        });
        const resumed = await resumeAgentThroughHost(host.server.socketPath, sessionPath!);
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: resumed.id });
        const history = await client.receive(AbortSignal.timeout(5_000));
        expect(history.type).toBe("history");
        const tui = applyAgentUpdate(createTuiState(), history);
        expect(tui.entries.filter((entry) => entry.kind === "tool_header")).toMatchObject([
            { header: "Failed", detailPreview: expect.stringContaining("not found") },
            { header: "Worked" },
        ]);
    } finally {
        client?.close();
        try {
            await host.close();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

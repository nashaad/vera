import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_SESSION_ROUTING } from "../../src/host/capabilities.ts";
import { MAX_FRAME_BYTES } from "../../src/host/connection.ts";
import { HostRouter } from "../../src/host/master/router.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { SessionStore } from "../../src/store/session-store.ts";

test("large histories attach through the master and directly while routing is delayed", async () => {
    const home = await mkdtemp(join(tmpdir(), "pd-large-"));
    const directory = join(home, "runtime", "sessions");
    const path = join(directory, "crow.jsonl");
    await mkdir(directory, { recursive: true });
    let host: ResidentHost | undefined;
    let restoreRouting: (() => void) | undefined;
    const clients: AttachedAgentClient[] = [];
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: home });
        const text = "crow".repeat(256 * 1_024);
        for (let index = 0; index < 65; index += 1) {
            await store.appendMessage({ role: "user", content: [{ type: "text", text }] });
        }
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
            },
        });
        const session = await resumeAgentThroughHost(host.server.socketPath, path);
        expect(session.location).toBeDefined();
        const socketFor = HostRouter.prototype.socketFor;
        const probe = spyOn(HostRouter.prototype, "socketFor").mockImplementation(async function(this: HostRouter, from, id) {
            await Bun.sleep(1_250);
            return await socketFor.call(this, from, id);
        });
        restoreRouting = () => probe.mockRestore();
        const results: Array<{ via: string; bytes?: number; error?: string }> = [];
        for (const [via, socketPath, capabilities] of [
            ["master", host.server.socketPath, []],
            ["session", session.location!.socket_path, [HOST_CAPABILITY_SESSION_ROUTING]],
        ] as const) {
            try {
                const client = await attachAgent({ socketPath, agentId: session.id,
                    requestedCapabilities: capabilities, maxLineBytes: 80 * 1_024 * 1_024 });
                clients.push(client);
                const update = await client.receive(AbortSignal.timeout(90_000));
                if (update.type !== "history") throw new Error(`Unexpected update: ${update.type}`);
                const bytes = update.entries.reduce((sum, entry) =>
                    sum + ("text" in entry ? Buffer.byteLength(entry.text) : 0), 0);
                results.push({ via, bytes });
                client.close();
            } catch (error) {
                results.push({ via, error: error instanceof Error ? error.message : String(error) });
            }
        }
        expect(results).toHaveLength(2);
        expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
        for (const result of results) {
            expect(result.bytes).toBeGreaterThan(MAX_FRAME_BYTES);
        }
    } finally {
        restoreRouting?.();
        for (const client of clients) client.close();
        await host?.close();
        await rm(home, { recursive: true, force: true });
    }
}, 180_000);

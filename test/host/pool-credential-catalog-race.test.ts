import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { connectHost, type HostConnection } from "../../src/host/connection.ts";
import * as credentials from "../../src/host/master/credentials.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { createAuthStorage, defaultAuthStoragePath } from "../../src/providers/auth-storage.ts";

for (const order of ["catalog-first", "request-first", "catalog-rejected", "forget-during-refresh"] as const) {
test(`${order}: credential writes are coordinated`, async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7cx-");
    const disk = createAuthStorage({ path: defaultAuthStoragePath(home) });
    const initialAccess = randomUUID();
    disk.setCredential("openai-codex", { type: "oauth", token: JSON.stringify({
        schema_version: 1, access_token: initialAccess, refresh_token: randomUUID(),
        expires_at: order === "catalog-rejected" ? Date.now() + 3_600_000 : 1,
    }) });
    let writes = 0;
    const authStorage = {
        getCredential: disk.getCredential.bind(disk),
        setCredential(provider: string, credential: Parameters<typeof disk.setCredential>[1]) {
            writes += 1;
            disk.setCredential(provider, credential);
        },
        deleteCredential: disk.deleteCredential.bind(disk),
    };
    let leases = 0;
    let mutations = 0;
    const createBroker = credentials.createCredentialBroker;
    const brokerSpy = spyOn(credentials, "createCredentialBroker").mockImplementation((options) => {
        const broker = createBroker(options);
        return { ...broker,
            async lease(provider, rejected) { leases += 1; return await broker.lease(provider, rejected); },
            async withProviderMutation(provider, change) { mutations += 1; return await broker.withProviderMutation(provider, change); },
        };
    });
    let refreshes = 0;
    let catalogRequests = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path.endsWith("/oauth/token")) {
                refreshes += 1;
                started.resolve();
                await release.promise;
                return Response.json({ access_token: randomUUID(), refresh_token: randomUUID(), expires_in: 10 });
            }
            if (path.endsWith("/models")) {
                catalogRequests += 1;
                if (order === "catalog-rejected" && request.headers.get("authorization") === `Bearer ${initialAccess}`) {
                    return new Response("rejected", { status: 401 });
                }
                return Response.json({ models: [{ slug: "stub-model", display_name: "Fixture" }] });
            }
            if (path.endsWith("/responses")) {
                const events = [
                    { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
                    { type: "response.output_text.delta", output_index: 0, delta: "The map is aboard." },
                    { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "The map is aboard." }] } },
                    { type: "response.completed", response: { model: "stub-model", usage: { input_tokens: 1, output_tokens: 1 } } },
                ];
                return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
                    headers: { "content-type": "text/event-stream" },
                });
            }
            return new Response("not found", { status: 404 });
        },
    });
    const localFetch = ((input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return fetch(`http://127.0.0.1:${stub.port}${url.pathname}`, init);
    }) as typeof globalThis.fetch;
    const previousOptions = process.env.BUN_OPTIONS;
    const previousPort = process.env.POOL_TEST_STUB_PORT;
    process.env.BUN_OPTIONS = `--preload=${fileURLToPath(new URL("../support/pool-provider-preload.ts", import.meta.url))}`;
    process.env.POOL_TEST_STUB_PORT = String(stub.port);
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    let connection: HostConnection | undefined;
    let workerPid: number | undefined;
    let annexPid: number | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            authStorage, credentialFetch: localFetch, catalogFetch: localFetch,
            config: { schema_version: 1, provider: "openai-codex", model: "stub-model", approval_mode: "auto", curated_models_url: "" },
        });
        annexPid = host.annexPid;
        const session = await createAgentThroughHost(host.server.socketPath, home);
        workerPid = (await requestHostIdentity(session.location!.socket_path))?.pid;
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        connection = await connectHost({ socketPath: session.location!.socket_path });
        if (order === "request-first" || order === "forget-during-refresh") await client.send({ type: "prompt", content: "Where is the map?" });
        else await connection.send({ type: "catalog_refresh", provider: "openai-codex" });
        await Promise.race([started.promise, Bun.sleep(10_000).then(() => { throw new Error("Catalog refresh did not start"); })]);
        if (order === "forget-during-refresh") await connection.send({ type: "provider_forget", provider: "openai-codex" });
        else if (order === "request-first") await connection.send({ type: "catalog_refresh", provider: "openai-codex" });
        else await client.send({ type: "prompt", content: "Where is the map?" });
        const deadline = Date.now() + 10_000;
        const expectedLeases = order === "catalog-rejected" ? 3 : 2;
        while ((order === "forget-during-refresh" ? mutations < 1 : leases < expectedLeases)
            && Date.now() < deadline) await Bun.sleep(10);
        if (order === "forget-during-refresh") expect(mutations).toBe(1);
        else expect(leases).toBe(expectedLeases);
        release.resolve();
        const response = await connection.receive() as { type: string; error?: string };
        expect(response.type).toBe(order === "forget-during-refresh" ? "model_operation_complete" : "catalog_refresh");
        expect(response.error).toBeUndefined();
        while ((await client.receive(AbortSignal.timeout(15_000))).type !== "turn_finished") {}
        expect({ refreshes, writes }).toEqual({ refreshes: 1, writes: 1 });
        if (order === "forget-during-refresh") expect(disk.getCredential("openai-codex")).toBeUndefined();
        else expect(catalogRequests).toBe(order === "catalog-rejected" ? 2 : 1);
    } finally {
        release.resolve();
        connection?.close();
        client?.close();
        try { await host?.close(); }
        finally {
            stub.stop(true);
            brokerSpy.mockRestore();
            if (previousOptions === undefined) delete process.env.BUN_OPTIONS;
            else process.env.BUN_OPTIONS = previousOptions;
            if (previousPort === undefined) delete process.env.POOL_TEST_STUB_PORT;
            else process.env.POOL_TEST_STUB_PORT = previousPort;
            try {
                for (const pid of [workerPid, annexPid]) if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
            } finally { await rm(home, { recursive: true, force: true }); }
        }
    }
}, 60_000);
}

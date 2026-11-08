import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import * as credentials from "../../src/host/master/credentials.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { createAuthStorage, defaultAuthStoragePath } from "../../src/providers/auth-storage.ts";
import { OPENAI_CODEX_PROVIDER_ID } from "../../src/providers/openai-codex-oauth.ts";

test("three workers share a refresh and pick up a client credential write", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7ca-");
    const authPath = defaultAuthStoragePath(home);
    const disk = createAuthStorage({ path: authPath });
    const secrets: string[] = [];
    const expired = () => {
        const access = randomUUID();
        const refresh = randomUUID();
        secrets.push(access, refresh);
        return { type: "oauth" as const, token: JSON.stringify({
            schema_version: 1, access_token: access, refresh_token: refresh, expires_at: 1,
        }) };
    };
    disk.setCredential(OPENAI_CODEX_PROVIDER_ID, expired());
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
    const createBroker = credentials.createCredentialBroker;
    const brokerSpy = spyOn(credentials, "createCredentialBroker").mockImplementation((options) => {
        const broker = createBroker(options);
        return { ...broker, async lease(provider, rejected) { leases += 1; return await broker.lease(provider, rejected); } };
    });
    let refreshes = 0;
    let requests = 0;
    let echoCredential = false;
    let rejectedCredential: string | undefined;
    let rejectedRequests = 0;
    const releaseRejections = Promise.withResolvers<void>();
    let failRefresh = false;
    let lifetimeSeconds = 10;
    let minimumLeasesForRefresh = 3;
    const releaseFailedRefresh = Promise.withResolvers<void>();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path.endsWith("/oauth/token")) {
                refreshes += 1;
                if (failRefresh) {
                    const body = await request.json() as { refresh_token: string };
                    await releaseFailedRefresh.promise;
                    return new Response(`echo:${body.refresh_token}`, { status: 400 });
                }
                await until(() => leases >= minimumLeasesForRefresh);
                await Bun.sleep(200);
                const access = randomUUID();
                const refresh = randomUUID();
                secrets.push(access, refresh);
                return Response.json({ access_token: access, refresh_token: refresh, expires_in: lifetimeSeconds });
            }
            if (!path.endsWith("/responses")) return new Response("not found", { status: 404 });
            requests += 1;
            const value = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
            if (value === rejectedCredential) {
                rejectedRequests += 1;
                if (rejectedRequests === 3) releaseRejections.resolve();
                await releaseRejections.promise;
                return new Response("rejected", { status: 401 });
            }
            if (echoCredential) {
                return new Response(`echo:${value}`, { status: 400 });
            }
            const events = [
                { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
                { type: "response.output_text.delta", output_index: 0, delta: "The crow found the map." },
                { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "The crow found the map." }] } },
                { type: "response.completed", response: { model: "stub-model", usage: { input_tokens: 1, output_tokens: 1 } } },
            ];
            return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
    const previousOptions = process.env.BUN_OPTIONS;
    const previousPort = process.env.POOL_TEST_STUB_PORT;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
            ? originalFetch(input, init)
            : originalFetch(`http://127.0.0.1:${stub.port}${url.pathname}`, init);
    }) as typeof globalThis.fetch;
    const preload = fileURLToPath(new URL("../support/pool-provider-preload.ts", import.meta.url));
    process.env.BUN_OPTIONS = `--preload=${preload}`;
    process.env.POOL_TEST_STUB_PORT = String(stub.port);
    const clients: AttachedAgentClient[] = [];
    const pids: number[] = [];
    let host: ResidentHost | undefined;
    let annexPid: number | undefined;
    let masterClient: AttachedAgentClient | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 3, skipStartupDiscovery: true, authStorage,
            credentialFetch: ((_input, init) => fetch(`http://127.0.0.1:${stub.port}/oauth/token`, init)) as typeof fetch,
            config: { schema_version: 1, provider: OPENAI_CODEX_PROVIDER_ID, model: "stub-model", approval_mode: "auto", curated_models_url: "" },
        });
        expect(host.registry.options.workerAdapterSpec).toBeUndefined();
        annexPid = host.annexPid;
        for (let index = 0; index < 3; index += 1) {
            const identity = await requestHostIdentity(join(home, "runtime", `w${index}.sock`));
            if (identity === undefined) throw new Error("Worker identity unavailable");
            pids.push(identity.pid);
        }
        const sessions = [];
        for (let index = 0; index < 3; index += 1) sessions.push(await createAgentThroughHost(host.server.socketPath, home));
        expect(sessions.map((session) => session.location?.worker_id)).toEqual(["w0", "w1", "w2"]);
        for (const session of sessions) {
            const client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
            clients.push(client);
            expect((await client.receive()).type).toBe("history");
        }
        await runTurns(clients);
        expect({ refreshes, writes }).toEqual({ refreshes: 1, writes: 1 });
        expect(leases).toBe(3);
        expect(requests).toBe(3);

        minimumLeasesForRefresh = 6;
        await runTurns(clients);
        expect({ refreshes, writes }).toEqual({ refreshes: 2, writes: 2 });
        expect(leases).toBe(6);
        expect(requests).toBe(6);

        const master = await host.registry.create({ workspace: home });
        masterClient = await attachAgent({ socketPath: host.server.socketPath, agentId: master.id });
        expect((await masterClient.receive()).type).toBe("history");
        lifetimeSeconds = 3600;
        minimumLeasesForRefresh = 10;
        disk.setCredential(OPENAI_CODEX_PROVIDER_ID, expired());
        await runTurns([...clients, masterClient]);
        expect({ refreshes, writes }).toEqual({ refreshes: 3, writes: 3 });
        expect(leases).toBe(10);
        expect(requests).toBe(10);
        const stored = disk.getCredential(OPENAI_CODEX_PROVIDER_ID);
        if (stored?.type !== "oauth") throw new Error("Fixture credential unavailable");
        rejectedCredential = JSON.parse(stored.token).access_token;
        minimumLeasesForRefresh = 16;
        await runTurns(clients);
        expect({ refreshes, writes }).toEqual({ refreshes: 4, writes: 4 });
        expect(leases).toBe(16);
        expect(requests).toBe(16);
        echoCredential = true;
        await runTurns([clients[0]!]);
        expect(leases).toBe(17);
        expect(requests).toBe(17);
        disk.setCredential(OPENAI_CODEX_PROVIDER_ID, expired());
        failRefresh = true;
        const failed = runTurns(clients);
        try { await until(() => leases === 20); }
        finally { releaseFailedRefresh.resolve(); }
        const failures = await failed;
        expect(failures.map((result) => result.outcome)).toEqual(["error", "error", "error"]);
        expect({ refreshes, writes }).toEqual({ refreshes: 5, writes: 4 });
        expect(requests).toBe(17);
        failRefresh = false;
        echoCredential = false;
        minimumLeasesForRefresh = 23;
        await runTurns(clients);
        expect({ refreshes, writes }).toEqual({ refreshes: 6, writes: 5 });
        expect(leases).toBe(23);
        expect(requests).toBe(20);
        await checkFiles(join(home, "runtime", "sessions"), secrets);
        await checkFiles(join(home, "runtime", "logs"), secrets);
    } finally {
        releaseFailedRefresh.resolve();
        releaseRejections.resolve();
        masterClient?.close();
        for (const client of clients) client.close();
        try { await host?.close(); }
        finally {
            stub.stop(true);
            globalThis.fetch = originalFetch;
            brokerSpy.mockRestore();
            if (previousOptions === undefined) delete process.env.BUN_OPTIONS;
            else process.env.BUN_OPTIONS = previousOptions;
            if (previousPort === undefined) delete process.env.POOL_TEST_STUB_PORT;
            else process.env.POOL_TEST_STUB_PORT = previousPort;
            try {
                for (const pid of [...pids, ...(annexPid === undefined ? [] : [annexPid])]) {
                    expect(() => process.kill(pid, 0)).toThrow();
                }
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        }
    }
}, 90_000);

test("a worker obtains the current API key once per request", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7ck-");
    const disk = createAuthStorage({ path: defaultAuthStoragePath(home) });
    const first = randomUUID();
    const second = randomUUID();
    disk.setCredential("stub", { type: "api_key", key: first });
    let expected = first;
    let requests = 0;
    let correctHeaders = true;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            requests += 1;
            correctHeaders &&= request.headers.get("authorization") === `Bearer ${expected}`;
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The map is aboard."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    let leases = 0;
    const createBroker = credentials.createCredentialBroker;
    const brokerSpy = spyOn(credentials, "createCredentialBroker").mockImplementation((options) => {
        const broker = createBroker(options);
        return { ...broker, async lease(provider, rejected) { leases += 1; return await broker.lease(provider, rejected); } };
    });
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    let workerPid: number | undefined;
    let annexPid: number | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: { schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "api_key" } } },
        });
        annexPid = host.annexPid;
        const session = await createAgentThroughHost(host.server.socketPath, home);
        workerPid = (await requestHostIdentity(session.location!.socket_path))?.pid;
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        await runTurns([client]);
        expected = second;
        disk.setCredential("stub", { type: "api_key", key: second });
        await runTurns([client]);
        expect(requests).toBe(2);
        expect(leases).toBe(2);
        expect(correctHeaders).toBe(true);
        await checkFiles(join(home, "runtime", "sessions"), [first, second]);
        await checkFiles(join(home, "runtime", "logs"), [first, second]);
    } finally {
        client?.close();
        try { await host?.close(); }
        finally {
            stub.stop(true);
            brokerSpy.mockRestore();
            try {
                for (const pid of [workerPid, annexPid]) if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        }
    }
}, 60_000);

async function runTurns(clients: readonly AttachedAgentClient[]) {
    await Promise.all(clients.map((client) => client.send({ type: "prompt", content: "Where is the map?" })));
    return await Promise.all(clients.map(async (client) => {
        while (true) {
            const update = await client.receive(AbortSignal.timeout(20_000));
            if (update.type === "turn_finished") return update;
        }
    }));
}

async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Credential requests did not arrive");
        await Bun.sleep(10);
    }
}

async function checkFiles(directory: string, secrets: readonly string[]): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await checkFiles(path, secrets);
        if (entry.isFile()) {
            const text = await readFile(path, "utf8");
            if (secrets.some((secret) => text.includes(secret))) throw new Error("A credential appeared in a log or session file");
        }
    }
}

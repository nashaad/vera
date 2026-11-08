import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { processCommandLine, processStartedAt } from "../../src/host/process-identity.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { createAuthStorage, defaultAuthStoragePath } from "../../src/providers/auth-storage.ts";
import { OPENAI_CODEX_PROVIDER_ID } from "../../src/providers/openai-codex-oauth.ts";

interface PoolInfo {
    readonly pid: number;
    readonly workers: readonly number[];
    readonly annexPid?: number;
    readonly socket: string;
}

test("a worker does not repeat the master's interrupted credential refresh", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-refresh-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    createAuthStorage({ path: defaultAuthStoragePath(home) }).setCredential(OPENAI_CODEX_PROVIDER_ID, {
        type: "oauth", token: JSON.stringify({ schema_version: 1, access_token: randomUUID(), refresh_token: randomUUID(), expires_at: 1 }),
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let refreshes = 0;
    let requests = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (new URL(request.url).pathname.endsWith("/oauth/token")) {
                refreshes += 1;
                entered.resolve();
                await release.promise;
                return Response.json({ access_token: randomUUID(), refresh_token: randomUUID(), expires_in: 3_600 });
            }
            requests += 1;
            return new Response("not found", { status: 404 });
        },
    });
    const config = { schema_version: 1, provider: OPENAI_CODEX_PROVIDER_ID, model: "stub-model", approval_mode: "auto", curated_models_url: "" } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const preload = fileURLToPath(new URL("../support/pool-provider-preload.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "15000"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home, BUN_OPTIONS: `--preload=${preload}`, POOL_TEST_STUB_PORT: String(stub.port) },
        stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, { startedAt: number; command: string }>();
    let info: PoolInfo | undefined;
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) {
            const startedAt = processStartedAt(pid);
            const command = processCommandLine(pid);
            if (startedAt === undefined || command === undefined) throw new Error(`Could not inspect process ${pid}`);
            started.set(pid, { startedAt, command });
        }
        const session = await createAgentThroughHost(info.socket, home);
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Check the map." });
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Refresh did not start"); })]);
        child.kill("SIGKILL");
        await child.exited;
        release.resolve();
        let outcome: string | undefined;
        while (true) {
            const update = await client.receive(AbortSignal.timeout(10_000));
            if (update.type === "turn_finished") { outcome = update.outcome; break; }
        }
        expect(outcome).toBe("error");
        host = await startResidentHost({ home, config, webRoot, skipStartupDiscovery: true,
            credentialFetch: ((_input, init) => fetch(`http://127.0.0.1:${stub.port}/oauth/token`, init)) as typeof fetch });
        await Bun.sleep(500);
        expect(refreshes).toBe(1);
        expect(requests).toBe(0);
        expect(alive(info.workers[0]!)).toBe(true);
    } finally {
        release.resolve();
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await child.exited;
        for (const [pid, recorded] of started) {
            if (alive(pid)) {
                const startedAt = processStartedAt(pid);
                if (startedAt === undefined || Math.abs(startedAt - recorded.startedAt) > 2_000
                    || processCommandLine(pid) !== recorded.command) throw new Error(`Process ${pid} no longer matches`);
                try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            }
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
        stub.stop(true);
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 40_000);

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(10);
    }
}

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TITLE_PROMPT } from "../../extensions/titles/titles.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

const BUDGET = fileURLToPath(new URL("../../extensions/budget", import.meta.url));
const TITLES = fileURLToPath(new URL("../../extensions/titles", import.meta.url));

interface Mark {
    readonly kind: string;
    readonly pid: number;
    readonly session: string;
}

async function instrument(home: string, source: string, kind: "budget" | "titles", log: string): Promise<string> {
    const directory = join(home, kind);
    await mkdir(directory);
    await writeFile(join(directory, "vera.extension.json"), await readFile(join(source, "vera.extension.json")));
    const register = kind === "budget" ? `
        registerModelMiddleware(middleware) {
            return vera.hooks.registerModelMiddleware((adapter, context) => {
                const wrapped = middleware(adapter, context);
                return { ...wrapped, stream(request) {
                    mark("budget", context.sessionId);
                    return wrapped.stream(request);
                } };
            });
        }
    ` : `
        registerTurnFinished(hook) {
            return vera.hooks.registerTurnFinished((payload) => {
                mark("titles", payload.sessionId);
                return hook(payload);
            });
        }
    `;
    await writeFile(join(directory, "extension.ts"), `
        import { appendFileSync } from "node:fs";
        import { activate as original } from ${JSON.stringify(join(source, "extension.ts"))};
        const log = ${JSON.stringify(log)};
        function mark(kind, session) {
            appendFileSync(log, JSON.stringify({ kind, session, pid: process.pid }) + "\\n");
        }
        export function activate(vera) {
            const hooks = { ...vera.hooks, ${register} };
            return original({ ...vera, hooks });
        }
    `);
    return directory;
}

function marks(path: string): Mark[] {
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Mark) : [];
}

function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

test("budget middleware and titles hooks run once on each owning worker", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7bt-");
    const log = join(home, "marks.ndjson");
    const budget = await instrument(home, BUDGET, "budget", log);
    const titles = await instrument(home, TITLES, "titles", log);
    const requests: string[] = [];
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            const body = await request.text();
            requests.push(body);
            const content = body.includes(TITLE_PROMPT) ? "Crow voyage" : "The crow found the map.";
            const chunk = { id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    const workers = new Set<number>();
    const owners = new Set<number>();
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 2, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                model_assignments: { snappy: { models: [{ name: "crow", provider: "stub", model: "stub-model" }] } },
                extensions: [{ path: budget, enabled: true, config: {} }, { path: titles, enabled: true, config: {} }],
            },
        });
        for (let index = 0; index < 2; index += 1) {
            workers.add((await requestHostIdentity(join(home, "runtime", `w${index}.sock`)))!.pid);
        }
        expect(host.extensions.modelMiddleware().length).toBeGreaterThan(0);
        expect(host.extensions.turnFinishedHooks().some((hook) => hook.extensionId === "vera.titles")).toBe(true);
        const expected: Mark[] = [];
        for (const prompt of ["Chart the crow course", "Check the crow sails"]) {
            const agent = await createAgentThroughHost(host.server.socketPath, home);
            const workerPid = (await requestHostIdentity(agent.location!.socket_path))!.pid;
            workers.add(workerPid);
            owners.add(workerPid);
            client = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
            expect((await client.receive()).type).toBe("history");
            await client.runExtensionCommand!("budget", "5");
            await client.send({ type: "prompt", content: prompt });
            while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
            expected.push({ kind: "budget", pid: workerPid, session: agent.id }, { kind: "titles", pid: workerPid, session: agent.id });
            client.close();
            client = undefined;
        }
        const deadline = Date.now() + 5_000;
        while ((marks(log).length < expected.length || requests.filter((request) => request.includes(TITLE_PROMPT)).length < 2)
            && Date.now() < deadline) await Bun.sleep(10);
        expect(owners.size).toBe(2);
        const key = (entry: Mark): string => `${entry.kind}:${entry.session}:${entry.pid}`;
        expect(marks(log).map(key).sort()).toEqual(expected.map(key).sort());
        expect(marks(log).some((entry) => entry.pid === process.pid)).toBe(false);
        expect(requests.filter((request) => request.includes(TITLE_PROMPT))).toHaveLength(2);
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        const started = [...workers, ...(annexPid === undefined ? [] : [annexPid])];
        console.log(JSON.stringify({ stopped: started.filter((pid) => !running(pid)), stillLive: started.filter(running) }));
        expect(started.filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);

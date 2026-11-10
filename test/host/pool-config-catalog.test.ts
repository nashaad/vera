import { tmpdir } from "node:os";
import { expect, spyOn } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as config from "../../src/config.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { InboxAdmissionPolicy } from "../../src/host/inbox-admission.ts";
import { ControlPeer } from "../../src/host/pool/control.ts";
import * as globalServices from "../../src/host/pool/global-services.ts";
import * as supervisor from "../../src/host/pool/supervisor.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";

socketTest("worker settings writes go through the host and catalog replies are cached", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7cs-"));
    const configPath = join(home, "config.json");
    const initial = {
        schema_version: 1 as const, provider: "stub", model: "stub-model", approval_mode: "auto" as const,
        curated_models_url: "", providers: {
            stub: { protocol: "openai-chat" as const, base_url: "http://127.0.0.1:9/v1", credential: "none" as const },
        },
    };
    await writeFile(configPath, JSON.stringify(initial));
    let catalogRequests = 0;
    let settingRequests = 0;
    let preferenceRequests = 0;
    let poolCommits = 0;
    const notified = new Set<ControlPeer>();
    const sendEvent = ControlPeer.prototype.event;
    const eventSpy = spyOn(ControlPeer.prototype, "event").mockImplementation(function (this: ControlPeer, event, value) {
        if (event === "config_changed" && value === "config") notified.add(this);
        return sendEvent.call(this, event, value);
    });
    const createGlobals = globalServices.createHostGlobals;
    const globalsSpy = spyOn(globalServices, "createHostGlobals").mockImplementation((options) => {
        const globals = createGlobals(options);
        return { async handle(method, args) {
            if (method === "globals.catalog") catalogRequests += 1;
            if (method === "globals.contextLimit") settingRequests += 1;
            if (method === "globals.preferenceAdd") preferenceRequests += 1;
            if (method === "globals.poolCommit") poolCommits += 1;
            return await globals.handle(method, args);
        } };
    });
    const writeConfig = config.updateVeraConfigDefaults;
    const writers: number[] = [];
    const configSpy = spyOn(config, "updateVeraConfigDefaults").mockImplementation((patch, options) => {
        writers.push(process.pid);
        return writeConfig(patch, options);
    });
    const clients: AttachedAgentClient[] = [];
    const pids: number[] = [];
    let host: ResidentHost | undefined;
    let annexPid: number | undefined;
    try {
        host = await startResidentHost({ home, config: initial, processWorker: true, processWorkerCount: 3, skipStartupDiscovery: true });
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
        for (const [index, client] of clients.entries()) await readSettings(client, `first-${index}`);
        expect(catalogRequests).toBe(3);
        await readSettings(clients[0]!, "cached");
        expect(catalogRequests).toBe(3);

        await clients[0]!.send({ type: "update_model_settings", requestId: "save", patch: { contextLimit: 42_000 } });
        const saved = await waitForSettings(clients[0]!, "save");
        expect(saved.settings.contextLimit).toBe(42_000);
        expect(settingRequests).toBe(1);
        expect(writers).toEqual([process.pid]);
        await until(async () => notified.size === 3);
        expect(JSON.parse(await readFile(configPath, "utf8")).context_limit).toBe(42_000);
        for (const [index, client] of clients.entries()) {
            const settings = await readSettings(client, `after-${index}`);
            expect(settings.settings.contextLimit).toBe(42_000);
        }
        const afterChange = catalogRequests;
        expect(afterChange).toBe(6);
        await readSettings(clients[1]!, "cached-after-change");
        expect(catalogRequests).toBe(afterChange);

        await clients[0]!.send({ type: "update_model_settings", requestId: "new-default", patch: { model: "stub-next" } });
        await waitForSettings(clients[0]!, "new-default");
        const additional = [];
        for (let index = 0; index < 3; index += 1) additional.push(await createAgentThroughHost(host.server.socketPath, home));
        expect(new Set(additional.map((session) => session.location?.worker_id)).size).toBe(3);
        for (const [index, session] of additional.entries()) {
            const client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
            clients.push(client);
            expect((await client.receive()).type).toBe("history");
            expect((await readSettings(client, `default-${index}`)).settings.model).toBe("stub-next");
        }

        await clients[0]!.send({ type: "add_permission_preference", requestId: "grant", when: { operation: "git.push" } });
        const granted = await waitForPermissions(clients[0]!, "grant");
        expect(granted.inspection?.activePreferences).toHaveLength(1);
        expect(preferenceRequests).toBe(1);
        const savedPreferences = JSON.parse(await readFile(join(home, "preferences.json"), "utf8"));
        expect(savedPreferences).toHaveLength(1);
        await until(async () => {
            await clients[2]!.send({ type: "get_permissions", requestId: "other-permissions" });
            const update = await waitForPermissions(clients[2]!, "other-permissions");
            return update.inspection?.activePreferences?.length === 1;
        });

        await clients[1]!.send({ type: "pool_add", requestId: "keep", provider: "stub", model: "stub-model" });
        await waitForSettings(clients[1]!, "keep");
        expect(poolCommits).toBe(1);
        const pool = JSON.parse(await readFile(join(home, "pool.json"), "utf8"));
        expect(pool.models["stub/stub-model"].added).toBe(true);
    } finally {
        for (const client of clients) client.close();
        await host?.close();
        globalsSpy.mockRestore();
        configSpy.mockRestore();
        eventSpy.mockRestore();
        try {
            for (const pid of [...pids, ...(annexPid === undefined ? [] : [annexPid])]) {
                expect(() => process.kill(pid, 0)).toThrow();
            }
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 90_000);

socketTest("the host migrates configuration before starting a worker", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7cm-"));
    const path = join(home, "config.json");
    const initial = {
        schema_version: 1 as const, provider: "digitalocean", model: "fixture", approval_mode: "auto" as const,
        curated_models_url: "", providers: {
            digitalocean: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "api_key" },
        },
    };
    await writeFile(path, JSON.stringify(initial));
    const start = supervisor.startSessionWorkerSupervisor;
    let observed = false;
    const startSpy = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => {
        observed = true;
        expect(JSON.parse(readFileSync(path, "utf8")).providers).toBeUndefined();
        return start(options);
    });
    let host: ResidentHost | undefined;
    let workerPid: number | undefined;
    let annexPid: number | undefined;
    try {
        host = await startResidentHost({
            home, config: { schema_version: 1, provider: "digitalocean", model: "fixture", approval_mode: "auto", curated_models_url: "" },
            processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
        });
        annexPid = host.annexPid;
        workerPid = (await requestHostIdentity(join(home, "runtime", "w0.sock")))?.pid;
        expect(observed).toBe(true);
        expect(JSON.parse(await readFile(path, "utf8")).providers).toBeUndefined();
    } finally {
        try { await host?.close(); }
        finally {
            startSpy.mockRestore();
            try {
                for (const pid of [workerPid, annexPid]) if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
            } finally { await rm(home, { recursive: true, force: true }); }
        }
    }
}, 60_000);

socketTest("an override saved through one worker is reloaded by another with the selected home", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7co-"));
    const initial = {
        schema_version: 1 as const, provider: "stub", model: "stub-model", approval_mode: "auto" as const, curated_models_url: "",
        providers: { stub: { protocol: "openai-chat" as const, base_url: "http://127.0.0.1:9/v1", credential: "none" as const } },
    };
    await writeFile(join(home, "config.json"), JSON.stringify(initial));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const clients: AttachedAgentClient[] = [];
    const pids: number[] = [];
    let host: ResidentHost | undefined;
    let annexPid: number | undefined;
    try {
        host = await startResidentHost({ config: initial, processWorker: true, processWorkerCount: 2, skipStartupDiscovery: true });
        annexPid = host.annexPid;
        for (let index = 0; index < 2; index += 1) {
            const session = await createAgentThroughHost(host.server.socketPath, home);
            expect(session.location?.worker_id).toBe(`w${index}`);
            pids.push((await requestHostIdentity(session.location!.socket_path))!.pid);
            const client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
            clients.push(client);
            expect((await client.receive()).type).toBe("history");
        }
        await clients[1]!.send({ type: "update_model_settings", requestId: "set-override", patch: { overrides: { contextLimit: 32_768 } } });
        const saved = await waitForSettings(clients[1]!, "set-override");
        expect(saved.settings.contextLimit).toBe(32_768);
        const other = await readSettings(clients[0]!, "other-override");
        expect(other.settings.contextLimit).toBe(32_768);
        expect(other.settings.overrides?.rows.find((row) => row.key === "contextLimit")?.value).toBe(32_768);
    } finally {
        for (const client of clients) client.close();
        try { await host?.close(); }
        finally {
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            try {
                for (const pid of [...pids, ...(annexPid === undefined ? [] : [annexPid])]) expect(() => process.kill(pid, 0)).toThrow();
            } finally { await rm(home, { recursive: true, force: true }); }
        }
    }
}, 60_000);

socketTest("project inbox admissions from both workers and the host are written by the host", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7ch-"));
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const workspace = await mkdtemp(join(tmpdir(), "vera-dev", "h7cw-"));
    const path = join(workspace, ".vera", "config.json");
    const remember = InboxAdmissionPolicy.prototype.remember;
    const writers: number[] = [];
    const rememberSpy = spyOn(InboxAdmissionPolicy.prototype, "remember").mockImplementation(function (this: InboxAdmissionPolicy, family, scope) {
        if (scope === "project") writers.push(process.pid);
        return remember.call(this, family, scope);
    });
    const clients: AttachedAgentClient[] = [];
    const pids: number[] = [];
    let host: ResidentHost | undefined;
    let annexPid: number | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 2, skipStartupDiscovery: true,
            config: { schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } } },
        });
        annexPid = host.annexPid;
        const first = await createAgentThroughHost(host.server.socketPath, workspace);
        const second = await createAgentThroughHost(host.server.socketPath, workspace);
        expect([first.location?.worker_id, second.location?.worker_id]).toEqual(["w0", "w1"]);
        for (const session of [first, second]) {
            pids.push((await requestHostIdentity(session.location!.socket_path))!.pid);
        }
        const hostSession = await host.registry.create({ workspace });
        const sessions = [first, second, hostSession];
        for (const session of sessions) {
            const client = await attachAgent({ socketPath: host.server.socketPath, agentId: session.id });
            clients.push(client);
            expect((await client.receive()).type).toBe("history");
        }
        const inbox = host.registry.options.inboxDelivery!;
        const families = ["git", "filesystem", "schedule"];
        for (const [index, session] of sessions.entries()) {
            await inbox.append({ source: "fixture", kind: `${families[index]}.changed`, address: session.id, payload: "{}" });
        }
        const questions = await Promise.all(clients.map((client) => receiveQuestion(client)));
        await Promise.all(clients.map((client, index) => client.send({ type: "ui_response", requestId: questions[index]!.requestId,
            response: { type: "user_question", outcome: "selected", choiceId: "always" } })));
        const scopes = await Promise.all(clients.map((client) => receiveQuestion(client)));
        await Promise.all(clients.map((client, index) => client.send({ type: "ui_response", requestId: scopes[index]!.requestId,
            response: { type: "user_question", outcome: "selected", choiceId: "project" } })));
        await until(async () => {
            try { return JSON.parse(await readFile(path, "utf8")).inbox.admit.length === 3; }
            catch { return false; }
        });
        const config = JSON.parse(await readFile(path, "utf8"));
        expect(new Set(config.inbox.admit)).toEqual(new Set(families));
        expect(writers).toEqual([process.pid, process.pid, process.pid]);
    } finally {
        for (const client of clients) client.close();
        try { await host?.close(); }
        finally {
            rememberSpy.mockRestore();
            try {
                for (const pid of [...pids, ...(annexPid === undefined ? [] : [annexPid])]) expect(() => process.kill(pid, 0)).toThrow();
            } finally {
                await rm(home, { recursive: true, force: true });
                await rm(workspace, { recursive: true, force: true });
            }
        }
    }
}, 60_000);

async function receiveQuestion(client: AttachedAgentClient) {
    while (true) {
        const update = await client.receive(AbortSignal.timeout(15_000));
        if (update.type === "ui_request") return update;
    }
}

async function readSettings(client: AttachedAgentClient, requestId: string) {
    await client.send({ type: "get_model_settings", requestId });
    return await waitForSettings(client, requestId);
}

async function waitForSettings(client: AttachedAgentClient, requestId: string) {
    while (true) {
        const update = await client.receive(AbortSignal.timeout(15_000));
        if (update.type === "model_settings" && update.requestId === requestId) return update;
        if (update.type === "model_settings_rejected" && update.requestId === requestId) throw new Error("Settings request was rejected");
    }
}

async function waitForPermissions(client: AttachedAgentClient, requestId: string) {
    while (true) {
        const update = await client.receive(AbortSignal.timeout(15_000));
        if (update.type === "permissions" && update.requestId === requestId) return update;
        if (update.type === "permissions_rejected" && update.requestId === requestId) throw new Error("Permission request was rejected");
    }
}

async function until(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!await check()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for worker state");
        await Bun.sleep(20);
    }
}

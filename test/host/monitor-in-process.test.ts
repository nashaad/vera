import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { ProcessObservationCoordinator } from "../../src/host/process-observations.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { defaultInboxPath } from "../../src/store/inbox.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { socketTest } from "../support/socket-probe.ts";

socketTest("@core a detached conversation receives and acts on its monitored command outcome", async () => {
    await mkdir(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "monitor-turn-"));
    const adapter = new FauxAdapter([
        toolCall(), text("Crow is watching."), text("Crow saw the map."), text("Crow is ready again."),
    ]);
    const host = await startResidentHost({
        home, inProcessWorker: true, createAdapter: () => adapter,
        config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" },
    });
    let client: AttachedAgentClient | undefined;
    try {
        const owner = await createAgentThroughHost(host.server.socketPath, home);
        const path = (await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === owner.id)!.session_path;
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: owner.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Watch the crow command." });
        const first = await readToFinished(client);
        expect(JSON.stringify(first)).toContain("Started process");
        client.close();
        client = undefined;
        await waitFor(async () => (await readFile(path, "utf8")).includes("Crow saw the map."));
        const transcript = await readFile(path, "utf8");
        expect(transcript).toContain("Crow checks the hold");
        expect(transcript).toContain("Exited with code 7");
        expect(transcript).toContain("crow found the map");
        expect(transcript).toContain("Crow saw the map.");
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: owner.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Are you ready?" });
        const next = await readToFinished(client);
        expect(JSON.stringify(next)).toContain("Crow is ready again.");
    } finally {
        client?.close();
        const annexPid = host.annexPid;
        await host.close();
        if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

socketTest("@core a lost start acknowledgement wakes the owner and leaves the next turn usable", async () => {
    await mkdir(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "monitor-uncertain-"));
    const adapter = new FauxAdapter([
        toolCall(), text("Crow heard the refusal."), text("Crow saw the interruption."), text("Crow is ready again."),
    ]);
    const original = ProcessObservationCoordinator.prototype.start;
    let injected = false;
    ProcessObservationCoordinator.prototype.start = function(executor, observation) {
        original.call(this, executor, observation);
        if (!injected) { injected = true; throw new Error("crow acknowledgement lost"); }
    };
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        host = await startResidentHost({
            home, inProcessWorker: true, createAdapter: () => adapter,
            config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" },
        });
        const owner = await createAgentThroughHost(host.server.socketPath, home);
        const path = (await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === owner.id)!.session_path;
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: owner.id });
        await client.receive();
        await client.send({ type: "prompt", content: "Watch the crow command." });
        expect(JSON.stringify(await readToFinished(client))).toContain("crow acknowledgement lost");
        client.close();
        client = undefined;
        await waitFor(async () => (await readFile(path, "utf8")).includes("Crow saw the interruption."));
        const transcript = await readFile(path, "utf8");
        expect(transcript).toContain("Interrupted before its outcome could be confirmed");
        const inbox = new Database(defaultInboxPath(home), { readonly: true });
        try {
            expect(inbox.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM producer_entries WHERE producer_source = 'vera.process-observation'").get()?.count).toBe(1);
        } finally { inbox.close(); }
        await waitFor(async () => (await listAgentsThroughHost(host!.server.socketPath)).find((row) => row.id === owner.id)?.status === "idle");
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: owner.id });
        await client.receive();
        await client.send({ type: "prompt", content: "Are you ready?" });
        expect(JSON.stringify(await readToFinished(client))).toContain("Crow is ready again.");
    } finally {
        ProcessObservationCoordinator.prototype.start = original;
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

socketTest("@core failed outcome admission is visible and replayed after restart", async () => {
    await mkdir(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "monitor-admission-"));
    const adapter = new FauxAdapter([
        toolCall(), text("Crow is watching."), text("Crow saw the map."), text("Crow is ready again."),
    ]);
    const options = {
        home, inProcessWorker: true, createAdapter: () => adapter,
        config: { schema_version: 1 as const, provider: "openrouter", model: "faux/test", approval_mode: "auto" as const },
    };
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    let database: Database | undefined;
    try {
        host = await startResidentHost(options);
        const owner = await createAgentThroughHost(host.server.socketPath, home);
        const path = (await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === owner.id)!.session_path;
        database = new Database(defaultInboxPath(home));
        database.exec("CREATE TRIGGER crow_refuse_admission BEFORE INSERT ON admitted_entries BEGIN SELECT RAISE(ABORT, 'crow admission refused'); END");
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: owner.id });
        await client.receive();
        await client.send({ type: "prompt", content: "Watch the crow command." });
        expect(JSON.stringify(await readToFinished(client))).toContain("Started process");
        await waitFor(async () => (await readFile(path, "utf8")).includes("Could not confirm delivery of monitored process"));
        expect(await readFile(path, "utf8")).toContain("any saved outcome will be retried when the host restarts");
        expect(database.query<{ outcome: string; exit_code: number }, []>(
            "SELECT outcome, exit_code FROM process_observations",
        ).all()).toEqual([{ outcome: "settled", exit_code: 7 }]);
        database.exec("DROP TRIGGER crow_refuse_admission");
        database.close();
        database = undefined;
        client.close();
        client = undefined;
        await host.close();
        host = await startResidentHost(options);
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: owner.id });
        await client.receive();
        expect(JSON.stringify(await readToFinished(client))).toContain("Crow saw the map.");
        await waitFor(async () => (await readFile(path, "utf8")).includes("Crow saw the map."));
        const transcript = await readFile(path, "utf8");
        expect(transcript).toContain("Exited with code 7");
        expect(transcript).toContain("crow found the map");
        await waitFor(async () => (await listAgentsThroughHost(host!.server.socketPath)).find((row) => row.id === owner.id)?.status === "idle");
        await client.send({ type: "prompt", content: "Are you ready?" });
        expect(JSON.stringify(await readToFinished(client))).toContain("Crow is ready again.");
    } finally {
        database?.close();
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);

function toolCall(): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id: "crow-call", name: "monitor", input: {
            command: "sleep 0.3; printf 'crow found the map\\n'; exit 7", description: "Crow checks the hold",
        } }],
        source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
    };
}

function text(value: string): AssistantMessage {
    return {
        role: "assistant", content: [{ type: "text", text: value }],
        source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop",
    };
}

async function readToFinished(client: AttachedAgentClient): Promise<unknown[]> {
    const updates: unknown[] = [];
    while (true) {
        const update = await client.receive(AbortSignal.timeout(8_000));
        updates.push(update);
        if (update.type === "turn_finished") return updates;
    }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (!await predicate()) {
        if (Date.now() >= deadline) throw new Error("Detached monitor wake timed out");
        await Bun.sleep(10);
    }
}

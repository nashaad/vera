import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { CORE_EXTENSIONS_DIRECTORY } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { ProcessObservationCoordinator } from "../../src/host/process-observations.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import type { HostRouter } from "../../src/host/pool/router.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { sessionEndpoint } from "../../src/host/session-host/endpoint.ts";
import type { SessionHost } from "../../src/host/session-host/types.ts";
import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { socketTest } from "../support/socket-probe.ts";

test("@core an observed command keeps only its detached owner resident through idle parking", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-monitor-park-"));
    const settlementStarted = Promise.withResolvers<void>();
    const releaseSettlement = Promise.withResolvers<void>();
    const processes = new ManagedProcessRegistry({
        onObservationStarted: async () => {},
        onObservationSettled: async () => {
            settlementStarted.resolve();
            await releaseSettlement.promise;
        },
    });
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
    });
    Reflect.set(registry, "processRegistry", processes);
    const endpoint = sessionEndpoint({ registry } as SessionHost);
    try {
        const owner = await registry.create({
            id: "monitored",
            workspace: root,
            sessionPath: join(root, "monitored.jsonl"),
        });
        await registry.create({
            id: "unrelated",
            workspace: root,
            sessionPath: join(root, "unrelated.jsonl"),
        });
        const attachment = owner.attach();
        attachment.detach();
        const scope = processes.scope(owner.id);
        const result = await scope.run({
            command: "exec sleep 30",
            cwd: root,
            env: process.env,
            interactive: false,
            yieldAfterMs: 10,
            observation: { extensionId: "monitor", description: "long command" },
        });
        expect(result.kind).toBe("running");
        if (result.kind !== "running") throw new Error("Observed command did not yield");
        expect(owner.idleForShutdown()).toBe(true);
        expect((await endpoint.parkFacts()).find((fact) => fact.id === owner.id)?.idle).toBe(false);
        expect(await endpoint.release(owner.id)).toBeUndefined();

        const later = Date.now() + 11 * 60_000;
        await registry.parkExpiredIdle(later);
        expect(registry.find(owner.id)).toBeDefined();
        expect(registry.find("unrelated")).toBeUndefined();
        expect(scope.read(result.snapshot.processId)?.status).toBe("running");

        await scope.kill(result.snapshot.processId);
        await Promise.race([settlementStarted.promise, Bun.sleep(2_000).then(() => { throw new Error("Settlement timed out"); })]);
        expect(scope.read(result.snapshot.processId)).toBeUndefined();
        expect((await endpoint.parkFacts()).find((fact) => fact.id === owner.id)?.idle).toBe(false);
        await registry.parkExpiredIdle(later);
        expect(registry.find(owner.id)).toBeDefined();

        releaseSettlement.resolve();
        await waitUntilUnpinned(processes, owner.id);
        expect((await endpoint.parkFacts()).find((fact) => fact.id === owner.id)?.idle).toBe(true);
        await registry.parkExpiredIdle(later);
        expect(registry.find(owner.id)).toBeUndefined();
    } finally {
        releaseSettlement.resolve();
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
}, 10_000);

socketTest("@core pooled idle parking preserves an observed owner but parks an unrelated worker session", async () => {
    await mkdir(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "monitor-park-"));
    const host = await startResidentHost({
        home,
        config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "ask" },
        inProcessWorker: true,
        createAdapter: () => new FauxAdapter([]),
    });
    const settled = Promise.withResolvers<void>();
    Reflect.set(host.registry.processRegistry, "onObservationStarted", async () => {});
    Reflect.set(host.registry.processRegistry, "onObservationSettled", async () => { settled.resolve(); });
    try {
        const owner = await host.registry.create({ workspace: home });
        const unrelated = await createAgentThroughHost(host.server.socketPath, home);
        const attachment = owner.attach();
        attachment.detach();
        const scope = host.registry.processRegistry.scope(owner.id);
        const result = await scope.run({
            command: "exec sleep 30",
            cwd: home,
            env: process.env,
            interactive: false,
            yieldAfterMs: 10,
            observation: { extensionId: "monitor", description: "long command" },
        });
        expect(result.kind).toBe("running");
        if (result.kind !== "running") throw new Error("Observed command did not yield");
        const router = host.registry.subagentSessions as HostRouter;
        const later = Date.now() + 11 * 60_000;
        await router.parkIdle(later);
        let rows = await listAgentsThroughHost(host.server.socketPath);
        expect(rows.find((row) => row.id === owner.id)?.live).toBe(true);
        expect(rows.find((row) => row.id === unrelated.id)?.live).toBe(false);
        expect(scope.read(result.snapshot.processId)?.status).toBe("running");

        await scope.kill(result.snapshot.processId);
        await Promise.race([settled.promise, Bun.sleep(2_000).then(() => { throw new Error("Settlement timed out"); })]);
        await waitUntilUnpinned(host.registry.processRegistry, owner.id);
        await router.parkIdle(later);
        rows = await listAgentsThroughHost(host.server.socketPath);
        expect(rows.find((row) => row.id === owner.id)?.live).toBe(false);
    } finally {
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

test("@core a real headless child pins only its owner through command and outcome handoff", async () => {
    await mkdir(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "monitor-headless-idle-"));
    const previousHome = process.env.VERA_HOME;
    const previousExtensions = process.env.VERA_WORKER_EXTENSIONS;
    process.env.VERA_HOME = home;
    process.env.VERA_WORKER_EXTENSIONS = "1";
    const inbox = Inbox.open(join(home, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"));
    const monitor = { path: join(CORE_EXTENSIONS_DIRECTORY, "monitor"), enabled: true, config: null };
    const extensions = await startExtensionRegistry({ extensions: [monitor], storageRoots: { profile: home, machine: home } });
    const observations = new ProcessObservationCoordinator(inbox, delivery, extensions);
    const started = Promise.withResolvers<{ ownerId: string; pid: number }>();
    const handingOff = Promise.withResolvers<void>();
    const releaseHandoff = Promise.withResolvers<void>();
    const registry = new AgentRegistry({
        home,
        createAdapter: () => new FauxAdapter([]),
        workerExtensions: () => [monitor],
        workerAdapterSpec: () => ({
            module: fileURLToPath(new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url)),
            options: { script: [headlessMonitorCall(), headlessText("Crow is watching."), headlessText("Crow is ready.")] },
        }),
        processObservations: {
            async onObservationStarted(observation) {
                observations.start("local:headless-test", observation);
                started.resolve(observation);
            },
            async onObservationSettled(settlement) {
                handingOff.resolve();
                await releaseHandoff.promise;
                await observations.settle("local:headless-test", settlement);
            },
            async onObservationInterrupted(observation) {
                await observations.interruptObservation("local:headless-test", observation);
            },
        },
        model: "faux/test", approvalMode: "full_access",
    });
    const endpoint = sessionEndpoint({ registry } as SessionHost);
    let childPid: number | undefined;
    try {
        const owner = await registry.create({ id: "crow-owner", workspace: home, sessionPath: join(home, "crow-owner.jsonl") });
        await registry.create({ id: "crow-other", workspace: home, sessionPath: join(home, "crow-other.jsonl") });
        const attachment = owner.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({ type: "prompt", content: "Watch the crow command." });
        while ((await attachment.receive()).type !== "turn_finished") {}
        attachment.detach();
        const observation = await started.promise;
        const worker = registry.agents.get(owner.id)?.worker;
        childPid = worker?.pid;
        expect(childPid).toBeDefined();
        expect(childPid).not.toBe(process.pid);
        expect(observation.ownerId).toBe(owner.id);
        expect(() => process.kill(observation.pid, 0)).not.toThrow();
        expect(registry.processRegistry.hasUnsettledObservedProcess(owner.id)).toBe(false);
        expect(worker?.hasUnsettledObservations).toBe(true);
        expect(owner.idleForShutdown()).toBe(true);
        expect((await endpoint.parkFacts()).find((fact) => fact.id === owner.id)?.idle).toBe(false);
        expect(await endpoint.release(owner.id)).toBeUndefined();
        expect(registry.idleForShutdown()).toBe(false);
        const later = Date.now() + 11 * 60_000;
        await registry.parkExpiredIdle(later);
        expect(registry.find(owner.id)).toBeDefined();
        expect(registry.find("crow-other")).toBeUndefined();
        await Promise.race([handingOff.promise, Bun.sleep(8_000).then(() => { throw new Error("Child outcome timed out"); })]);
        expect(worker?.hasUnsettledObservations).toBe(true);
        expect((await endpoint.parkFacts()).find((fact) => fact.id === owner.id)?.idle).toBe(false);
        await registry.parkExpiredIdle(later);
        expect(registry.find(owner.id)).toBeDefined();
        releaseHandoff.resolve();
        const deadline = Date.now() + 5_000;
        while (worker?.hasUnsettledObservations) {
            if (Date.now() > deadline) throw new Error("Child handoff did not finish");
            await Bun.sleep(10);
        }
        expect(inbox.readAfter(0, { limit: 10 })[0]).toMatchObject({ address: owner.id, kind: "process.exited" });
        expect((await endpoint.parkFacts()).find((fact) => fact.id === owner.id)?.idle).toBe(true);
        const next = owner.attach();
        await next.receive();
        next.send({ type: "prompt", content: "Are you ready?" });
        const updates = [];
        while (true) {
            const update = await next.receive();
            updates.push(update);
            if (update.type === "turn_finished") break;
        }
        expect(JSON.stringify(updates)).toContain("Crow is ready.");
        next.detach();
        await registry.parkExpiredIdle(later);
        expect(registry.find(owner.id)).toBeUndefined();
    } finally {
        releaseHandoff.resolve();
        try {
            await registry.close();
            if (childPid !== undefined) expect(() => process.kill(childPid!, 0)).toThrow();
        } finally {
            await extensions.close();
            delivery.close();
            inbox.close();
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            if (previousExtensions === undefined) delete process.env.VERA_WORKER_EXTENSIONS;
            else process.env.VERA_WORKER_EXTENSIONS = previousExtensions;
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

test("@core a lost headless executor stops its command and replays the interruption to its owner", async () => {
    await mkdir(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "monitor-child-loss-"));
    const previousHome = process.env.VERA_HOME;
    const previousExtensions = process.env.VERA_WORKER_EXTENSIONS;
    process.env.VERA_HOME = home;
    process.env.VERA_WORKER_EXTENSIONS = "1";
    const inbox = Inbox.open(join(home, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"));
    const monitor = { path: join(CORE_EXTENSIONS_DIRECTORY, "monitor"), enabled: true, config: null };
    const extensions = await startExtensionRegistry({ extensions: [monitor], storageRoots: { profile: home, machine: home } });
    const observations = new ProcessObservationCoordinator(inbox, delivery, extensions);
    const started = Promise.withResolvers<{ ownerId: string; pid: number }>();
    let registry = new AgentRegistry({
        home, model: "faux/test", approvalMode: "full_access", inboxDelivery: delivery,
        createAdapter: () => new FauxAdapter([]), workerExtensions: () => [monitor],
        workerAdapterSpec: () => ({
            module: fileURLToPath(new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url)),
            options: { script: [headlessMonitorCall("exec sleep 30"), headlessText("Crow is watching.")] },
        }),
        processObservations: {
            async onObservationStarted(observation) {
                observations.start("local:headless-loss", observation);
                started.resolve(observation);
            },
            async onObservationSettled(settlement) { await observations.settle("local:headless-loss", settlement); },
            async onObservationInterrupted(observation) { await observations.interruptObservation("local:headless-loss", observation); },
        },
    });
    const path = join(home, "crow-owner.jsonl");
    let workerPid: number | undefined;
    let commandPid: number | undefined;
    try {
        const owner = await registry.create({ id: "crow-owner", workspace: home, sessionPath: path });
        const attachment = owner.attach();
        await attachment.receive();
        attachment.send({ type: "prompt", content: "Watch the crow command." });
        while ((await attachment.receive(AbortSignal.timeout(8_000))).type !== "turn_finished") {}
        attachment.detach();
        const observation = await started.promise;
        const worker = registry.agents.get(owner.id)!.worker!;
        workerPid = worker.pid;
        commandPid = observation.pid;
        expect(workerPid).not.toBe(process.pid);
        expect(observation.ownerId).toBe(owner.id);
        expect(() => process.kill(commandPid!, 0)).not.toThrow();
        worker.kill();
        expect((await worker.outcome).kind).not.toBe("finished");
        expect(() => process.kill(commandPid!, 0)).toThrow();
        expect(inbox.processObservations.allRunning("", 10)).toEqual([]);
        expect(inbox.readAfter(0, { limit: 10 })).toMatchObject([{ address: owner.id, kind: "process.interrupted" }]);
        await registry.close();

        registry = new AgentRegistry({
            home, model: "faux/test", approvalMode: "auto", inboxDelivery: delivery,
            createAdapter: () => new FauxAdapter([headlessText("Crow saw the interruption."), headlessText("Crow is ready.")]),
        });
        const resumed = await registry.resume({ sessionPath: path });
        const deadline = Date.now() + 5_000;
        while (!(await readFile(path, "utf8")).includes("Crow saw the interruption.")) {
            if (Date.now() > deadline) throw new Error("Interrupted outcome was not replayed");
            await Bun.sleep(10);
        }
        expect(await readFile(path, "utf8")).toContain("Interrupted before its outcome could be confirmed");
        const next = resumed.attach();
        await next.receive();
        next.send({ type: "prompt", content: "Are you ready?" });
        const updates = [];
        while (true) {
            const update = await next.receive(AbortSignal.timeout(5_000));
            updates.push(update);
            if (update.type === "turn_finished") break;
        }
        expect(JSON.stringify(updates)).toContain("Crow is ready.");
        next.detach();
    } finally {
        try {
            await registry.close();
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (commandPid !== undefined) expect(() => process.kill(commandPid!, 0)).toThrow();
        } finally {
            await extensions.close();
            delivery.close();
            inbox.close();
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            if (previousExtensions === undefined) delete process.env.VERA_WORKER_EXTENSIONS;
            else process.env.VERA_WORKER_EXTENSIONS = previousExtensions;
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

function headlessMonitorCall(command = "sleep 4; printf 'crow found the map\\n'"): AssistantMessage {
    return {
        role: "assistant", content: [{ type: "tool_call", id: "crow-call", name: "monitor", input: {
            command, description: "Crow checks the hold",
        } }], source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
    };
}

function headlessText(text: string): AssistantMessage {
    return { role: "assistant", content: [{ type: "text", text }], source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop" };
}

async function waitUntilUnpinned(processes: ManagedProcessRegistry, ownerId: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (processes.hasUnsettledObservedProcess(ownerId)) {
        if (Date.now() >= deadline) throw new Error("Observation handoff timed out");
        await Bun.sleep(1);
    }
}

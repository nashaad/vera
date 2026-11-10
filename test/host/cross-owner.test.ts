import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { branchAgentThroughHost, createAgentThroughHost, resumeAgentThroughHost, syncAgentContextThroughHost } from "../../src/host/agent-start-client.ts";
import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { connectHost } from "../../src/host/connection.ts";
import { HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE, HOST_CAPABILITY_WORK_INDEX } from "../../src/host/capabilities.ts";
import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import type { HostRouter } from "../../src/host/pool/router.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { searchSessionsThroughHost } from "../../src/host/session-search-client.ts";
import { blockSessionThroughHost, unblockSessionThroughHost } from "../../src/host/session-block-client.ts";
import { importSessionThroughHost } from "../../src/host/session-import-client.ts";
import { checkpointStoresThroughHost } from "../../src/host/store-checkpoint-client.ts";
import { trashSessionThroughHost } from "../../src/host/session-trash-client.ts";
import { renameSessionThroughHost } from "../../src/host/session-rename-client.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { defaultSessionDirectory, SessionStore } from "../../src/store/session-store.ts";
import { searchSessions } from "../../src/store/session-search.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const config = { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "ask" } as const;

async function createTestHome(): Promise<string> {
    await mkdir("/private/tmp/vera-dev", { recursive: true });
    return mkdtemp("/private/tmp/vera-dev/hs4-cross-");
}

socketTest("rename reaches sessions on both owners", async () => {
    const home = await createTestHome();
    const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]) });
    let client: AttachedAgentClient | undefined;
    try {
        const hostSession = await host.registry.create({ workspace: home });
        const worker = await createAgentThroughHost(host.server.socketPath, home);
        for (const [id, title] of [[hostSession.id, "Host crow"], [worker.id, "Worker crow"]] as const) {
            expect(await renameSessionThroughHost(host.server.socketPath, id, title)).toEqual({ status: "renamed", name: title });
            const row = (await listAgentsThroughHost(host.server.socketPath)).find((candidate) => candidate.id === id)!;
            expect((await SessionStore.open(row.session_path)).name()).toBe(title);
            client = await attachAgent({ socketPath: host.server.socketPath, agentId: id });
            expect((await client.receive()).type).toBe("history");
            expect(await renameSessionThroughHost(host.server.socketPath, id, "Busy crow")).toEqual({ status: "rejected", reason: "busy" });
            client.close();
            client = undefined;
        }
    } finally {
        client?.close();
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("trashing a stored session does not block unrelated sessions", async () => {
    const home = await createTestHome();
    const path = join(defaultSessionDirectory(home), "stored-trash.jsonl");
    await SessionStore.create(path, { sessionId: "stored-trash", cwd: home });
    const moving = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const host = await startResidentHost({
        home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]),
        trashSessionArtifacts: async (artifacts) => {
            moving.resolve();
            await release.promise;
            await rm(artifacts.sessionPath);
        },
    });
    try {
        const trashing = trashSessionThroughHost(host.server.socketPath, "stored-trash");
        await moving.promise;
        const error = await resumeAgentThroughHost(host.server.socketPath, path).then(() => undefined, (failure: Error) => failure.message);
        expect(error).toContain("This conversation is being moved to the trash.");
        const unrelated = await Promise.race([
            createAgentThroughHost(host.server.socketPath, home).then(() => "created"),
            Bun.sleep(2_000).then(() => "timed out"),
        ]);
        expect(unrelated).toBe("created");
        release.resolve();
        expect(await trashing).toEqual({ status: "trashed" });
    } finally {
        release.resolve();
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("trash closes a cross-owner child that registers during the move", async () => {
    const home = await createTestHome();
    const starting = Promise.withResolvers<void>();
    const startChild = Promise.withResolvers<void>();
    const moving = Promise.withResolvers<void>();
    const finishMove = Promise.withResolvers<void>();
    const host = await startResidentHost({
        home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]),
        trashSessionArtifacts: async (artifacts) => {
            moving.resolve();
            await finishMove.promise;
            await rm(artifacts.sessionPath);
        },
    });
    const originalStart = host.registry.start;
    try {
        const parent = await createAgentThroughHost(host.server.socketPath, home);
        host.registry.start = async (...args: Parameters<typeof originalStart>) => {
            if (args[0].header.id === "late-trash-child") {
                starting.resolve();
                await startChild.promise;
            }
            return originalStart.apply(host.registry, args);
        };
        const child = host.registry.createWithKind(
            { id: "late-trash-child", workspace: home }, "background", { approvalMode: "auto", parentId: parent.id },
        );
        await starting.promise;
        const trashing = trashSessionThroughHost(host.server.socketPath, parent.id);
        await moving.promise;
        startChild.resolve();
        await child;
        finishMove.resolve();
        expect(await trashing).toEqual({ status: "trashed" });
        expect(host.registry.agents.has("late-trash-child")).toBe(false);
        expect((await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === "late-trash-child")?.live).toBe(false);
    } finally {
        startChild.resolve();
        finishMove.resolve();
        host.registry.start = originalStart;
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("close includes a cross-owner child that registers while it waits", async () => {
    const home = await createTestHome();
    const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]) });
    const release = Promise.withResolvers<void>();
    try {
        const parent = await host.registry.create({ workspace: home });
        const entry = host.registry.agents.get(parent.id)!;
        const originalRun = entry.run;
        entry.run = release.promise.then(() => originalRun);
        const closing = closeAgentThroughHost(host.server.socketPath, parent.id);
        const deadline = Date.now() + 5_000;
        while (!entry.agent.closed) {
            if (Date.now() >= deadline) throw new Error("Parent did not begin closing");
            await Bun.sleep(10);
        }
        const childId = "late-close-child";
        const path = join(defaultSessionDirectory(home), `${childId}.jsonl`);
        await SessionStore.create(path, { sessionId: childId, cwd: home, parentId: parent.id });
        const connection = await connectHost({ socketPath: host.server.socketPath });
        try {
            await connection.send({ type: "locate_agent", agent_id: childId });
            expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0" });
        } finally {
            connection.close();
        }
        release.resolve();
        expect(await closing).toEqual({ status: "closed", sessionRetained: true });
        const rows = await listAgentsThroughHost(host.server.socketPath);
        expect(rows.find((row) => row.id === childId)?.live).toBe(false);
    } finally {
        release.resolve();
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("native peers find and message each other across owners", async () => {
    const home = await createTestHome();
    let script: readonly AssistantMessage[] = [];
    const host = await startResidentHost({
        home, config, inProcessWorker: true,
        createAdapter: () => new FauxAdapter(script),
    });
    let client: AttachedAgentClient | undefined;
    try {
        const hostSession = await host.registry.create({ workspace: home });
        const worker = await createAgentThroughHost(host.server.socketPath, home);
        const otherWorkspace = join(home, "other");
        await mkdir(otherWorkspace);
        const stranger = await createAgentThroughHost(host.server.socketPath, otherWorkspace);
        const roster = await host.registry.applyAgentRosterEffect(hostSession.id, true);
        const participants = JSON.parse(roster.output).participants.map((entry: { participant_id: string }) => entry.participant_id);
        expect(participants).toContain(worker.id);
        expect(participants).not.toContain(stranger.id);
        expect(await host.registry.applyAgentSendEffect(hostSession.id, { type: "agent_send", to: stranger.id, text: "Outside." }))
            .toMatchObject({ isError: true, output: "agent_send recipients must be in the same workspace." });
        const outgoing = await host.registry.applyAgentSendEffect(hostSession.id, {
            type: "agent_send", to: worker.id, text: "A crow found the map.",
        });
        expect(outgoing.isError).toBe(false);
        expect(JSON.parse(outgoing.output)).toMatchObject({ stored: true, delivered: false, not_delivered_because: "approval_mode" });

        script = [
            toolCall("roster", "agent_roster", { details: true }),
            toolCall("read", "agent_inbox", {}),
            toolCall("send", "agent_send", { to: hostSession.id, text: "The map is aboard.", reply_to: JSON.parse(outgoing.output).message_id }),
            textResponse("Sent."),
        ];
        const path = (await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === worker.id)!.session_path;
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: worker.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Check the crow's crew." });
        while ((await client.receive(AbortSignal.timeout(5_000))).type !== "turn_finished") {}
        const messages = (await SessionStore.open(path)).messages();
        const results = messages.flatMap((message) => message.role === "tool_result" ? [message.content[0]?.text] : []);
        expect(JSON.parse(results[0] ?? "{}").participants.map((entry: { participant_id: string }) => entry.participant_id))
            .toContain(hostSession.id);
        expect(JSON.parse(results[1] ?? "{}")).toMatchObject({ from: hostSession.id, to: worker.id, text: "A crow found the map." });
        expect(JSON.parse(results[2] ?? "{}")).toMatchObject({ stored: true, delivered: false, not_delivered_because: "approval_mode", reply_to_applied: true });
        await host.registry.agents.get(hostSession.id)!.store.appendMessage({ role: "user", content: [{ type: "text", text: "A crow found the map." }] });
        const search = await searchSessionsThroughHost(host.server.socketPath, { query: "crow" });
        expect(search.results.map((result) => result.session_id).sort()).toEqual([hostSession.id, worker.id].sort());
        expect(search.truncated).toBe(false);
    } finally {
        client?.close();
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

for (const moved of ["source", "branch"] as const) {
    socketTest(`branch context sync reaches the ${moved === "source" ? "worker source" : "worker branch"}`, async () => {
        const home = await createTestHome();
        const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([textResponse("The map is aboard.")]) });
        let sourceClient: AttachedAgentClient | undefined;
        let branchClient: AttachedAgentClient | undefined;
        try {
            const source = await host.registry.create({ workspace: home });
            const branch = await branchAgentThroughHost(host.server.socketPath, source.id, "at");
            const rows = await listAgentsThroughHost(host.server.socketPath);
            const sourcePath = rows.find((row) => row.id === source.id)!.session_path;
            const branchPath = rows.find((row) => row.id === branch.id)!.session_path;
            await resumeAgentThroughHost(host.server.socketPath, moved === "source" ? sourcePath : branchPath);
            sourceClient = await attachAgent({ socketPath: host.server.socketPath, agentId: source.id });
            branchClient = await attachAgent({ socketPath: host.server.socketPath, agentId: branch.id });
            expect((await sourceClient.receive()).type).toBe("history");
            expect((await branchClient.receive()).type).toBe("history");
            await sourceClient.send({ type: "prompt", content: "Where is the crow's map?" });
            while ((await sourceClient.receive(AbortSignal.timeout(5_000))).type !== "turn_finished") {}
            expect(await syncAgentContextThroughHost(host.server.socketPath, branch.id)).toEqual({ outcome: "synced", turns: 1 });
            const text = JSON.stringify((await SessionStore.open(branchPath)).messages());
            expect(text).toContain("Where is the crow's map?");
            expect(text).toContain("The map is aboard.");
            expect(await syncAgentContextThroughHost(host.server.socketPath, branch.id)).toEqual({ outcome: "unchanged", turns: 0 });
        } finally {
            sourceClient?.close();
            branchClient?.close();
            const annexPid = host.annexPid;
            try {
                await host.close();
                if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        }
    }, 20_000);
}

for (const parentOwner of ["host", "worker"] as const) {
    socketTest(`a ${parentOwner} parent can launch a subagent`, async () => {
        const home = await createTestHome();
        let adapterCount = 0;
        const host = await startResidentHost({
            home, config: { ...config, approval_mode: "auto", model_assignments: { subagents: { allow_self: true } } }, inProcessWorker: true,
            createAdapter: () => new FauxAdapter(adapterCount++ === 0
                ? [toolCall("launch", "async_subagent", { description: "Find the map." }), textResponse("Launched."), textResponse("Received.")]
                : [textResponse("Found the map.")]),
        });
        let client: AttachedAgentClient | undefined;
        try {
            const parent = parentOwner === "host"
                ? await host.registry.create({ workspace: home })
                : await createAgentThroughHost(host.server.socketPath, home);
            const path = (await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === parent.id)!.session_path;
            client = await attachAgent({ socketPath: host.server.socketPath, agentId: parent.id });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "Start the search." });
            while ((await client.receive(AbortSignal.timeout(5_000))).type !== "turn_finished") {}
            const results = (await SessionStore.open(path)).messages().filter((message) => message.role === "tool_result");
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({ isError: false });
            expect(JSON.stringify(results[0])).toContain("Async subagent");
        } finally {
            client?.close();
            const annexPid = host.annexPid;
            try {
                await host.close();
                if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        }
    }, 20_000);
}

for (const parentOwner of ["host", "worker"] as const) {
    socketTest(`idle parking considers a ${parentOwner} parent's whole tree`, async () => {
        const home = await createTestHome();
        const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]) });
        let client: AttachedAgentClient | undefined;
        try {
            const parent = parentOwner === "host"
                ? await host.registry.create({ workspace: home })
                : await createAgentThroughHost(host.server.socketPath, home);
            const childId = `park-child-${parentOwner}`;
            const childPath = join(defaultSessionDirectory(home), `${childId}.jsonl`);
            await SessionStore.create(childPath, { sessionId: childId, cwd: home, parentId: parent.id });
            if (parentOwner === "host") {
                const connection = await connectHost({ socketPath: host.server.socketPath });
                try {
                    await connection.send({ type: "locate_agent", agent_id: childId });
                    expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0" });
                } finally {
                    connection.close();
                }
            } else await host.registry.resume({ sessionPath: childPath });
            const router = host.registry.subagentSessions as HostRouter;
            for (const id of [parent.id, childId]) {
                client = await attachAgent({ socketPath: host.server.socketPath, agentId: id });
                expect((await client.receive()).type).toBe("history");
                await router.parkIdle(Date.now() + 11 * 60_000);
                const rows = await listAgentsThroughHost(host.server.socketPath);
                expect(rows.find((row) => row.id === parent.id)?.live).toBe(true);
                expect(rows.find((row) => row.id === childId)?.live).toBe(true);
                client.close();
                client = undefined;
                await Bun.sleep(20);
            }
            await router.parkIdle(Date.now() + 11 * 60_000);
            const parked = await listAgentsThroughHost(host.server.socketPath);
            expect(parked.find((row) => row.id === parent.id)?.live).toBe(false);
            expect(parked.find((row) => row.id === childId)?.live).toBe(false);
        } finally {
            client?.close();
            const annexPid = host.annexPid;
            try {
                await host.close();
                if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        }
    }, 20_000);
}

for (const parentOwner of ["host", "worker"] as const) {
    socketTest(`subagent limits count a child across from a ${parentOwner} parent`, async () => {
        const home = await createTestHome();
        const host = await startResidentHost({
            home, config, inProcessWorker: true,
            createAdapter: () => new FauxAdapter([textResponse("A long task.")], { delayMs: 2_000 }),
        });
        try {
            const parent = parentOwner === "host"
                ? await host.registry.create({ workspace: home })
                : await createAgentThroughHost(host.server.socketPath, home);
            const childId = `limit-child-${parentOwner}`;
            const childPath = join(defaultSessionDirectory(home), `${childId}.jsonl`);
            await SessionStore.create(childPath, { sessionId: childId, cwd: home, parentId: parent.id });
            if (parentOwner === "host") {
                const connection = await connectHost({ socketPath: host.server.socketPath });
                try {
                    await connection.send({ type: "locate_agent", agent_id: childId });
                    expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0" });
                } finally {
                    connection.close();
                }
            } else await host.registry.resume({ sessionPath: childPath });
            const admission = host.registry.subagentAdmission!;
            expect(await admission.reserveSubagentStart(parent.id, 1)).toBe(true);
            expect(await admission.reserveSubagentStart(parent.id, 1)).toBe(false);
            await admission.releaseSubagentStart(parent.id);
            expect((await host.registry.subagentSessions!.messageSubagent(parent.id, {
                type: "message_subagent", subagentId: childId, message: "Find the map.",
            })).isError).toBe(false);
            expect(await admission.reserveSubagentStart(parent.id, 1)).toBe(false);
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
}

for (const parentOwner of ["host", "worker"] as const) {
    socketTest(`trash reserves and restores a tree with a ${parentOwner} parent`, async () => {
        const home = await createTestHome();
        let failMove = true;
        let adapterCount = 0;
        const moving = Promise.withResolvers<void>();
        const releaseMove = Promise.withResolvers<void>();
        const host = await startResidentHost({
            home, config, inProcessWorker: true,
            createAdapter: () => new FauxAdapter(adapterCount++ === 0
                ? [textResponse("Found the map.")]
                : [textResponse("Received."), textResponse("Ready.")]),
            trashSessionArtifacts: async (artifacts) => {
                if (failMove) {
                    moving.resolve();
                    await releaseMove.promise;
                    throw new Error("trash unavailable");
                }
                await rm(artifacts.sessionPath);
            },
        });
        try {
            const parent = parentOwner === "host"
                ? await host.registry.create({ workspace: home })
                : await createAgentThroughHost(host.server.socketPath, home);
            const childId = `trash-child-${parentOwner}`;
            const childPath = join(defaultSessionDirectory(home), `${childId}.jsonl`);
            await SessionStore.create(childPath, { sessionId: childId, cwd: home, parentId: parent.id });
            if (parentOwner === "host") {
                const connection = await connectHost({ socketPath: host.server.socketPath });
                try {
                    await connection.send({ type: "locate_agent", agent_id: childId });
                    expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0" });
                } finally {
                    connection.close();
                }
            } else await host.registry.resume({ sessionPath: childPath });
            expect(await trashSessionThroughHost(host.server.socketPath, parent.id)).toEqual({ status: "rejected", reason: "busy" });
            const sent = await host.registry.subagentSessions!.messageSubagent(parent.id, {
                type: "message_subagent", subagentId: childId, message: "Find the map.",
            });
            expect(sent.isError).toBe(false);
            const deadline = Date.now() + 5_000;
            while (true) {
                const rows = await listAgentsThroughHost(host.server.socketPath);
                if (rows.find((row) => row.id === childId)?.status === "completed"
                    && rows.find((row) => row.id === parent.id)?.status === "idle") break;
                if (Date.now() >= deadline) throw new Error(`Sessions did not settle: ${JSON.stringify(rows)}`);
                await Bun.sleep(10);
            }
            const failing = (async () => {
                let result = await trashSessionThroughHost(host.server.socketPath, parent.id);
                while (result.status === "rejected" && result.reason === "busy") {
                    if (Date.now() >= deadline) throw new Error("Trash did not become idle");
                    await Bun.sleep(10);
                    result = await trashSessionThroughHost(host.server.socketPath, parent.id);
                }
                return result;
            })();
            await Promise.race([moving.promise, Bun.sleep(5_000).then(() => { throw new Error("Trash did not start moving"); })]);
            for (const id of [parent.id, childId]) {
                expect(await closeAgentThroughHost(host.server.socketPath, id)).toEqual({ status: "rejected", reason: "busy" });
            }
            releaseMove.resolve();
            expect(await failing).toEqual({ status: "rejected", reason: "failed" });
            const restored = await listAgentsThroughHost(host.server.socketPath);
            expect(restored.find((row) => row.id === parent.id)?.live).toBe(true);
            expect(restored.find((row) => row.id === childId)?.live).toBe(true);
            failMove = false;
            expect(await trashSessionThroughHost(host.server.socketPath, parent.id)).toEqual({ status: "trashed" });
            const remaining = await listAgentsThroughHost(host.server.socketPath);
            expect(remaining.some((row) => row.id === parent.id)).toBe(false);
            expect(remaining.find((row) => row.id === childId)?.live).toBe(false);
            expect(await readFile(childPath, "utf8")).toContain(childId);
        } finally {
            releaseMove.resolve();
            const annexPid = host.annexPid;
            try {
                await host.close();
                if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        }
    }, 20_000);
}

for (const parentOwner of ["host", "worker"] as const) {
    socketTest(`subagent messages and completion reach a ${parentOwner} parent`, async () => {
        const home = await createTestHome();
        let adapterCount = 0;
        const host = await startResidentHost({
            home, config, inProcessWorker: true,
            createAdapter: () => new FauxAdapter(adapterCount++ === 0
                ? [toolCall("notify", "notify_parent", { message: "The crow needs a bearing." }), textResponse("Found the map.")]
                : [textResponse("Understood."), textResponse("Received."), textResponse("Ready.")]),
        });
        try {
            const parent = parentOwner === "host"
                ? await host.registry.create({ workspace: home })
                : await createAgentThroughHost(host.server.socketPath, home);
            const childId = `child-${parentOwner}`;
            const childPath = join(defaultSessionDirectory(home), `${childId}.jsonl`);
            await SessionStore.create(childPath, { sessionId: childId, cwd: home, parentId: parent.id });
            if (parentOwner === "host") {
                const connection = await connectHost({ socketPath: host.server.socketPath });
                try {
                    await connection.send({ type: "locate_agent", agent_id: childId });
                    expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0" });
                } finally {
                    connection.close();
                }
            } else {
                await host.registry.resume({ sessionPath: childPath });
            }
            const result = parentOwner === "host"
                ? await host.registry.messageSubagent(host.registry.agents.get(parent.id)!.store, {
                    type: "message_subagent", subagentId: childId, message: "Find the map.",
                })
                : await host.registry.subagentSessions!.messageSubagent(parent.id, {
                    type: "message_subagent", subagentId: childId, message: "Find the map.",
                });
            expect(result.isError).toBe(false);
            const parentPath = (await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === parent.id)!.session_path;
            let contents = "";
            const deadline = Date.now() + 5_000;
            while (!contents.includes(`completion:${childId}`) || !contents.includes("The crow needs a bearing.")) {
                if (Date.now() >= deadline) throw new Error(`Timed out waiting for child delivery: ${contents}`);
                await Bun.sleep(10);
                contents = await readFile(parentPath, "utf8");
            }
            expect(contents).toContain("Found the map.");
            expect(await blockSessionThroughHost(host.server.socketPath, {
                targetAgentId: parent.id, sessionIds: [parent.id], reason: null,
            })).toEqual({ status: "blocked", sessionIds: [parent.id, childId] });
            expect(await unblockSessionThroughHost(host.server.socketPath, {
                targetAgentId: parent.id, sessionIds: [parent.id, childId],
            })).toEqual({ status: "unblocked", sessionIds: [parent.id, childId] });
            expect(await host.registry.subagentSessions!.closeSubagent("unrelated", childId)).toEqual({ status: "not_owned" });
            expect(await host.registry.subagentSessions!.closeSubagent(parent.id, childId)).toMatchObject({ status: "closed" });
            const closed = (await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === childId);
            expect(closed?.live).toBe(false);
            const nextChild = `${childId}-next`;
            const nextPath = join(defaultSessionDirectory(home), `${nextChild}.jsonl`);
            await SessionStore.create(nextPath, { sessionId: nextChild, cwd: home, parentId: parent.id });
            if (parentOwner === "host") {
                const connection = await connectHost({ socketPath: host.server.socketPath });
                try {
                    await connection.send({ type: "locate_agent", agent_id: nextChild });
                    expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0" });
                } finally {
                    connection.close();
                }
            } else {
                await host.registry.resume({ sessionPath: nextPath });
            }
            expect(await closeAgentThroughHost(host.server.socketPath, parent.id)).toMatchObject({ status: "closed" });
            const afterClose = await listAgentsThroughHost(host.server.socketPath);
            expect(afterClose.find((row) => row.id === parent.id)?.live).toBe(false);
            expect(afterClose.find((row) => row.id === nextChild)?.live).toBe(false);
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
}

for (const parentOwner of ["host", "worker"] as const) {
    socketTest(`a child approval reaches a ${parentOwner} parent across owners`, async () => {
        const home = await createTestHome();
        const outside = `${home}-outside`;
        let adapterCount = 0;
        const host = await startResidentHost({
            home, config, inProcessWorker: true,
            createAdapter: () => new FauxAdapter(adapterCount++ === 0
                ? [toolCall("write", "bash", { command: `printf crow > ${outside}` }), textResponse("Finished.")]
                : [textResponse("Received.")]),
        });
        let client: AttachedAgentClient | undefined;
        try {
            const parent = parentOwner === "host"
                ? await host.registry.create({ workspace: home })
                : await createAgentThroughHost(host.server.socketPath, home);
            const childId = `approval-${parentOwner}`;
            const childPath = join(defaultSessionDirectory(home), `${childId}.jsonl`);
            await SessionStore.create(childPath, { sessionId: childId, cwd: home, parentId: parent.id });
            if (parentOwner === "host") {
                const connection = await connectHost({ socketPath: host.server.socketPath });
                try {
                    await connection.send({ type: "locate_agent", agent_id: childId });
                    expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0" });
                } finally {
                    connection.close();
                }
            } else await host.registry.resume({ sessionPath: childPath });
            client = await attachAgent({ socketPath: host.server.socketPath, agentId: parent.id });
            expect((await client.receive()).type).toBe("history");
            const sent = await host.registry.subagentSessions!.messageSubagent(parent.id, {
                type: "message_subagent", subagentId: childId, message: "Find the map.",
            });
            expect(sent.isError).toBe(false);
            const seen: string[] = [];
            let update = await client.receive(AbortSignal.timeout(5_000));
            while (update.type !== "ui_request" || update.request.type !== "tool_approval") {
                seen.push(update.type);
                try { update = await client.receive(AbortSignal.timeout(5_000)); }
                catch { throw new Error(`Approval was not forwarded: ${seen.join(", ")}`); }
            }
            expect(update.request).toMatchObject({ sourceAgentId: childId, sourceTask: "Find the map." });
            await client.send({ type: "ui_response", requestId: update.requestId, response: { type: "tool_approval", decision: "deny" } });
            let notification = await client.receive(AbortSignal.timeout(5_000));
            while (notification.type !== "task_notification" || notification.sourceAgentId !== childId) {
                notification = await client.receive(AbortSignal.timeout(5_000));
            }
            expect(notification.content).toBe("Finished.");
        } finally {
            client?.close();
            const annexPid = host.annexPid;
            try {
                await host.close();
                if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
            } finally {
                await rm(home, { recursive: true, force: true });
                await rm(outside, { force: true });
            }
        }
    }, 20_000);
}

for (const parentOwner of ["host", "worker"] as const) {
    socketTest(`attachment release counts a child across owners with a ${parentOwner} parent`, async () => {
        const home = await createTestHome();
        const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]) });
        let parentClient: AttachedAgentClient | undefined;
        let childClient: AttachedAgentClient | undefined;
        try {
            const parent = parentOwner === "host"
                ? await host.registry.create({ workspace: home })
                : await createAgentThroughHost(host.server.socketPath, home);
            const childId = `attachment-${parentOwner}`;
            const childPath = join(defaultSessionDirectory(home), `${childId}.jsonl`);
            await SessionStore.create(childPath, { sessionId: childId, cwd: home, parentId: parent.id });
            if (parentOwner === "worker") await host.registry.resume({ sessionPath: childPath });
            const attach = (agentId: string, clientId: string) => attachAgent({
                socketPath: host.server.socketPath, agentId, clientId, interactive: true,
                requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            });
            parentClient = await attach(parent.id, "parent-viewer");
            childClient = await attach(childId, "child-viewer");
            expect((await parentClient.receive()).type).toBe("history");
            expect((await childClient.receive()).type).toBe("history");
            expect(await parentClient.release!("stop_if_last")).toEqual({ outcome: "detached", remainingInteractiveClients: 1 });
            expect(await childClient.release!("stop_if_last")).toEqual({ outcome: "stopped", remainingInteractiveClients: 0, sessionRetained: true });
            const rows = await listAgentsThroughHost(host.server.socketPath);
            expect(rows.find((row) => row.id === parent.id)?.live).toBe(false);
            expect(rows.find((row) => row.id === childId)?.live).toBe(false);
        } finally {
            parentClient?.close();
            childClient?.close();
            const annexPid = host.annexPid;
            try {
                await host.close();
                if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        }
    }, 20_000);
}

socketTest("locate and attach restore unowned sessions on the worker", async () => {
    const home = await createTestHome();
    const directory = defaultSessionDirectory(home);
    await mkdir(directory, { recursive: true });
    for (const id of ["locate", "attach"]) {
        await SessionStore.create(join(directory, `${id}.jsonl`), { sessionId: id, cwd: home });
    }
    const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]) });
    let client: AttachedAgentClient | undefined;
    try {
        const connection = await connectHost({ socketPath: host.server.socketPath });
        try {
            await connection.send({ type: "locate_agent", agent_id: "locate" });
            expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0", socket_path: inProcessWorkerSocket(home) });
        } finally {
            connection.close();
        }
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: "attach" });
        expect((await client.receive()).type).toBe("history");
        expect(host.registry.agents.has("locate")).toBe(false);
        expect(host.registry.agents.has("attach")).toBe(false);
    } finally {
        client?.close();
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("an embedded custom-path session restores on the worker after close", async () => {
    const home = await createTestHome();
    const path = join(home, "other-sessions", "embedded.jsonl");
    const host = await startResidentHost({
        home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]),
        trashSessionArtifacts: async (artifacts) => { await rm(artifacts.sessionPath); },
    });
    let client: AttachedAgentClient | undefined;
    try {
        const session = await host.registry.create({ id: "embedded", workspace: home, sessionPath: path });
        expect(await closeAgentThroughHost(host.server.socketPath, session.id)).toEqual({ status: "closed", sessionRetained: true });
        expect(await renameSessionThroughHost(host.server.socketPath, session.id, "Crow's map"))
            .toEqual({ status: "renamed", name: "Crow's map" });
        const listed = (await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === session.id);
        expect(listed).toMatchObject({ session_path: path, title: "Crow's map", live: false });
        const connection = await connectHost({ socketPath: host.server.socketPath });
        try {
            await connection.send({ type: "locate_agent", agent_id: session.id });
            expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0" });
        } finally {
            connection.close();
        }
        expect(host.registry.agents.has(session.id)).toBe(false);
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        client.close();
        client = undefined;
        expect(await closeAgentThroughHost(host.server.socketPath, session.id)).toEqual({ status: "closed", sessionRetained: true });
        expect(await trashSessionThroughHost(host.server.socketPath, session.id)).toEqual({ status: "trashed" });
        expect((await listAgentsThroughHost(host.server.socketPath)).some((row) => row.id === session.id)).toBe(false);
    } finally {
        client?.close();
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("embedded opens cannot overlap a worker's session", async () => {
    const home = await createTestHome();
    const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]) });
    const original = SessionStore.open;
    const opened = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pending: Promise<unknown> | undefined;
    let unrelated: Promise<unknown> | undefined;
    let pendingLocation: Promise<unknown> | undefined;
    let locateConnection: Awaited<ReturnType<typeof connectHost>> | undefined;
    try {
        const worker = await createAgentThroughHost(host.server.socketPath, home);
        const workerPath = (await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === worker.id)!.session_path;
        let rejection: string | undefined;
        try { await host.registry.resume({ sessionPath: workerPath }); }
        catch (error) { rejection = error instanceof Error ? error.message : String(error); }
        expect(rejection).toBe(`Resident agent ${worker.id} already exists`);
        rejection = undefined;
        try { await host.registry.create({ id: worker.id, workspace: home }); }
        catch (error) { rejection = error instanceof Error ? error.message : String(error); }
        expect(rejection).toBe(`Resident agent ${worker.id} already exists`);

        const path = join(defaultSessionDirectory(home), "opening.jsonl");
        await SessionStore.create(path, { sessionId: "opening", cwd: home });
        const otherPath = join(defaultSessionDirectory(home), "unrelated.jsonl");
        await SessionStore.create(otherPath, { sessionId: "unrelated", cwd: home });
        let first = true;
        SessionStore.open = async (sessionPath, options) => {
            if (sessionPath === path && first) {
                first = false;
                opened.resolve();
                await release.promise;
            }
            return original(sessionPath, options);
        };
        const embedded = host.registry.resume({ sessionPath: path });
        await opened.promise;
        locateConnection = await connectHost({ socketPath: host.server.socketPath });
        await locateConnection.send({ type: "locate_agent", agent_id: "opening" });
        pendingLocation = locateConnection.receive();
        await Bun.sleep(20);
        unrelated = resumeAgentThroughHost(host.server.socketPath, otherPath);
        expect(await Promise.race([unrelated, Bun.sleep(1_000).then(() => undefined)])).toMatchObject({ id: "unrelated" });
        pending = resumeAgentThroughHost(host.server.socketPath, path);
        expect(await Promise.race([pending.then(() => "finished"), Bun.sleep(30).then(() => "waiting")])).toBe("waiting");
        release.resolve();
        expect((await embedded).id).toBe("opening");
        expect(await pendingLocation).toMatchObject({ type: "agent_location" });
        expect(await pending).toMatchObject({ id: "opening" });
        expect(host.registry.agents.has("opening")).toBe(false);
    } finally {
        release.resolve();
        await pending?.catch(() => undefined);
        await unrelated?.catch(() => undefined);
        await pendingLocation?.catch(() => undefined);
        locateConnection?.close();
        SessionStore.open = original;
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("import deduplication follows the resident session owner", async () => {
    const home = await createTestHome();
    const source = join(home, "external.jsonl");
    await writeFile(source, [
        { sessionId: "source", cwd: home, isSidechain: false, type: "user", uuid: "u1", parentUuid: null,
            timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "Find the map." } },
        { sessionId: "source", cwd: home, isSidechain: false, type: "assistant", uuid: "a1", parentUuid: "u1",
            timestamp: "2026-11-01T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Found it." }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]) });
    try {
        const first = await importSessionThroughHost(host.server.socketPath, source);
        if (first.status !== "imported") throw new Error(first.reason);
        expect(first.existing).toBe(false);
        await host.registry.resume({ sessionPath: first.sessionPath });
        expect(await importSessionThroughHost(host.server.socketPath, source)).toEqual({ ...first, existing: true });
        await resumeAgentThroughHost(host.server.socketPath, first.sessionPath);
        expect(await importSessionThroughHost(host.server.socketPath, source)).toEqual({ ...first, existing: true });
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

socketTest("search preserves single-host order and truncation across owners", async () => {
    const home = await createTestHome();
    const directory = defaultSessionDirectory(home);
    const paths: string[] = [];
    for (let index = 0; index < 21; index += 1) {
        const id = `search-${String(index).padStart(2, "0")}`;
        const path = join(directory, `${id}.jsonl`);
        const store = await SessionStore.create(path, { sessionId: id, cwd: home });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: index === 20 ? "No match." : "Find the crow." }] });
        const time = new Date(Date.now() - (index + 1) * 10_000);
        await utimes(path, time, time);
        paths.push(path);
    }
    const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]) });
    try {
        for (const path of paths.slice(0, 10)) await host.registry.resume({ sessionPath: path });
        const expected = await searchSessions(directory, { query: "crow" });
        expect(expected.results).toHaveLength(20);
        expect(expected.truncated).toBe(true);
        expect(await searchSessionsThroughHost(host.server.socketPath, { query: "crow" })).toEqual(expected);
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

socketTest("schedule and inbox wakes reach both owners", async () => {
    const home = await createTestHome();
    const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]) });
    const clients: AttachedAgentClient[] = [];
    try {
        const hostSession = await host.registry.create({ workspace: home });
        const worker = await createAgentThroughHost(host.server.socketPath, home);
        for (const [index, id] of [hostSession.id, worker.id].entries()) {
            const client = await attachAgent({ socketPath: host.server.socketPath, agentId: id });
            clients.push(client);
            expect((await client.receive()).type).toBe("history");
            const schedule = `crow-${index}`;
            await runScheduleOperationThroughHost(host.server.socketPath, {
                action: "add", id: schedule, cron: "0 9 * * *", timezone: "UTC", address: id,
                payload: { text: "Check the map." },
            });
            await runScheduleOperationThroughHost(host.server.socketPath, { action: "run", id: schedule });
            let update = await client.receive(AbortSignal.timeout(5_000));
            while (update.type !== "notice" || update.key !== "inbox") update = await client.receive(AbortSignal.timeout(5_000));
            expect(update.count).toBe(1);
        }
    } finally {
        for (const client of clients) client.close();
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("stop waiting and cut reach active sessions on both owners", async () => {
    const home = await createTestHome();
    const host = await startResidentHost({
        home, config, inProcessWorker: true,
        createAdapter: () => new FauxAdapter([textResponse("A crow studies the chart while the ship sails toward the island.")], { chunkSize: 1, delayMs: 40 }),
    });
    const clients: AttachedAgentClient[] = [];
    try {
        const hostSession = await host.registry.create({ workspace: home });
        const worker = await createAgentThroughHost(host.server.socketPath, home);
        for (const id of [hostSession.id, worker.id]) {
            const client = await attachAgent({ socketPath: host.server.socketPath, agentId: id, requestedCapabilities: [HOST_CAPABILITY_WORK_INDEX] });
            clients.push(client);
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "Study the chart." });
        }
        const router = host.registry.subagentSessions as HostRouter;
        const deadline = Date.now() + 5_000;
        while (true) {
            const waiting = await router.stopWaitTargets();
            if (waiting.some((entry) => entry.session_id === hostSession.id)
                && waiting.some((entry) => entry.session_id === worker.id)
                && clients.every((client) => client.workIndex?.rows.some((row) => row.session_id === hostSession.id)
                    && client.workIndex.rows.some((row) => row.session_id === worker.id))) break;
            if (Date.now() >= deadline) throw new Error("Both sessions did not enter the stop wait");
            await Bun.sleep(10);
        }
        expect(await Promise.all([router.cut(hostSession.id, "Vera is stopping"), router.cut(worker.id, "Vera is stopping")]))
            .toEqual([true, true]);
        for (const client of clients) {
            let update = await client.receive(AbortSignal.timeout(5_000));
            while (update.type !== "turn_finished") update = await client.receive(AbortSignal.timeout(5_000));
        }
    } finally {
        for (const client of clients) client.close();
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("checkpoint waits for both owners' session writes", async () => {
    const home = await createTestHome();
    const host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]) });
    const original = SessionStore.prototype.exclusively;
    const seen = new Set<string>();
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
        const hostSession = await host.registry.create({ workspace: home });
        const worker = await createAgentThroughHost(host.server.socketPath, home);
        const rows = await listAgentsThroughHost(host.server.socketPath);
        const paths = new Set(rows.filter((row) => row.id === hostSession.id || row.id === worker.id).map((row) => row.session_path));
        SessionStore.prototype.exclusively = function <T>(this: SessionStore, run: () => Promise<T>): Promise<T> {
            if (!paths.has(this.path)) return original.call(this, run) as Promise<T>;
            seen.add(this.path);
            if (seen.size === paths.size) reached.resolve();
            return release.promise.then(() => original.call(this, run)) as Promise<T>;
        };
        const checkpoint = checkpointStoresThroughHost(host.server.socketPath, join(home, "checkpoint"));
        await Promise.race([reached.promise, Bun.sleep(5_000).then(() => { throw new Error("Checkpoint did not reach both stores"); })]);
        expect(await Promise.race([checkpoint.then(() => "finished"), Bun.sleep(30).then(() => "waiting")])).toBe("waiting");
        release.resolve();
        const result = await checkpoint;
        expect([...result.databases].sort()).toEqual(["inbox.db", "schedules.db"]);
        expect(seen).toEqual(paths);
    } finally {
        release.resolve();
        SessionStore.prototype.exclusively = original;
        const annexPid = host.annexPid;
        try {
            await host.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

function toolCall(id: string, name: string, input: Readonly<Record<string, unknown>>): AssistantMessage {
    return { role: "assistant", content: [{ type: "tool_call", id, name, input }], source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use" };
}

function textResponse(text: string): AssistantMessage {
    return { role: "assistant", content: [{ type: "text", text }], source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop" };
}

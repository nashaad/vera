import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    AgentRegistry,
    defaultConcurrentWorkerCap,
} from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url),
);

function toolCall(id: string, command: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "bash", input: { command } }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function text(body: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: body }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function receiveUntil(
    attachment: AgentAttachment,
    predicate: (update: AgentUpdate) => boolean,
): Promise<AgentUpdate> {
    const deadline = Date.now() + 20_000;
    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for agent update");
        const update = await Promise.race([
            attachment.receive(),
            Bun.sleep(remaining).then(() => {
                throw new Error("Timed out waiting for agent update");
            }),
        ]);
        if (predicate(update)) return update;
    }
}

async function waitForFile(path: string): Promise<number> {
    const deadline = Date.now() + 20_000;
    while (Date.now() <= deadline) {
        try {
            return Number((await readFile(path, "utf8")).trim());
        } catch {
            await Bun.sleep(20);
        }
    }
    throw new Error(`Timed out waiting for ${path}`);
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (processIsAlive(pid)) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for process ${pid} to exit`);
        }
        await Bun.sleep(20);
    }
}

test("the registry contains a killed worker and keeps its sibling usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-registry-"));
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const scripts = new Map<string, readonly AssistantMessage[]>([
        ["victim", [
            toolCall("hold", "sleep 60"),
            text("never reached"),
        ]],
        ["sibling", [text("sibling finished")]],
    ]);
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: ({ sessionId }) => ({
            module: ADAPTER,
            options: {
                script: scripts.get(sessionId) ?? [],
                pidPath: join(root, `${sessionId}.pid`),
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });

    try {
        const victimPath = join(root, "victim.jsonl");
        const victim = await registry.create({
            id: "victim",
            workspace: root,
            sessionPath: victimPath,
        });
        const sibling = await registry.create({
            id: "sibling",
            workspace: root,
            sessionPath: join(root, "sibling.jsonl"),
        });
        const victimClient = victim.attach();
        expect((await victimClient.receive()).type).toBe("history");
        victimClient.send({ type: "prompt", content: "hold the tool open" });
        await receiveUntil(
            victimClient,
            (update) => update.type === "tool_started",
        );

        const workerPid = await waitForFile(join(root, "victim.pid"));
        expect(registry.list().find((entry) => entry.id === "victim"))
            .toMatchObject({
                worker_pid: workerPid,
                supervisor_pid: expect.any(Number),
            });
        process.kill(workerPid, "SIGKILL");
        const failure = await receiveUntil(
            victimClient,
            (update) => update.type === "agent_failed",
        );
        expect(failure).toMatchObject({
            type: "agent_failed",
            detail: expect.any(String),
        });
        if (failure.type === "agent_failed") {
            expect(failure.detail).not.toBe("");
        }
        expect(registry.list().find((entry) => entry.id === "victim")?.worker_pid)
            .toBeUndefined();

        const siblingClient = sibling.attach();
        expect((await siblingClient.receive()).type).toBe("history");
        siblingClient.send({ type: "prompt", content: "finish normally" });
        await receiveUntil(
            siblingClient,
            (update) => update.type === "turn_finished",
        );

        const stored = await SessionStore.open(victimPath);
        expect(stored.messages().map((message) => message.role))
            .toContain("user");
        const storedFailure = stored.agentFailure();
        expect(storedFailure).toBeDefined();
        expect(storedFailure?.detail).not.toBe("");

        const reopened = victim.attach();
        expect((await reopened.receive()).type).toBe("history");
        const replayedFailure = await receiveUntil(
            reopened,
            (update) => update.type === "agent_failed",
        );
        expect(replayedFailure).toMatchObject({
            type: "agent_failed",
            detail: storedFailure?.detail,
        });
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("a parent close effect kills a child worker process tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-parent-close-"));
    const childPath = join(root, "child.jsonl");
    const toolPidPath = join(root, "child-tool.pid");
    await SessionStore.create(childPath, {
        sessionId: "child",
        cwd: root,
        parentId: "parent",
    });
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const scripts = new Map<string, readonly AssistantMessage[]>([
        ["parent", [
            {
                role: "assistant",
                content: [{
                    type: "tool_call",
                    id: "close-child",
                    name: "close_subagent",
                    input: { subagent_id: "child" },
                }],
                source: {
                    provider: "faux",
                    api: "scripted",
                    model: "test",
                },
                usage: emptyUsage(),
                stopReason: "tool_use",
            },
            text("Child closed."),
        ]],
        ["child", [
            toolCall(
                "hold",
                `echo $$ > '${toolPidPath}'; exec sleep 60`,
            ),
            text("never reached"),
        ]],
        ["peer", [text("peer finished")]],
    ]);
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: ({ sessionId }) => ({
            module: ADAPTER,
            options: {
                script: scripts.get(sessionId) ?? [],
                pidPath: join(root, `${sessionId}.pid`),
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });

    try {
        const parent = await registry.create({
            id: "parent",
            workspace: root,
            sessionPath: join(root, "parent.jsonl"),
        });
        const child = await registry.resume({ sessionPath: childPath });
        await registry.create({
            id: "peer",
            workspace: root,
            sessionPath: join(root, "peer.jsonl"),
        });
        const childClient = child.attach();
        expect((await childClient.receive()).type).toBe("history");
        childClient.send({ type: "prompt", content: "hold the tool open" });
        await receiveUntil(
            childClient,
            (update) => update.type === "tool_started",
        );
        const childWorkerPid = await waitForFile(join(root, "child.pid"));
        const toolPid = await waitForFile(toolPidPath);

        const parentClient = parent.attach();
        expect((await parentClient.receive()).type).toBe("history");
        parentClient.send({ type: "prompt", content: "close the child" });
        const closed = await receiveUntil(
            parentClient,
            (update) => update.type === "tool_finished",
        );
        expect(closed).toMatchObject({
            type: "tool_finished",
            tool: "close_subagent",
        });
        if (closed.type !== "tool_finished" || closed.output === undefined) {
            throw new Error("Expected close_subagent to finish");
        }
        expect(JSON.parse(closed.output)).toEqual({
            requested_subagent_id: "child",
            closed: true,
            reason: "closed",
            session_retained: true,
        });
        await waitForProcessExit(childWorkerPid);
        await waitForProcessExit(toolPid);

        expect(registry.find("child")).toBeUndefined();
        const parentEntry = registry.list().find((entry) =>
            entry.id === "parent"
        );
        const peerEntry = registry.list().find((entry) => entry.id === "peer");
        expect(parentEntry?.worker_pid).toEqual(expect.any(Number));
        expect(peerEntry?.worker_pid).toEqual(expect.any(Number));
        expect(processIsAlive(parentEntry!.worker_pid!)).toBe(true);
        expect(processIsAlive(peerEntry!.worker_pid!)).toBe(true);
        expect(await Bun.file(childPath).exists()).toBe(true);
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("a worker returns timeline replies only to their attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-timeline-"));
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: () => ({
            module: ADAPTER,
            options: { script: [], pidPath: join(root, "worker.pid") },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });

    try {
        const agent = await registry.create({
            id: "timeline",
            workspace: root,
            sessionPath: join(root, "timeline.jsonl"),
        });
        const owner = agent.attach();
        const peer = agent.attach();
        expect((await owner.receive()).type).toBe("history");
        expect((await peer.receive()).type).toBe("history");

        owner.send({ type: "list_timeline", requestId: "timeline-1" });
        const reply = await receiveUntil(
            owner,
            (update) => update.type === "timeline",
        );
        expect(reply).toMatchObject({
            type: "timeline",
            requestId: "timeline-1",
        });
        const peerDeadline = Date.now() + 200;
        let peerSawReply = false;
        while (Date.now() < peerDeadline) {
            const update = await Promise.race([
                peer.receive(),
                Bun.sleep(peerDeadline - Date.now()).then(() => undefined),
            ]);
            if (update === undefined) break;
            if (
                update.type === "timeline"
                && update.requestId === "timeline-1"
            ) {
                peerSawReply = true;
                break;
            }
        }
        expect(peerSawReply).toBe(false);
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("the default worker cap scales with memory and stays inside its bounds", () => {
    const gb = 1024 * 1024 * 1024;
    expect(defaultConcurrentWorkerCap(1 * gb)).toBe(2);
    expect(defaultConcurrentWorkerCap(16 * gb)).toBe(12);
    expect(defaultConcurrentWorkerCap(1024 * gb)).toBe(16);
});

test("a session past the worker cap fails with the way to free a slot", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-cap-"));
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: ({ sessionId }) => ({
            module: ADAPTER,
            options: {
                script: [toolCall("hold", "sleep 60"), text("never reached")],
                pidPath: join(root, `${sessionId}.pid`),
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
        maxConcurrentWorkers: 1,
    });

    try {
        const first = await registry.create({
            id: "first",
            workspace: root,
            sessionPath: join(root, "first.jsonl"),
        });
        const firstClient = first.attach();
        expect((await firstClient.receive()).type).toBe("history");
        firstClient.send({ type: "prompt", content: "hold the slot" });
        await receiveUntil(
            firstClient,
            (update) => update.type === "tool_started",
        );
        await waitForFile(join(root, "first.pid"));

        const second = await registry.create({
            id: "second",
            workspace: root,
            sessionPath: join(root, "second.jsonl"),
        });
        const secondClient = second.attach();
        expect((await secondClient.receive()).type).toBe("history");
        secondClient.send({ type: "prompt", content: "should not start" });
        const failure = await receiveUntil(
            secondClient,
            (update) => update.type === "agent_failed",
        );

        expect(failure).toMatchObject({ type: "agent_failed" });
        if (failure.type === "agent_failed") {
            expect(failure.detail).toContain("1 session is already taking");
            expect(failure.detail).toContain("vera abort");
        }
        expect(
            registry.list().find((entry) => entry.id === "second")?.worker_pid,
        ).toBeUndefined();
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("owner commands still answer while the loop runs in a worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-owner-"));
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: ({ sessionId }) => ({
            module: ADAPTER,
            options: {
                script: [toolCall("hold", "sleep 60"), text("never reached")],
                pidPath: join(root, `${sessionId}.pid`),
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });

    try {
        const agent = await registry.create({
            id: "owner",
            workspace: root,
            sessionPath: join(root, "owner.jsonl"),
        });
        const client = agent.attach();
        expect((await client.receive()).type).toBe("history");
        client.send({ type: "prompt", content: "hold the tool open" });
        await receiveUntil(client, (update) => update.type === "tool_started");

        client.send({
            type: "update_session_name",
            requestId: "rename-1",
            name: "renamed in a worker",
        });
        const reply = await receiveUntil(
            client,
            (update) =>
                update.type === "session_name"
                || update.type === "session_name_rejected",
        );
        expect(reply).toMatchObject({
            type: "session_name",
            requestId: "rename-1",
            name: "renamed in a worker",
        });
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("dialling a session reaches the loop already running in a worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-dial-"));
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: ({ sessionId }) => ({
            module: ADAPTER,
            options: {
                script: [toolCall("hold", "sleep 60"), text("never reached")],
                pidPath: join(root, `${sessionId}.pid`),
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });

    try {
        const agent = await registry.create({
            id: "dial",
            workspace: root,
            sessionPath: join(root, "dial.jsonl"),
        });
        const client = agent.attach();
        expect((await client.receive()).type).toBe("history");
        client.send({ type: "prompt", content: "hold the tool open" });
        await receiveUntil(client, (update) => update.type === "tool_started");

        client.send({
            type: "update_session_permission_mode",
            requestId: "mode-1",
            mode: "ask",
        });
        await receiveUntil(
            client,
            (update) =>
                update.type === "permissions"
                || update.type === "permissions_rejected",
        );

        // The worker answers permission reads from its pushed copy, so the
        // dial only counts as arrived once that copy carries it.
        const state = registry.list().find((entry) => entry.id === "dial");
        expect(state).toMatchObject({ worker_pid: expect.any(Number) });
        client.send({ type: "get_permissions", requestId: "perm-1" });
        const permissions = await receiveUntil(
            client,
            (update) =>
                update.type === "permissions" && update.requestId === "perm-1",
        );
        expect(permissions).toMatchObject({ mode: "ask" });
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("an extension tool runs inside the worker when the host hands it over", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-extension-"));
    const extension = join(root, "extension");
    await mkdir(extension, { recursive: true });
    await writeFile(
        join(extension, "vera.extension.json"),
        JSON.stringify({
            id: "pid.extension",
            version: "1.0.0",
            sdk: "1",
            entrypoint: "./extension.ts",
            capabilities: ["tools.register"],
        }),
    );
    await writeFile(
        join(extension, "extension.ts"),
        `export function activate(vera) {
            vera.tools.register({
                name: "report_pid",
                description: "Reports the pid of the process it ran in",
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                run() {
                    return { output: String(process.pid) };
                },
            });
        }`,
    );

    const previousWorkerMode = process.env.VERA_WORKER;
    const previousWorkerExtensions = process.env.VERA_WORKER_EXTENSIONS;
    process.env.VERA_WORKER = "1";
    process.env.VERA_WORKER_EXTENSIONS = "1";
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerExtensions: () => [{ path: extension, enabled: true, config: null }],
        workerAdapterSpec: ({ sessionId }) => ({
            module: ADAPTER,
            options: {
                script: [
                    {
                        role: "assistant",
                        content: [{
                            type: "tool_call",
                            id: "pid-1",
                            name: "report_pid",
                            input: {},
                        }],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "tool_use",
                    },
                    text("done"),
                ],
                pidPath: join(root, `${sessionId}.pid`),
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });

    try {
        const agent = await registry.create({
            id: "ext",
            workspace: root,
            sessionPath: join(root, "ext.jsonl"),
        });
        const client = agent.attach();
        expect((await client.receive()).type).toBe("history");
        client.send({ type: "prompt", content: "report your pid" });
        const finished = await receiveUntil(
            client,
            (update) => update.type === "tool_finished",
        );
        const workerPid = await waitForFile(join(root, "ext.pid"));
        expect(finished).toMatchObject({
            type: "tool_finished",
            output: String(workerPid),
        });
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        if (previousWorkerExtensions === undefined) {
            delete process.env.VERA_WORKER_EXTENSIONS;
        } else {
            process.env.VERA_WORKER_EXTENSIONS = previousWorkerExtensions;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("wear queued in a worker is answered by the host over the boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-wear-"));
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: ({ sessionId }) => ({
            module: ADAPTER,
            options: {
                script: [text("done")],
                pidPath: join(root, `${sessionId}.pid`),
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });

    try {
        const agent = await registry.create({
            id: "wear",
            workspace: root,
            sessionPath: join(root, "wear.jsonl"),
        });
        const client = agent.attach();
        expect((await client.receive()).type).toBe("history");
        client.send({
            type: "wear_agent",
            requestId: "wear-1",
            name: "no-such-agent",
        });
        const answer = await receiveUntil(
            client,
            (update) =>
                update.type === "agent_worn" || update.type === "agent_rejected",
        );
        // The host is the one that knows the catalog, so a refusal naming the
        // agent proves the question crossed and came back.
        expect(answer).toMatchObject({
            type: "agent_rejected",
            requestId: "wear-1",
            reason: "No agent named no-such-agent",
        });
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("skill commands list and run through a worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-skills-"));
    const skillDirectory = join(root, ".vera", "skills", "deploy");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), [
        "---",
        "name: deploy",
        "description: Deploy the current service.",
        "disable-model-invocation: true",
        "---",
        "Deploy it.",
        "",
    ].join("\n"));
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: ({ sessionId }) => ({
            module: ADAPTER,
            options: {
                script: [text("deployed"), text("still ready")],
                pidPath: join(root, `${sessionId}.pid`),
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });

    try {
        const agent = await registry.create({
            id: "skills",
            workspace: root,
            sessionPath: join(root, "skills.jsonl"),
        });
        const client = agent.attach();
        expect((await client.receive()).type).toBe("history");

        client.send({ type: "list_skills", requestId: "skills-1" });
        expect(await receiveUntil(
            client,
            (update) => update.type === "skill_catalog",
        )).toMatchObject({
            type: "skill_catalog",
            requestId: "skills-1",
            skills: [{ name: "deploy" }],
            warnings: [],
        });

        client.send({
            type: "invoke_skill",
            requestId: "invoke-1",
            name: "deploy",
            argumentsText: "staging",
        });
        expect(await receiveUntil(
            client,
            (update) => update.type === "skill_invocation_accepted",
        )).toMatchObject({
            type: "skill_invocation_accepted",
            requestId: "invoke-1",
            prompt: "/deploy staging",
        });
        await receiveUntil(
            client,
            (update) => update.type === "turn_finished",
        );

        client.send({ type: "prompt", content: "next prompt" });
        await receiveUntil(
            client,
            (update) => update.type === "turn_finished",
        );
        const stored = await SessionStore.open(join(root, "skills.jsonl"));
        expect(stored.messages().filter((message) => message.role === "user")
            .map((message) => message.content)).toEqual([
                [{ type: "text", text: "/deploy staging" }],
                [{ type: "text", text: "next prompt" }],
            ]);
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("a session runs in a worker with nothing set, and in the host at 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-default-"));
    const previousWorkerMode = process.env.VERA_WORKER;

    async function workerPidFor(id: string): Promise<number | null> {
        const registry = new AgentRegistry({
            createAdapter: () => new FauxAdapter([toolCall("hold", "sleep 60")]),
            workerAdapterSpec: () => ({
                module: ADAPTER,
                options: {
                    script: [toolCall("hold", "sleep 60")],
                    pidPath: join(root, `${id}.pid`),
                },
            }),
            model: "faux/test",
            approvalMode: "full_access",
        });
        try {
            const agent = await registry.create({
                id,
                workspace: root,
                sessionPath: join(root, `${id}.jsonl`),
            });
            const client = agent.attach();
            expect((await client.receive()).type).toBe("history");
            client.send({ type: "prompt", content: "hold the tool open" });
            await receiveUntil(
                client,
                (update) => update.type === "tool_started",
            );
            const entry = registry.list().find((row) => row.id === id);
            return entry?.worker_pid ?? null;
        } finally {
            await registry.close();
        }
    }

    try {
        delete process.env.VERA_WORKER;
        expect(await workerPidFor("unset")).toEqual(expect.any(Number));

        process.env.VERA_WORKER = "0";
        expect(await workerPidFor("optout")).toBeNull();
    } finally {
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

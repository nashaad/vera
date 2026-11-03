import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import { trashSessionThroughHost } from "../../src/host/session-trash-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { AgentAttachError, attachAgent } from "../../src/host/attached-client.ts";
import {
    startResidentHost,
    type ResidentHost,
    type StartResidentHostOptions,
} from "../../src/host/runtime.ts";
import { trashSessionArtifacts } from "../../src/host/session-trash.ts";
import { startHostServer } from "../../src/host/server.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "session trash client preserves typed host outcomes",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-session-trash-client-"));
        const socketPath = join(root, "host.sock");
        const calls: string[] = [];
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            trashSession: async (targetId) => {
                calls.push(targetId);
                return targetId === "saved" ? "trashed" : "busy";
            },
        });

        try {
            expect(await trashSessionThroughHost(
                socketPath,
                "saved",
            )).toEqual({ status: "trashed" });
            expect(await trashSessionThroughHost(
                socketPath,
                "working",
            )).toEqual({ status: "rejected", reason: "busy" });
            expect(calls).toEqual([
                "saved",
                "working",
            ]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host trashes a closed session out of the durable store",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-stored-trash-"));
        const socketPath = join(root, "host.sock");
        const sessionDirectory = join(root, "sessions");
        const trashed: string[] = [];
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
            eventLogDirectory: join(root, "logs"),
            trashSessionArtifacts: (artifacts) =>
                trashSessionArtifacts(artifacts, {
                    moveToTrash: async (paths) => {
                        const [bundle] = paths;
                        if (bundle === undefined) {
                            throw new Error("expected a trash bundle path");
                        }
                        trashed.push(bundle);
                    },
                }),
        });
        const sessionPath = join(sessionDirectory, "saved.jsonl");
        try {
            await host.registry.create({ id: "saved", workspace: root });
            expect(await host.registry.closeAgent("saved")).toBe("closed");
            expect((await stat(sessionPath)).isFile()).toBe(true);

            expect(await trashSessionThroughHost(socketPath, "saved"))
                .toEqual({ status: "trashed" });

            expect(trashed).toHaveLength(1);
            expect(await stat(sessionPath).then(() => true, () => false))
                .toBe(false);
            expect((await listAgentsThroughHost(socketPath)).map((agent) =>
                agent.id
            )).not.toContain("saved");
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a resume while a closed session moves to the trash is refused",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-stored-trash-resume-"));
        const socketPath = join(root, "host.sock");
        const sessionDirectory = join(root, "sessions");
        let moveStarted: () => void = () => {};
        const moving = new Promise<void>((resolve) => {
            moveStarted = resolve;
        });
        let releaseMove: () => void = () => {};
        const released = new Promise<void>((resolve) => {
            releaseMove = resolve;
        });
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
            eventLogDirectory: join(root, "logs"),
            trashSessionArtifacts: (artifacts) =>
                trashSessionArtifacts(artifacts, {
                    moveToTrash: async () => {
                        moveStarted();
                        await released;
                    },
                }),
        });
        const sessionPath = join(sessionDirectory, "saved.jsonl");
        try {
            await host.registry.create({ id: "saved", workspace: root });
            expect(await host.registry.closeAgent("saved")).toBe("closed");

            const trashing = trashSessionThroughHost(socketPath, "saved");
            await moving;
            await expect(host.registry.resume({ sessionPath }))
                .rejects.toThrow("This conversation is being moved to the trash.");
            expect(await host.registry.trashSession("saved")).toBe("busy");
            expect(host.registry.idleForShutdown()).toBe(false);
            releaseMove();

            expect(await trashing).toEqual({ status: "trashed" });
            expect(host.registry.agents.has("saved")).toBe(false);
            expect(await stat(sessionPath).then(() => true, () => false))
                .toBe(false);
        } finally {
            releaseMove();
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

async function trashParentOfFinishedChild(
    root: string,
    childSessionPath: string | undefined,
): Promise<void> {
    const socketPath = join(root, "host.sock");
    const sessionDirectory = join(root, "sessions");
    const host = await startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        },
        createAdapter: () => new FauxAdapter(
            Array.from({ length: 4 }, () => ({
                role: "assistant" as const,
                content: [{
                    type: "text" as const,
                    text: "The crow is done.",
                }],
                source: {
                    provider: "faux",
                    api: "scripted",
                    model: "test",
                },
                usage: emptyUsage(),
                stopReason: "stop" as const,
            })),
        ),
        socketPath,
        lockPath: join(root, "host.json"),
        sessionDirectory,
        eventLogDirectory: join(root, "logs"),
        trashSessionArtifacts: (artifacts) =>
            trashSessionArtifacts(artifacts, { moveToTrash: async () => {} }),
    });
    try {
        await host.registry.create({ id: "parent", workspace: root });
        await host.registry.createWithKind(
            {
                id: "child",
                workspace: root,
                ...(childSessionPath === undefined
                    ? {}
                    : { sessionPath: childSessionPath }),
            },
            "background",
            { approvalMode: "auto", parentId: "parent" },
        );
        host.registry.find("child")!.sendPrompt("bury the treasure");
        host.registry.trackAsyncSubagentTurn("child");
        const deadline = Date.now() + 3_000;
        while (
            !host.registry.list().every((agent) =>
                host.registry.find(agent.id)?.idleForShutdown() === true
            )
            || host.registry.list().find((agent) => agent.id === "child")
                ?.status !== "completed"
        ) {
            if (Date.now() > deadline) {
                throw new Error("the child did not finish");
            }
            await Bun.sleep(10);
        }

        expect(await trashSessionThroughHost(socketPath, "parent"))
            .toEqual({ status: "trashed" });

        expect(host.registry.list()).toEqual([]);
        expect(await stat(join(sessionDirectory, "parent.jsonl"))
            .then(() => true, () => false)).toBe(false);
        await expect(attachAgent({ socketPath, agentId: "parent" }))
            .rejects.toBeInstanceOf(AgentAttachError);
        const listed = await listAgentsThroughHost(socketPath);
        expect(listed.map((agent) => agent.id)).toEqual(["child"]);
        expect(listed[0]).toMatchObject({
            live: false,
            session_path: childSessionPath
                ?? join(sessionDirectory, "child.jsonl"),
        });
        const client = await attachAgent({ socketPath, agentId: "child" });
        expect(client.agentId).toBe("child");
        client.close();
    } finally {
        await host.close();
    }
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host keeps a finished child listed after its parent is trashed",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-trash-finished-child-"));
        try {
            await trashParentOfFinishedChild(root, undefined);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host lists a finished child by its own session path after its parent is trashed",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-trash-elsewhere-child-"));
        try {
            await trashParentOfFinishedChild(
                root,
                join(root, "elsewhere", "child.jsonl"),
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "session trash client normalizes transport failure",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-session-trash-client-"));
        try {
            expect(await trashSessionThroughHost(
                join(root, "missing.sock"),
                "saved",
            )).toEqual({ status: "rejected", reason: "failed" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

interface TreeHost {
    readonly socketPath: string;
    readonly sessionDirectory: string;
    readonly host: ResidentHost;
}

// Parent, then a child at the conventional path, then a grandchild whose file sits elsewhere.
async function withFinishedTree(
    root: string,
    trashSessionArtifactsOption: StartResidentHostOptions["trashSessionArtifacts"],
    run: (tree: TreeHost) => Promise<void>,
): Promise<void> {
    const socketPath = join(root, "host.sock");
    const sessionDirectory = join(root, "sessions");
    const host = await startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        },
        createAdapter: () => new FauxAdapter(
            Array.from({ length: 6 }, () => ({
                role: "assistant" as const,
                content: [{
                    type: "text" as const,
                    text: "The crow is done.",
                }],
                source: {
                    provider: "faux",
                    api: "scripted",
                    model: "test",
                },
                usage: emptyUsage(),
                stopReason: "stop" as const,
            })),
        ),
        socketPath,
        lockPath: join(root, "host.json"),
        sessionDirectory,
        eventLogDirectory: join(root, "logs"),
        ...(trashSessionArtifactsOption === undefined
            ? {}
            : { trashSessionArtifacts: trashSessionArtifactsOption }),
    });
    try {
        await host.registry.create({ id: "parent", workspace: root });
        for (
            const [id, parentId, sessionPath] of [
                ["middle", "parent", undefined],
                ["leaf", "middle", join(root, "elsewhere", "leaf.jsonl")],
            ] as const
        ) {
            await host.registry.createWithKind(
                {
                    id,
                    workspace: root,
                    ...(sessionPath === undefined ? {} : { sessionPath }),
                },
                "background",
                { approvalMode: "auto", parentId },
            );
            host.registry.find(id)!.sendPrompt(`bury the treasure for ${id}`);
            host.registry.trackAsyncSubagentTurn(id);
        }
        const deadline = Date.now() + 3_000;
        while (
            !host.registry.list().every((agent) =>
                host.registry.find(agent.id)?.idleForShutdown() === true
            )
            || host.registry.list().filter((agent) =>
                    agent.status === "completed"
                ).length !== 2
        ) {
            if (Date.now() > deadline) {
                throw new Error("the children did not finish");
            }
            await Bun.sleep(10);
        }
        await run({ socketPath, sessionDirectory, host });
    } finally {
        await host.close();
    }
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a child that stays closed after a failed trash is listed by its own session path and resumes",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-failed-trash-index-"));
        try {
            await withFinishedTree(
                root,
                async () => {
                    // The middle session cannot start again, so the leaf stays closed too.
                    await rm(join(root, "sessions", "middle.jsonl"));
                    throw new Error("trash unavailable");
                },
                async ({ socketPath, host }) => {
                    expect(await trashSessionThroughHost(socketPath, "parent"))
                        .toEqual({ status: "rejected", reason: "failed" });

                    expect(host.registry.list().map((agent) => agent.id))
                        .toEqual(["parent"]);
                    const listed = await listAgentsThroughHost(socketPath);
                    expect(listed.find((agent) => agent.id === "leaf"))
                        .toMatchObject({
                            live: false,
                            parent_id: "middle",
                            session_path: join(root, "elsewhere", "leaf.jsonl"),
                        });
                    const client = await attachAgent({
                        socketPath,
                        agentId: "leaf",
                    });
                    expect(client.agentId).toBe("leaf");
                    client.close();
                },
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "closing a parent lists its children by their own session paths",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-index-"));
        try {
            await withFinishedTree(
                root,
                undefined,
                async ({ socketPath, sessionDirectory }) => {
                    expect(await closeAgentThroughHost(socketPath, "parent"))
                        .toEqual({ status: "closed", sessionRetained: true });

                    const listed = await listAgentsThroughHost(socketPath);
                    expect(listed.map((agent) => agent.id).sort())
                        .toEqual(["leaf", "middle", "parent"]);
                    expect(listed.find((agent) => agent.id === "leaf"))
                        .toMatchObject({
                            live: false,
                            session_path: join(root, "elsewhere", "leaf.jsonl"),
                        });
                    expect(listed.find((agent) => agent.id === "middle"))
                        .toMatchObject({
                            session_path: join(sessionDirectory, "middle.jsonl"),
                        });
                },
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "closing a parent lists a child that registered while the close waited",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-late-index-"));
        try {
            await withFinishedTree(
                root,
                undefined,
                async ({ socketPath, host }) => {
                    const parent = host.registry.agents.get("parent")!;
                    const originalRun = parent.run;
                    let release: () => void = () => {};
                    const gate = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    parent.run = gate.then(() => originalRun);

                    const closing = closeAgentThroughHost(socketPath, "parent");
                    while (!parent.agent.closed) await Bun.sleep(5);
                    await host.registry.createWithKind(
                        {
                            id: "late",
                            workspace: root,
                            sessionPath: join(root, "elsewhere", "late.jsonl"),
                        },
                        "background",
                        { approvalMode: "auto", parentId: "parent" },
                    );
                    release();
                    expect(await closing)
                        .toEqual({ status: "closed", sessionRetained: true });

                    expect(host.registry.agents.has("late")).toBe(false);
                    const listed = await listAgentsThroughHost(socketPath);
                    expect(listed.find((agent) => agent.id === "late"))
                        .toMatchObject({
                            live: false,
                            session_path: join(root, "elsewhere", "late.jsonl"),
                        });
                },
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a close during a trash is refused, and a failed trash leaves the conversations running and listed",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-during-trash-"));
        let moveStarted: () => void = () => {};
        const moving = new Promise<void>((resolve) => {
            moveStarted = resolve;
        });
        let releaseMove: () => void = () => {};
        const released = new Promise<void>((resolve) => {
            releaseMove = resolve;
        });
        try {
            await withFinishedTree(
                root,
                async () => {
                    moveStarted();
                    await released;
                    throw new Error("trash unavailable");
                },
                async ({ socketPath, host }) => {
                    try {
                        const trashing = trashSessionThroughHost(
                            socketPath,
                            "parent",
                        );
                        await moving;

                        // The whole tree is unregistered and reserved while the move runs.
                        expect(host.registry.agents.size).toBe(0);
                        for (const id of ["parent", "middle", "leaf"]) {
                            expect(await closeAgentThroughHost(socketPath, id))
                                .toEqual({ status: "rejected", reason: "busy" });
                        }
                        releaseMove();

                        expect(await trashing)
                            .toEqual({ status: "rejected", reason: "failed" });
                        expect(host.registry.list().map((agent) => agent.id).sort())
                            .toEqual(["leaf", "middle", "parent"]);
                        expect((await listAgentsThroughHost(socketPath))
                            .filter((agent) => agent.live)
                            .map((agent) => agent.id).sort())
                            .toEqual(["leaf", "middle", "parent"]);
                        expect(await closeAgentThroughHost(socketPath, "parent"))
                            .toEqual({ status: "closed", sessionRetained: true });
                    } finally {
                        releaseMove();
                    }
                },
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a close during a stored session's trash is refused",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-stored-trash-"));
        const socketPath = join(root, "host.sock");
        let moveStarted: () => void = () => {};
        const moving = new Promise<void>((resolve) => {
            moveStarted = resolve;
        });
        let releaseMove: () => void = () => {};
        const released = new Promise<void>((resolve) => {
            releaseMove = resolve;
        });
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
            trashSessionArtifacts: (artifacts) =>
                trashSessionArtifacts(artifacts, {
                    moveToTrash: async () => {
                        moveStarted();
                        await released;
                    },
                }),
        });
        try {
            await host.registry.create({ id: "saved", workspace: root });
            expect(await host.registry.closeAgent("saved")).toBe("closed");

            const trashing = trashSessionThroughHost(socketPath, "saved");
            await moving;
            expect(await closeAgentThroughHost(socketPath, "saved"))
                .toEqual({ status: "rejected", reason: "busy" });
            releaseMove();

            expect(await trashing).toEqual({ status: "trashed" });
        } finally {
            releaseMove();
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a child that registers during a trash is listed after it",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-trash-late-index-"));
        let moveStarted: () => void = () => {};
        const moving = new Promise<void>((resolve) => {
            moveStarted = resolve;
        });
        let releaseMove: () => void = () => {};
        const released = new Promise<void>((resolve) => {
            releaseMove = resolve;
        });
        try {
            await withFinishedTree(
                root,
                (artifacts) =>
                    trashSessionArtifacts(artifacts, {
                        moveToTrash: async () => {
                            moveStarted();
                            await released;
                        },
                    }),
                async ({ socketPath, sessionDirectory, host }) => {
                    try {
                        // Closed through the registry, so the host has not listed it yet.
                        await host.registry.closeAgentTree("middle");
                        const middlePath = join(sessionDirectory, "middle.jsonl");
                        let resumeStarted: () => void = () => {};
                        const started = new Promise<void>((resolve) => {
                            resumeStarted = resolve;
                        });
                        let finishBind: () => void = () => {};
                        const binding = new Promise<void>((resolve) => {
                            finishBind = resolve;
                        });
                        const bind = host.registry.bindSessionIdentity.bind(
                            host.registry,
                        );
                        host.registry.bindSessionIdentity = async (store) => {
                            resumeStarted();
                            await binding;
                            return bind(store);
                        };
                        const late = host.registry.resume({
                            sessionPath: middlePath,
                        });
                        await started;

                        const trashing = trashSessionThroughHost(
                            socketPath,
                            "parent",
                        );
                        await moving;
                        finishBind();
                        await late;
                        releaseMove();
                        expect(await trashing).toEqual({ status: "trashed" });

                        expect(host.registry.agents.size).toBe(0);
                        const listed = await listAgentsThroughHost(socketPath);
                        expect(listed.map((agent) => agent.id))
                            .toEqual(["middle"]);
                        expect(listed[0]).toMatchObject({
                            live: false,
                            session_path: await realpath(middlePath),
                        });
                    } finally {
                        releaseMove();
                    }
                },
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a child closed by its parent's close_subagent is listed at its own session path",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-subagent-index-"));
        try {
            await withFinishedTree(
                root,
                undefined,
                async ({ socketPath, sessionDirectory, host }) => {
                    expect(
                        (await host.registry.closeDescendantTree(
                            "parent",
                            "middle",
                        )).status,
                    ).toBe("closed");

                    expect(host.registry.list().map((agent) => agent.id))
                        .toEqual(["parent"]);
                    const listed = await listAgentsThroughHost(socketPath);
                    expect(listed.map((agent) => agent.id).sort())
                        .toEqual(["leaf", "middle", "parent"]);
                    expect(listed.find((agent) => agent.id === "middle"))
                        .toMatchObject({
                            live: false,
                            session_path: join(sessionDirectory, "middle.jsonl"),
                        });
                    expect(listed.find((agent) => agent.id === "leaf"))
                        .toMatchObject({
                            live: false,
                            session_path: join(root, "elsewhere", "leaf.jsonl"),
                        });
                },
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

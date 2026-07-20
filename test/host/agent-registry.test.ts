import { expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    ModelSettingsUpdate,
    PermissionsUpdate,
    TaskNotificationUpdate,
    ToolApprovalUiRequestUpdate,
} from "../../src/engine/protocol.ts";
import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

test("resident agents keep file tools inside their fixed workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-registry-"));
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    await writeFile(join(firstWorkspace, "marker.txt"), "first workspace");
    await writeFile(join(secondWorkspace, "marker.txt"), "second workspace");

    const registry = createRegistry(() => readMarkerScript());
    const firstSession = join(root, "first.jsonl");
    const secondSession = join(root, "second.jsonl");

    try {
        const first = await registry.create({
            id: "first",
            workspace: firstWorkspace,
            sessionPath: firstSession,
            eventLogPath: join(root, "first-events.jsonl"),
        });
        const second = await registry.create({
            id: "second",
            workspace: secondWorkspace,
            sessionPath: secondSession,
            eventLogPath: join(root, "second-events.jsonl"),
        });

        await runPrompt(first.attach(), "read your marker");
        await runPrompt(second.attach(), "read your marker");

        expect(await toolResultText(firstSession)).toBe("first workspace");
        expect(await toolResultText(secondSession)).toBe("second workspace");
        expect(registry.list()).toEqual([
            {
                id: "first",
                workspace: await realpath(firstWorkspace),
                session_path: firstSession,
                kind: "interactive",
                status: "idle",
            },
            {
                id: "second",
                workspace: await realpath(secondWorkspace),
                session_path: secondSession,
                kind: "interactive",
                status: "idle",
            },
        ]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a resident agent applies new model settings at the next turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-settings-"));
    const faux = new FauxAdapter([
        textResponse("first reply"),
        textResponse("second reply"),
    ], { chunkSize: 1, delayMs: 10 });
    const requests: ModelRequest[] = [];
    let signalRequestStarted: () => void = () => {};
    const requestStarted = new Promise<void>((resolve) => {
        signalRequestStarted = resolve;
    });
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            signalRequestStarted();
            return faux.stream(request);
        },
    };
    const registry = new AgentRegistry({
        createAdapter: () => adapter,
        model: "first-model",
        reasoningEffort: "low",
        approvalMode: "approve_for_me",
    });

    try {
        const agent = await registry.create({
            id: "settings-agent",
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
        });
        const firstAttachment = agent.attach();
        const secondAttachment = agent.attach();
        expect((await firstAttachment.receive()).type).toBe("history");
        expect((await secondAttachment.receive()).type).toBe("history");

        firstAttachment.send({ type: "prompt", content: "first turn" });
        await requestStarted;
        secondAttachment.send({
            type: "update_model_settings",
            requestId: "change-settings",
            patch: {
                model: "second-model",
                reasoningEffort: "high",
            },
        });
        const expectedPendingSettings = {
            type: "model_settings",
            requestId: "change-settings",
            settings: {
                model: "second-model",
                reasoningEffort: "high",
            },
            pending: true,
        };
        expect(await receiveModelSettings(firstAttachment))
            .toMatchObject(expectedPendingSettings);
        expect(await receiveModelSettings(secondAttachment))
            .toMatchObject(expectedPendingSettings);
        await receiveTurnFinished(firstAttachment);
        await receiveTurnFinished(secondAttachment);

        firstAttachment.send({
            type: "get_model_settings",
            requestId: "read-settings",
        });
        const expectedEffectiveSettings = {
            type: "model_settings",
            requestId: "read-settings",
            settings: {
                model: "second-model",
                reasoningEffort: "high",
            },
            pending: false,
        };
        expect(await receiveModelSettings(firstAttachment))
            .toMatchObject(expectedEffectiveSettings);
        expect(await receiveModelSettings(secondAttachment))
            .toMatchObject(expectedEffectiveSettings);

        firstAttachment.send({ type: "prompt", content: "second turn" });
        await receiveTurnFinished(firstAttachment);
        await receiveTurnFinished(secondAttachment);

        expect(requests.map((request) => ({
            model: request.model,
            reasoningEffort: request.reasoningEffort,
        }))).toEqual([
            { model: "first-model", reasoningEffort: "low" },
            { model: "second-model", reasoningEffort: "high" },
        ]);
        const store = await SessionStore.open(join(root, "agent.jsonl"));
        expect(store.messages().filter((message) => message.role === "user"))
            .toHaveLength(2);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("accepted settings become defaults for new agents in the live host", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-live-defaults-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "first-model",
        reasoningEffort: "low",
        approvalMode: "approve_for_me",
    });

    try {
        const first = await registry.create({
            id: "first-agent",
            workspace: root,
            sessionPath: join(root, "first.jsonl"),
        });
        expect(await registry.updateModelSettings(first.id, {
            model: "second-model",
            reasoningEffort: "high",
        })).toMatchObject({ model: "second-model", reasoningEffort: "high" });
        expect(await registry.updateApprovalMode(first.id, "ask")).toBe("ask");

        const second = await registry.create({
            id: "second-agent",
            workspace: root,
            sessionPath: join(root, "second.jsonl"),
        });
        const attachment = second.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({ type: "get_model_settings", requestId: "settings" });
        expect(await receiveModelSettings(attachment)).toMatchObject({
            settings: { model: "second-model", reasoningEffort: "high" },
        });
        attachment.send({ type: "get_permissions", requestId: "permissions" });
        expect(await receivePermissions(attachment)).toMatchObject({ mode: "ask" });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a registry resumes the same resident agent from its session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-resume-"));
    const workspace = join(root, "workspace");
    const sessionPath = join(root, "agent.jsonl");
    await mkdir(workspace);

    const firstRegistry = createRegistry(() => [textResponse("first reply")]);
    try {
        const original = await firstRegistry.create({
            id: "durable-agent",
            workspace,
            sessionPath,
            eventLogPath: join(root, "first-events.jsonl"),
        });
        await runPrompt(original.attach(), "first prompt");
    } finally {
        await firstRegistry.close();
    }

    const resumedRequests: ModelRequest[] = [];
    const resumedFaux = new FauxAdapter([textResponse("second reply")]);
    const resumedRegistry = new AgentRegistry({
        createAdapter: () => ({
            stream(request) {
                resumedRequests.push(request);
                return resumedFaux.stream(request);
            },
        }),
        model: "resumed-default",
        reasoningEffort: "medium",
        approvalMode: "approve_for_me",
    });
    try {
        const resumed = await resumedRegistry.resume({
            sessionPath,
            eventLogPath: join(root, "second-events.jsonl"),
        });
        expect(resumed.id).toBe("durable-agent");
        expect(resumed.workspace).toBe(await realpath(workspace));

        const attachment = resumed.attach();
        const history = await attachment.receive();
        expect(history.type).toBe("history");
        if (history.type !== "history") {
            throw new Error("Expected resumed history");
        }
        expect(history.entries).toEqual([
            { kind: "user", text: "first prompt" },
            { kind: "assistant", text: "first reply" },
        ]);

        attachment.send({
            type: "get_model_settings",
            requestId: "read-legacy-settings",
        });
        expect(await receiveModelSettings(attachment)).toMatchObject({
            settings: {
                model: "resumed-default",
                reasoningEffort: "medium",
            },
            pending: false,
        });

        await runPrompt(attachment, "second prompt", false);
        expect(resumedRequests.map((request) => ({
            model: request.model,
            reasoningEffort: request.reasoningEffort,
        }))).toEqual([{
            model: "resumed-default",
            reasoningEffort: "medium",
        }]);
        expect(resumedRegistry.find("durable-agent")).toBe(resumed);

        const store = await SessionStore.open(sessionPath);
        expect(store.header).toMatchObject({
            id: "durable-agent",
            cwd: await realpath(workspace),
        });
        expect(store.messages().filter((message) => message.role === "user"))
            .toHaveLength(2);
    } finally {
        await resumedRegistry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a resumed agent restores its latest durable model settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-settings-resume-"));
    const sessionPath = join(root, "agent.jsonl");
    const firstRegistry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("unused")]),
        model: "first-default",
        reasoningEffort: "low",
        approvalMode: "approve_for_me",
    });

    try {
        const original = await firstRegistry.create({
            id: "durable-settings-agent",
            workspace: root,
            sessionPath,
            eventLogPath: join(root, "first-events.jsonl"),
        });
        const attachment = original.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({
            type: "update_model_settings",
            requestId: "persist-settings",
            patch: {
                model: "chosen-model",
                reasoningEffort: "high",
            },
        });
        expect(await receiveModelSettings(attachment)).toMatchObject({
            settings: {
                model: "chosen-model",
                reasoningEffort: "high",
            },
            pending: false,
        });
    } finally {
        await firstRegistry.close();
    }

    const requests: ModelRequest[] = [];
    const faux = new FauxAdapter([textResponse("resumed reply")]);
    const resumedRegistry = new AgentRegistry({
        createAdapter: () => ({
            stream(request) {
                requests.push(request);
                return faux.stream(request);
            },
        }),
        model: "new-global-default",
        reasoningEffort: "medium",
        approvalMode: "approve_for_me",
    });
    try {
        const resumed = await resumedRegistry.resume({
            sessionPath,
            eventLogPath: join(root, "resumed-events.jsonl"),
        });
        const attachment = resumed.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({
            type: "get_model_settings",
            requestId: "read-restored-settings",
        });
        expect(await receiveModelSettings(attachment)).toMatchObject({
            settings: {
                model: "chosen-model",
                reasoningEffort: "high",
            },
            pending: false,
        });
        await runPrompt(attachment, "continue", false);
        expect(requests.map((request) => ({
            model: request.model,
            reasoningEffort: request.reasoningEffort,
        }))).toEqual([{
            model: "chosen-model",
            reasoningEffort: "high",
        }]);
    } finally {
        await resumedRegistry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a resumed agent restores its durable permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-permissions-resume-"));
    const sessionPath = join(root, "agent.jsonl");
    const firstRegistry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(bashScript("first")),
        model: "faux/test",
        approvalMode: "ask",
    });

    try {
        const original = await firstRegistry.create({
            id: "durable-permissions-agent",
            workspace: root,
            sessionPath,
            eventLogPath: join(root, "first-events.jsonl"),
        });
        const attachment = original.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({
            type: "update_permissions",
            requestId: "persist-permissions",
            mode: "full_access",
        });
        expect(await receivePermissions(attachment)).toMatchObject({
            mode: "full_access",
            pending: false,
        });
        await expectPromptFinishesWithoutApproval(attachment, "first turn");
    } finally {
        await firstRegistry.close();
    }

    const resumedRegistry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(bashScript("resumed")),
        model: "faux/test",
        approvalMode: "ask",
    });
    try {
        const resumed = await resumedRegistry.resume({
            sessionPath,
            eventLogPath: join(root, "resumed-events.jsonl"),
        });
        const attachment = resumed.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({
            type: "get_permissions",
            requestId: "read-restored-permissions",
        });
        expect(await receivePermissions(attachment)).toMatchObject({
            mode: "full_access",
            pending: false,
        });
        await expectPromptFinishesWithoutApproval(attachment, "resumed turn");
        expect((await SessionStore.open(sessionPath)).approvalMode())
            .toBe("full_access");
    } finally {
        await resumedRegistry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a resumed agent restores a session command prefix grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-prefix-resume-"));
    const sessionPath = join(root, "agent.jsonl");
    const firstRegistry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(bashScript("first")),
        model: "faux/test",
        approvalMode: "ask",
    });

    try {
        const original = await firstRegistry.create({
            id: "durable-prefix-agent",
            workspace: root,
            sessionPath,
            eventLogPath: join(root, "first-events.jsonl"),
        });
        const attachment = original.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({ type: "prompt", content: "first turn" });
        const approval = await receiveToolApproval(attachment);
        expect(approval.request.commandPrefix).toEqual({ tokens: ["pwd"] });
        attachment.send({
            type: "ui_response",
            requestId: approval.requestId,
            response: { type: "tool_approval", decision: "allow_prefix" },
        });
        await receiveTurnFinished(attachment);
        expect((await SessionStore.open(sessionPath)).commandPrefixes())
            .toEqual([{ tokens: ["pwd"] }]);
    } finally {
        await firstRegistry.close();
    }

    const resumedRegistry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(bashScript("resumed")),
        model: "faux/test",
        approvalMode: "ask",
    });
    try {
        const resumed = await resumedRegistry.resume({
            sessionPath,
            eventLogPath: join(root, "resumed-events.jsonl"),
        });
        const attachment = resumed.attach();
        expect((await attachment.receive()).type).toBe("history");
        await expectPromptFinishesWithoutApproval(attachment, "resumed turn");
    } finally {
        await resumedRegistry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a failed settings append leaves the live selection unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-settings-failure-"));
    const sessionPath = join(root, "agent.jsonl");
    const backupPath = join(root, "agent.backup.jsonl");
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("unused")]),
        model: "stable-model",
        reasoningEffort: "low",
        approvalMode: "approve_for_me",
    });

    try {
        const agent = await registry.create({
            id: "settings-failure-agent",
            workspace: root,
            sessionPath,
            eventLogPath: join(root, "events.jsonl"),
        });
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");

        await rename(sessionPath, backupPath);
        await mkdir(sessionPath);
        try {
            await expect(registry.updateModelSettings(agent.id, {
                model: "lost-model",
                reasoningEffort: "high",
            })).rejects.toThrow();
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
            await rename(backupPath, sessionPath);
        }

        attachment.send({
            type: "get_model_settings",
            requestId: "read-after-failure",
        });
        expect(await receiveModelSettings(attachment)).toMatchObject({
            settings: {
                model: "stable-model",
                reasoningEffort: "low",
            },
            pending: false,
        });
        expect((await SessionStore.open(sessionPath)).modelSettings())
            .toBeUndefined();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a failed permissions append leaves the live mode unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-permissions-failure-"));
    const sessionPath = join(root, "agent.jsonl");
    const backupPath = join(root, "agent.backup.jsonl");
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("unused")]),
        model: "faux/test",
        approvalMode: "ask",
    });

    try {
        const agent = await registry.create({
            id: "permissions-failure-agent",
            workspace: root,
            sessionPath,
            eventLogPath: join(root, "events.jsonl"),
        });
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");

        await rename(sessionPath, backupPath);
        await mkdir(sessionPath);
        try {
            await expect(registry.updateApprovalMode(
                agent.id,
                "full_access",
            )).rejects.toThrow();
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
            await rename(backupPath, sessionPath);
        }

        attachment.send({
            type: "get_permissions",
            requestId: "read-after-failure",
        });
        expect(await receivePermissions(attachment)).toMatchObject({
            mode: "ask",
            pending: false,
        });
        expect((await SessionStore.open(sessionPath)).approvalMode())
            .toBeUndefined();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a resumed registry replays pending delivery without a model call", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-delivery-resume-"));
    const sessionPath = join(root, "agent.jsonl");
    const eventLogPath = join(root, "events.jsonl");
    const store = await SessionStore.create(sessionPath, {
        sessionId: "durable-agent",
        cwd: root,
    });
    await store.recordDelivery({
        id: "completion:child-1",
        sourceAgentId: "child-1",
        content: "The tests pass.",
    });
    const registry = createRegistry(() => [textResponse("unused")]);

    try {
        const agent = await registry.resume({ sessionPath, eventLogPath });
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");
        expect(await attachment.receive()).toEqual({
            type: "task_notification",
            deliveryId: "completion:child-1",
            sourceAgentId: "child-1",
            content: "The tests pass.",
            seq: 1,
        });
        expect(store.pendingDeliveries()).toHaveLength(1);
        const events = (await readFile(eventLogPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { type: string });
        expect(events.map((event) => event.type)).toEqual([
            "task_notification",
        ]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a background agent returns immediately and delivers its final summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-background-"));
    const parentSession = join(root, "parent.jsonl");
    let adapterNumber = 0;
    const registry = new AgentRegistry({
        createAdapter() {
            adapterNumber += 1;
            if (adapterNumber === 1) {
                return new FauxAdapter([
                    {
                        role: "assistant",
                        content: [{
                            type: "tool_call",
                            id: "start-background",
                            name: "background_agent",
                            input: { description: "Run the integration tests" },
                        }],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "tool_use",
                    },
                    textResponse("I started the background work."),
                ]);
            }
            return new FauxAdapter([
                textResponse("All integration tests pass."),
                textResponse("The focused tests pass too."),
            ], { delayMs: 100 });
        },
        model: "faux/test",
        approvalMode: "approve_for_me",
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        eventLogPathForId: (id) => join(root, `${id}-events.jsonl`),
    });

    try {
        const parent = await registry.create({
            id: "parent",
            workspace: root,
            sessionPath: parentSession,
            eventLogPath: join(root, "parent-events.jsonl"),
        });
        const parentAttachment = parent.attach();
        expect((await parentAttachment.receive()).type).toBe("history");
        parentAttachment.send({
            type: "update_permissions",
            requestId: "inherit-permissions",
            mode: "full_access",
        });
        expect(await receivePermissions(parentAttachment)).toMatchObject({
            mode: "full_access",
            pending: false,
        });
        await runPrompt(
            parentAttachment,
            "Run tests in the background",
            false,
        );

        const agents = registry.list();
        expect(agents).toHaveLength(2);
        expect(agents.find((agent) => agent.id === "parent")).toMatchObject({
            kind: "interactive",
            status: "idle",
        });
        const child = agents.find((agent) => agent.id !== "parent");
        expect(child).toBeDefined();
        expect(child).toMatchObject({
            kind: "background",
            status: "working",
        });
        const placeholder = await toolResultText(parentSession);
        expect(placeholder).toContain(`Background agent ${child!.id} started`);
        expect((await SessionStore.open(parentSession)).pendingDeliveries())
            .toEqual([]);

        const delivery = await waitForDelivery(parentSession);
        expect(delivery).toMatchObject({
            id: `completion:${child!.id}`,
            sourceAgentId: child!.id,
            content: "All integration tests pass.",
        });
        expect(await waitForTaskNotification(parentAttachment)).toMatchObject({
            deliveryId: `completion:${child!.id}`,
            sourceAgentId: child!.id,
            content: "All integration tests pass.",
        });
        const parentEvents = (await readFile(
            join(root, "parent-events.jsonl"),
            "utf8",
        )).trim().split("\n").map(
            (line) => JSON.parse(line) as { type: string },
        );
        expect(parentEvents.filter((event) => event.type === "model_request"))
            .toHaveLength(2);
        expect(parentEvents.filter(
            (event) => event.type === "task_notification",
        )).toHaveLength(1);
        expect(registry.list().find((agent) => agent.id === child!.id))
            .toMatchObject({ kind: "background", status: "completed" });
        expect(registry.find(child!.id)).toBeDefined();
        const childStore = await SessionStore.open(child!.session_path);
        expect(childStore.approvalMode()).toBe("full_access");
        expect(childStore.messages()).toEqual([
            {
                role: "user",
                content: [{
                    type: "text",
                    text: "Run the integration tests",
                }],
            },
            textResponse("All integration tests pass."),
        ]);
        await runPrompt(
            registry.find(child!.id)!.attach(),
            "Run the focused tests",
        );
        expect(registry.list().find((agent) => agent.id === child!.id))
            .toMatchObject({ kind: "background", status: "completed" });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a registry reserves IDs while agents start and stays closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-lifecycle-"));
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    const registry = createRegistry(() => [textResponse("unused")]);

    try {
        const attempts = await Promise.allSettled([
            registry.create({
                id: "same-id",
                workspace: firstWorkspace,
                sessionPath: join(root, "first.jsonl"),
                eventLogPath: join(root, "first-events.jsonl"),
            }),
            registry.create({
                id: "same-id",
                workspace: secondWorkspace,
                sessionPath: join(root, "second.jsonl"),
                eventLogPath: join(root, "second-events.jsonl"),
            }),
        ]);
        expect(attempts.map((result) => result.status).sort()).toEqual([
            "fulfilled",
            "rejected",
        ]);
        expect(registry.list()).toHaveLength(1);

        await registry.close();
        await expect(registry.create({
            id: "too-late",
            workspace: firstWorkspace,
            sessionPath: join(root, "late.jsonl"),
        })).rejects.toThrow("Agent registry is closed");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an adapter construction failure does not register an agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-adapter-"));
    const registry = new AgentRegistry({
        createAdapter(): never {
            throw new Error("adapter unavailable");
        },
        model: "faux/test",
        approvalMode: "approve_for_me",
    });

    try {
        await expect(registry.create({
            id: "failed-agent",
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        })).rejects.toThrow("adapter unavailable");
        expect(registry.list()).toEqual([]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("resident timeline preview and apply stay with their requesting attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-timeline-"));
    const registry = createRegistry(() => [textResponse("first answer")]);

    try {
        const agent = await registry.create({
            id: "timeline-agent",
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
        });
        const first = agent.attach();
        const second = agent.attach();
        expect((await first.receive()).type).toBe("history");
        expect((await second.receive()).type).toBe("history");

        first.send({ type: "prompt", content: "first request" });
        await Promise.all([
            receiveTurnFinished(first),
            receiveTurnFinished(second),
        ]);
        expect((await first.receive()).type).toBe("history");
        expect((await second.receive()).type).toBe("history");

        first.send({ type: "list_timeline", requestId: "list-1" });
        const timeline = await first.receive();
        expect(timeline).toMatchObject({
            type: "timeline",
            requestId: "list-1",
            boundaries: [{ prompt: "first request" }],
        });
        if (timeline.type !== "timeline") {
            throw new Error("Expected timeline reply");
        }
        const boundaryId = timeline.boundaries[0]?.userMessageId;
        if (boundaryId === undefined) {
            throw new Error("Expected a timeline boundary");
        }

        second.send({ type: "get_permissions", requestId: "permissions-1" });
        expect((await second.receive()).type).toBe("permissions");
        expect((await first.receive()).type).toBe("permissions");

        first.send({
            type: "preview_timeline_action",
            requestId: "preview-1",
            boundaryId,
            action: "rewind_conversation",
        });
        const preview = await first.receive();
        expect(preview).toMatchObject({
            type: "timeline_action_preview",
            requestId: "preview-1",
            plan: { boundary: { userMessageId: boundaryId } },
        });
        if (preview.type !== "timeline_action_preview") {
            throw new Error("Expected timeline preview");
        }

        second.send({
            type: "apply_timeline_action",
            requestId: "wrong-owner",
            planId: preview.plan.planId,
        });
        expect(await second.receive()).toMatchObject({
            type: "timeline_action_rejected",
            requestId: "wrong-owner",
            reason: "not_plan_owner",
        });

        first.detach();
        second.send({ type: "get_permissions", requestId: "detach-barrier" });
        expect((await second.receive()).type).toBe("permissions");
        second.send({
            type: "apply_timeline_action",
            requestId: "detached-plan",
            planId: preview.plan.planId,
        });
        expect(await second.receive()).toMatchObject({
            type: "timeline_action_rejected",
            requestId: "detached-plan",
            reason: "plan_expired",
        });

        second.send({
            type: "preview_timeline_action",
            requestId: "preview-2",
            boundaryId,
            action: "rewind_conversation",
        });
        const replacementPreview = await second.receive();
        if (replacementPreview.type !== "timeline_action_preview") {
            throw new Error("Expected replacement timeline preview");
        }
        second.send({
            type: "apply_timeline_action",
            requestId: "apply-1",
            planId: replacementPreview.plan.planId,
        });
        expect(await second.receive()).toMatchObject({
            type: "history",
            entries: [],
        });
        expect(await second.receive()).toMatchObject({
            type: "timeline_action_applied",
            requestId: "apply-1",
        });

        expect((await SessionStore.open(join(root, "agent.jsonl"))).messages())
            .toEqual([]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

function createRegistry(script: () => AssistantMessage[]): AgentRegistry {
    return new AgentRegistry({
        createAdapter: () => new FauxAdapter(script()),
        model: "faux/test",
        approvalMode: "approve_for_me",
    });
}

function readMarkerScript(): AssistantMessage[] {
    return [
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "read-marker",
                name: "read",
                input: { path: "marker.txt" },
            }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        textResponse("done"),
    ];
}

function bashScript(label: string): AssistantMessage[] {
    return [
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: `bash-${label}`,
                name: "bash",
                input: { command: "pwd" },
            }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        textResponse(`${label} done`),
    ];
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function runPrompt(
    attachment: AgentAttachment,
    content: string,
    consumeHistory = true,
): Promise<void> {
    if (consumeHistory) {
        expect((await attachment.receive()).type).toBe("history");
    }
    attachment.send({ type: "prompt", content });
    while ((await attachment.receive()).type !== "turn_finished") {
        // A client consumes the ordered update stream until the turn boundary.
    }
}

async function receiveTurnFinished(
    attachment: AgentAttachment,
): Promise<void> {
    while ((await attachment.receive()).type !== "turn_finished") {
        // A client consumes the ordered update stream until the turn boundary.
    }
}

async function receiveModelSettings(
    attachment: AgentAttachment,
): Promise<ModelSettingsUpdate> {
    while (true) {
        const update = await attachment.receive();
        if (update.type === "model_settings") {
            return update;
        }
    }
}

async function receivePermissions(
    attachment: AgentAttachment,
): Promise<PermissionsUpdate> {
    while (true) {
        const update = await attachment.receive();
        if (update.type === "permissions") {
            return update;
        }
    }
}

async function receiveToolApproval(
    attachment: AgentAttachment,
): Promise<ToolApprovalUiRequestUpdate> {
    while (true) {
        const update = await attachment.receive();
        if (
            update.type === "ui_request"
            && isToolApprovalUiRequestUpdate(update)
        ) {
            return update;
        }
    }
}

async function expectPromptFinishesWithoutApproval(
    attachment: AgentAttachment,
    prompt: string,
): Promise<void> {
    attachment.send({ type: "prompt", content: prompt });
    await expect(Promise.race([
        receiveTurnFinished(attachment).then(() => "finished"),
        Bun.sleep(500).then(() => "timed out"),
    ])).resolves.toBe("finished");
}

async function toolResultText(sessionPath: string): Promise<string | undefined> {
    const store = await SessionStore.open(sessionPath);
    const result = store.messages().find(
        (message) => message.role === "tool_result",
    );
    return result?.role === "tool_result" ? result.content[0]?.text : undefined;
}

async function waitForDelivery(
    sessionPath: string,
): Promise<ReturnType<SessionStore["pendingDeliveries"]>[number]> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const store = await SessionStore.open(sessionPath);
        const delivery = store.pendingDeliveries()[0];
        if (delivery !== undefined) {
            return delivery;
        }
        await Bun.sleep(5);
    }
    throw new Error("Timed out waiting for background delivery");
}

async function waitForTaskNotification(
    attachment: AgentAttachment,
): Promise<TaskNotificationUpdate> {
    while (true) {
        const update = await attachment.receive();
        if (update.type === "task_notification") {
            return update;
        }
    }
}

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

test("resident agents resolve relative file paths from their fixed workspaces", async () => {
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
        expect(registry.list()).toMatchObject([
            {
                id: "first",
                workspace: await realpath(firstWorkspace),
                session_path: firstSession,
                kind: "interactive",
                status: "idle",
                title: "read your marker",
                updated_at: expect.any(String),
            },
            {
                id: "second",
                workspace: await realpath(secondWorkspace),
                session_path: secondSession,
                kind: "interactive",
                status: "idle",
                title: "read your marker",
                updated_at: expect.any(String),
            },
        ]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a listed session is live only while someone holds it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-live-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
    });
    const liveness = (id: string): boolean | undefined =>
        registry.list().find((agent) => agent.id === id)?.live;

    try {
        await registry.create({
            id: "held",
            workspace: root,
            sessionPath: join(root, "held.jsonl"),
        });
        const other = await registry.create({
            id: "other",
            workspace: root,
            sessionPath: join(root, "other.jsonl"),
        });

        // Both sessions are resident and idle, which is the state every
        // session restored at startup is in. Being in the registry is not
        // being alive, so neither is live until one is attached.
        expect(registry.list().map((agent) => agent.status))
            .toEqual(["held", "other"].map(() => "idle"));
        expect(liveness("held")).toBe(false);
        expect(liveness("other")).toBe(false);

        const attachment = other.attach();
        expect(liveness("other")).toBe(true);
        expect(liveness("held")).toBe(false);

        attachment.detach();
        expect(liveness("other")).toBe(false);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("session trash accepts only idle unattached non-current sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-trash-"));
    const moved: string[][] = [];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        trashSessionArtifacts: async (artifacts) => {
            moved.push([
                artifacts.sessionPath,
                artifacts.attachmentsPath,
                artifacts.eventLogPath,
            ]);
        },
    });
    const currentPath = join(root, "current.jsonl");
    const targetPath = join(root, "target.jsonl");
    const targetEvents = join(root, "target-events.jsonl");

    try {
        await registry.create({
            id: "current",
            workspace: root,
            sessionPath: currentPath,
        });
        const target = await registry.create({
            id: "target",
            workspace: root,
            sessionPath: targetPath,
            eventLogPath: targetEvents,
        });

        const attachment = target.attach();
        expect(await registry.trashSession("target")).toBe("busy");
        attachment.detach();

        expect(await registry.trashSession("target"))
            .toBe("trashed");
        expect(moved).toEqual([[
            targetPath,
            `${targetPath}.attachments`,
            targetEvents,
        ]]);
        expect(registry.list().map((agent) => agent.id))
            .toEqual(["current"]);
        expect(await registry.trashSession("missing"))
            .toBe("not_found");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("session rename reaches a session nobody is attached to", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-rename-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
    });

    try {
        await registry.create({
            id: "target",
            workspace: root,
            sessionPath: join(root, "target.jsonl"),
        });

        expect(await registry.renameSession("target", "release notes"))
            .toEqual({ status: "renamed", name: "release notes" });
        expect(registry.list()).toMatchObject([
            { id: "target", title: "release notes" },
        ]);
        expect(await registry.renameSession("target", null))
            .toEqual({ status: "renamed", name: null });
        expect(await registry.renameSession("missing", "release notes"))
            .toEqual({ status: "not_found" });
        expect(await registry.renameSession("target", "   "))
            .toEqual({ status: "invalid" });
        expect(await registry.renameSession("target", "a".repeat(201)))
            .toEqual({ status: "invalid" });

        const attachment = registry.find("target")!.attach();
        expect(await registry.renameSession("target", "release notes"))
            .toEqual({ status: "busy" });
        attachment.detach();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("failed session trash restores an available resident agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-trash-failure-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        trashSessionArtifacts: () =>
            Promise.reject(new Error("trash unavailable")),
    });
    const targetPath = join(root, "target.jsonl");

    try {
        await registry.create({
            id: "target",
            workspace: root,
            sessionPath: targetPath,
        });

        expect(await registry.trashSession("target")).toBe("failed");
        expect(registry.find("target")).toBeDefined();
        expect(registry.list()).toMatchObject([{ id: "target", status: "idle" }]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("session names override and clear back to first-prompt titles", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-name-"));
    const namedPath = join(root, "named.jsonl");
    const named = await SessionStore.create(namedPath, {
        sessionId: "named",
        cwd: root,
    });
    await named.appendMessage({
        role: "user",
        content: [{ type: "text", text: "fallback prompt" }],
    });
    await named.appendName("Human name");

    const clearedPath = join(root, "cleared.jsonl");
    const cleared = await SessionStore.create(clearedPath, {
        sessionId: "cleared",
        cwd: root,
    });
    await cleared.appendMessage({
        role: "user",
        content: [{ type: "text", text: "cleared fallback" }],
    });
    await cleared.appendName("Temporary name");
    await cleared.appendName(null);

    const registry = createRegistry(() => []);
    try {
        await registry.resume({ sessionPath: namedPath });
        await registry.resume({ sessionPath: clearedPath });
        expect(registry.list().find((agent) => agent.id === "named")?.title)
            .toBe("Human name");
        expect(registry.list().find((agent) => agent.id === "cleared")?.title)
            .toBe("cleared fallback");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("the resident registry owns session name updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-rename-"));
    const sessionPath = join(root, "agent.jsonl");
    const registry = createRegistry(() => []);

    try {
        await registry.create({
            id: "rename-agent",
            workspace: root,
            sessionPath,
            eventLogPath: join(root, "events.jsonl"),
        });

        expect(await registry.updateSessionName("rename-agent", "  Work  "))
            .toBe("Work");
        expect(registry.list()[0]?.title).toBe("Work");
        expect(await registry.updateSessionName("rename-agent", null))
            .toBeNull();
        expect(registry.list()[0]?.title).toBeUndefined();
        expect((await SessionStore.open(sessionPath)).name()).toBeUndefined();
        expect(await registry.updateSessionName("missing", "Ignored"))
            .toBeUndefined();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("the resident registry creates forked and cloned agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-branch-"));
    const sourcePath = join(root, "source.jsonl");
    const registry = createRegistry(() => [
        textResponse("first answer"),
        textResponse("second answer"),
    ]);

    try {
        const source = await registry.create({
            id: "source",
            workspace: root,
            sessionPath: sourcePath,
            eventLogPath: join(root, "source-events.jsonl"),
        });
        await runPrompt(source.attach(), "first prompt");
        await runPrompt(source.attach(), "second prompt");
        const sourceStore = await SessionStore.open(sourcePath);
        const secondUser = sourceStore.activeEntries().find(
            (entry) => entry.message.role === "user"
                && entry.message.content.some(
                    (content) => content.type === "text"
                        && content.text === "second prompt",
                ),
        );

        const fork = await registry.branch({
            sourceId: "source",
            position: "before",
            entryId: secondUser?.id,
            id: "fork",
            sessionPath: join(root, "fork.jsonl"),
            eventLogPath: join(root, "fork-events.jsonl"),
        });
        expect(fork?.agent.id).toBe("fork");
        expect(fork?.prompt).toEqual({
            role: "user",
            content: [{ type: "text", text: "second prompt" }],
        });
        expect((await SessionStore.open(join(root, "fork.jsonl"))).messages())
            .toEqual(sourceStore.messages().slice(0, 2));

        const clone = await registry.branch({
            sourceId: "source",
            position: "at",
            id: "clone",
            sessionPath: join(root, "clone.jsonl"),
            eventLogPath: join(root, "clone-events.jsonl"),
        });
        expect(clone?.agent.id).toBe("clone");
        expect(clone?.prompt).toBeUndefined();
        expect((await SessionStore.open(join(root, "clone.jsonl"))).messages())
            .toEqual(sourceStore.messages());
        expect(await registry.branch({
            sourceId: "missing",
            position: "at",
        })).toBeUndefined();

        // Both branch positions name the session they came from, so a client
        // can show a fork under its parent instead of beside it.
        const listed = new Map(
            registry.list().map((agent) => [agent.id, agent.forked_from]),
        );
        expect(listed.get("fork")).toBe("source");
        expect(listed.get("clone")).toBe("source");
        expect(listed.get("source")).toBeUndefined();
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
        approvalMode: "auto",
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
                provider: "ollama",
                model: "second-model",
                reasoningEffort: "high",
            },
        });
        const expectedPendingSettings = {
            type: "model_settings",
            requestId: "change-settings",
            settings: {
                provider: "ollama",
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
                provider: "ollama",
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
            provider: request.provider,
            model: request.model,
            reasoningEffort: request.reasoningEffort,
        }))).toEqual([
            { provider: "unknown", model: "first-model", reasoningEffort: "low" },
            { provider: "ollama", model: "second-model", reasoningEffort: "high" },
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
        provider: "openrouter",
        model: "first-model",
        reasoningEffort: "low",
        approvalMode: "auto",
    });

    try {
        const first = await registry.create({
            id: "first-agent",
            workspace: root,
            sessionPath: join(root, "first.jsonl"),
        });
        // An effort the target cannot take does not sink the model change:
        // the switch is the request and the effort coerces to the strongest
        // level the target offers.
        expect(await registry.updateModelSettings(first.id, {
            model: "z-ai/glm-5.2",
            reasoningEffort: "off",
        })).toMatchObject({ model: "z-ai/glm-5.2", reasoningEffort: "max" });
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
        expect(await receivePermissions(attachment)).toMatchObject({
            mode: "ask",
            inspection: {
                selected: {
                    name: "ask",
                    defaultOutcome: "ask",
                },
                activeGrants: [],
            },
        });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("switching models chooses the strongest supported reasoning fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-reasoning-fallback-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        provider: "openrouter",
        model: "first-model",
        reasoningEffort: "medium",
        approvalMode: "auto",
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        });
        expect(await registry.updateModelSettings(agent.id, {
            model: "moonshotai/kimi-k3",
        })).toMatchObject({
            model: "moonshotai/kimi-k3",
            reasoningEffort: "max",
        });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an unmapped codex model drops the effort rather than failing the turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-codex-unmapped-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        approvalMode: "auto",
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        });

        // Carrying "high" onto a model with no profile would throw inside the
        // adapter mid-turn, so the switch drops it and says the dial is gone.
        const switched = await registry.updateModelSettings(agent.id, {
            model: "gpt-5.6-codex",
        });
        expect(switched).toMatchObject({
            model: "gpt-5.6-codex",
            availableReasoningEfforts: [],
        });
        expect(switched?.reasoningEffort).toBeUndefined();

        // Asking for one outright is a different request, and is refused.
        expect(await registry.updateModelSettings(agent.id, {
            reasoningEffort: "medium",
        })).toBeUndefined();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("configured settings the provider cannot honour never reach the adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-codex-config-"));
    const faux = new FauxAdapter([textResponse("reply")]);
    const requests: ModelRequest[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => ({
            stream(request) {
                requests.push(request);
                return faux.stream(request);
            },
        }),
        provider: "openai-codex",
        model: "gpt-5.6-codex",
        reasoningEffort: "max",
        approvalMode: "auto",
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
        });
        await runPrompt(agent.attach(), "a turn");

        // Config never passes through updateModelSettings, so without a check
        // at creation this combination would reach the adapter and throw there.
        expect(requests.map((request) => ({
            model: request.model,
            reasoningEffort: request.reasoningEffort,
        }))).toEqual([{ model: "gpt-5.6-codex", reasoningEffort: undefined }]);
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
        approvalMode: "auto",
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
        approvalMode: "auto",
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
        approvalMode: "auto",
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

test("a resumed agent restores its own provider, not the current global default", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-provider-resume-"));
    const sessionPath = join(root, "agent.jsonl");
    const firstRegistry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("unused")]),
        provider: "openrouter",
        model: "first-default",
        approvalMode: "auto",
    });

    try {
        const original = await firstRegistry.create({
            id: "durable-provider-agent",
            workspace: root,
            sessionPath,
            eventLogPath: join(root, "first-events.jsonl"),
        });
        const attachment = original.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({
            type: "update_model_settings",
            requestId: "persist-provider",
            patch: {
                provider: "ollama",
                model: "chosen-model",
            },
        });
        expect(await receiveModelSettings(attachment)).toMatchObject({
            settings: {
                provider: "ollama",
                model: "chosen-model",
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
        provider: "openrouter",
        model: "new-global-default",
        approvalMode: "auto",
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
            requestId: "read-restored-provider",
        });
        expect(await receiveModelSettings(attachment)).toMatchObject({
            settings: {
                provider: "ollama",
                model: "chosen-model",
            },
            pending: false,
        });
        // The routed request is what actually reaches an adapter, so the
        // provider has to survive all the way to the turn, not only to the
        // settings the client reads back.
        await runPrompt(attachment, "continue", false);
        expect(requests.map((request) => ({
            provider: request.provider,
            model: request.model,
        }))).toEqual([{
            provider: "ollama",
            model: "chosen-model",
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

test("a failed settings append leaves the live selection unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-settings-failure-"));
    const sessionPath = join(root, "agent.jsonl");
    const backupPath = join(root, "agent.backup.jsonl");
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("unused")]),
        model: "stable-model",
        reasoningEffort: "low",
        approvalMode: "auto",
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

test("a resumed registry wakes the model for a pending delivery", async () => {
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
            kind: "completion",
            seq: 1,
        });
        expect(await attachment.receive()).toEqual({
            type: "status",
            state: "working",
            seq: 2,
        });
        expect(await finishTurnText(attachment)).toBe("unused");
        expect((await SessionStore.open(sessionPath)).pendingDeliveries())
            .toEqual([]);
        const events = (await readFile(eventLogPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { type: string });
        expect(events.map((event) => event.type).filter(
            (type) => type !== "model_stream",
        )).toEqual([
            "task_notification",
            "delivery_turn_started",
            "model_request",
            "context_measured",
            "turn_finished",
        ]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a resumed registry retries a delivery turn interrupted before its reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-delivery-retry-"));
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
    await store.appendDeliveryMessage("completion:child-1", {
        role: "user",
        internal: true,
        content: [{
            type: "text",
            text: "<task_notification>The tests pass.</task_notification>",
        }],
    });
    expect(store.pendingDeliveries()).toEqual([]);
    expect(store.hasUnansweredDeliveryTurn()).toBe(true);
    const registry = createRegistry(() => [textResponse("Recovered reply")]);

    try {
        const agent = await registry.resume({ sessionPath, eventLogPath });
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");
        expect(await attachment.receive()).toEqual({
            type: "status",
            state: "working",
            seq: 1,
        });
        expect(await finishTurnText(attachment)).toBe("Recovered reply");
        expect((await SessionStore.open(sessionPath)).hasUnansweredDeliveryTurn())
            .toBe(false);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an async subagent returns immediately and delivers its final summary", async () => {
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
                            name: "async_subagent",
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
                    textResponse("I incorporated the background result."),
                ]);
            }
            return new FauxAdapter([
                textResponse("All integration tests pass."),
                textResponse("The focused tests pass too."),
            ], { delayMs: 100 });
        },
        model: "faux/test",
        approvalMode: "auto",
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
            parent_id: "parent",
        });
        const placeholder = await toolResultText(parentSession);
        expect(placeholder).toContain(`Async subagent ${child!.id} started`);
        expect((await SessionStore.open(parentSession)).pendingDeliveries())
            .toEqual([]);

        expect(await waitForTaskNotification(parentAttachment)).toMatchObject({
            deliveryId: `completion:${child!.id}`,
            sourceAgentId: child!.id,
            content: "All integration tests pass.",
        });
        expect(await finishTurnText(parentAttachment)).toBe(
            "I incorporated the background result.",
        );
        expect((await SessionStore.open(parentSession)).pendingDeliveries())
            .toEqual([]);
        const parentEvents = (await readFile(
            join(root, "parent-events.jsonl"),
            "utf8",
        )).trim().split("\n").map(
            (line) => JSON.parse(line) as { type: string },
        );
        expect(parentEvents.filter((event) => event.type === "model_request"))
            .toHaveLength(3);
        expect(parentEvents.filter(
            (event) => event.type === "task_notification",
        )).toHaveLength(1);
        expect(registry.list().find((agent) => agent.id === child!.id))
            .toMatchObject({ kind: "background", status: "completed" });
        expect(registry.find(child!.id)).toBeDefined();
        const childStore = await SessionStore.open(child!.session_path);
        expect(childStore.approvalMode()).toBe("full_access");
        const childEvents = (await readFile(
            join(root, `${child!.id}-events.jsonl`),
            "utf8",
        )).trim().split("\n").map(
            (line) => JSON.parse(line) as {
                type: string;
                tools?: readonly { name: string }[];
            },
        );
        const childRequest = childEvents.find(
            (event) => event.type === "model_request",
        );
        expect(childRequest?.tools?.map((tool) => tool.name)).not.toContain(
            "subagent",
        );
        expect(childRequest?.tools?.map((tool) => tool.name)).not.toContain(
            "async_subagent",
        );
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
        // A prompt sent straight to the child is the user's own conversation:
        // the child runs it, and the parent hears nothing about it.
        await runPrompt(
            registry.find(child!.id)!.attach(),
            "Run the focused tests",
        );
        expect((await SessionStore.open(parentSession)).pendingDeliveries())
            .toEqual([]);
        const eventsAfterDirectPrompt = (await readFile(
            join(root, "parent-events.jsonl"),
            "utf8",
        )).trim().split("\n").map(
            (line) => JSON.parse(line) as { type: string },
        );
        expect(eventsAfterDirectPrompt.filter(
            (event) => event.type === "task_notification",
        )).toHaveLength(1);
        expect(registry.list().find((agent) => agent.id === child!.id))
            .toMatchObject({ kind: "background", status: "completed" });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a resumed async subagent keeps its parent across restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-parent-resume-"));
    let adapterNumber = 0;
    const buildRegistry = () => new AgentRegistry({
        createAdapter() {
            adapterNumber += 1;
            if (adapterNumber === 1) {
                return new FauxAdapter([
                    {
                        role: "assistant",
                        content: [{
                            type: "tool_call",
                            id: "start-background",
                            name: "async_subagent",
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
                    textResponse("I incorporated the background result."),
                ]);
            }
            return new FauxAdapter([
                textResponse("All integration tests pass."),
            ]);
        },
        model: "faux/test",
        approvalMode: "auto",
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        eventLogPathForId: (id) => join(root, `${id}-events.jsonl`),
    });

    const registry = buildRegistry();
    let childId: string;
    try {
        const parent = await registry.create({ id: "parent", workspace: root });
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
        await waitForTaskNotification(parentAttachment);
        await finishTurnText(parentAttachment);
        childId = registry.list()
            .find((agent) => agent.id !== "parent")!.id;
    } finally {
        await registry.close();
    }

    const childSession = join(root, `${childId}.jsonl`);
    expect((await SessionStore.open(childSession)).header.parentId)
        .toBe("parent");

    const orphanRegistry = buildRegistry();
    try {
        await orphanRegistry.resume({ sessionPath: childSession });
        const orphan = orphanRegistry.list()
            .find((agent) => agent.id === childId);
        expect(orphan).toMatchObject({ kind: "background" });
        expect(orphan?.parent_id).toBeUndefined();

        await orphanRegistry.resume({
            sessionPath: join(root, "parent.jsonl"),
        });
        expect(orphanRegistry.list().find((agent) => agent.id === childId))
            .toMatchObject({ kind: "background", parent_id: "parent" });
    } finally {
        await orphanRegistry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a parent and async subagent exchange durable messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-messages-"));
    const parentSession = join(root, "parent.jsonl");
    const replyInput = {
        subagent_id: "pending",
        message: "Use src/parser.ts as canonical.",
    };
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
                            id: "spawn-child",
                            name: "async_subagent",
                            input: { description: "Audit both parsers" },
                        }],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "tool_use",
                    },
                    textResponse("Audit started."),
                    {
                        role: "assistant",
                        content: [{
                            type: "tool_call",
                            id: "reply-to-child",
                            name: "message_subagent",
                            input: replyInput,
                        }],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "tool_use",
                    },
                    textResponse("I answered the child."),
                    textResponse("I received the final audit."),
                    {
                        role: "assistant",
                        content: [{
                            type: "tool_call",
                            id: "reuse-child",
                            name: "message_subagent",
                            input: replyInput,
                        }],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "tool_use",
                    },
                    textResponse("I reused the child."),
                    textResponse("I received the second audit."),
                ]);
            }
            return new FauxAdapter([
                {
                    role: "assistant",
                    content: [{
                        type: "tool_call",
                        id: "ask-parent",
                        name: "notify_parent",
                        input: {
                            message: "Which parser is canonical?",
                        },
                    }],
                    source: {
                        provider: "faux",
                        api: "scripted",
                        model: "test",
                    },
                    usage: emptyUsage(),
                    stopReason: "tool_use",
                },
                textResponse("Waiting for the parent."),
                textResponse("src/parser.ts is canonical."),
                textResponse("Second parser pass complete."),
                textResponse("Human-directed parser pass complete."),
            ], { delayMs: 25 });
        },
        model: "faux/test",
        approvalMode: "auto",
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
        const attachment = parent.attach();
        await runPrompt(attachment, "Start the parser audit", false);
        const child = registry.list().find((agent) => agent.id !== "parent");
        expect(child).toBeDefined();
        replyInput.subagent_id = child!.id;

        expect(await waitForTaskNotification(attachment)).toMatchObject({
            deliveryId: expect.stringContaining(`attention:${child!.id}:`),
            sourceAgentId: child!.id,
            content: "Which parser is canonical?",
        });
        expect(await finishTurnText(attachment)).toBe(
            "I answered the child.",
        );
        expect(await waitForTaskNotification(attachment)).toMatchObject({
            deliveryId: `completion:${child!.id}`,
            sourceAgentId: child!.id,
            content: "src/parser.ts is canonical.",
        });
        expect(await finishTurnText(attachment)).toBe(
            "I received the final audit.",
        );

        await runPrompt(attachment, "Ask the same child for another pass", false);
        expect(await waitForTaskNotification(attachment)).toMatchObject({
            deliveryId: `completion:${child!.id}:2`,
            sourceAgentId: child!.id,
            content: "Second parser pass complete.",
        });
        expect(await finishTurnText(attachment)).toBe(
            "I received the second audit.",
        );

        const childAgent = registry.find(child!.id);
        expect(childAgent).toBeDefined();
        const childAttachment = childAgent!.attach();
        // Directly prompting the child is not an assignment from the parent,
        // so no completion follows it.
        await runPrompt(
            childAttachment,
            "Run one pass requested directly from the TUI",
            false,
        );
        childAttachment.detach();
        expect((await SessionStore.open(parentSession)).pendingDeliveries())
            .toEqual([]);

        const childStore = await SessionStore.open(child!.session_path);
        expect(childStore.messages().filter((message) => message.role === "user"))
            .toEqual([
                {
                    role: "user",
                    content: [{ type: "text", text: "Audit both parsers" }],
                },
                {
                    role: "user",
                    content: [{
                        type: "text",
                        text: "Use src/parser.ts as canonical.",
                    }],
                },
                {
                    role: "user",
                    content: [{
                        type: "text",
                        text: "Use src/parser.ts as canonical.",
                    }],
                },
                {
                    role: "user",
                    content: [{
                        type: "text",
                        text: "Run one pass requested directly from the TUI",
                    }],
                },
            ]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("async subagent approvals surface in the interactive parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-background-approval-"));
    const outside = `${root}-outside.txt`;
    const parentSession = join(root, "parent.jsonl");
    let adapterNumber = 0;
    const registry = new AgentRegistry({
        createAdapter() {
            adapterNumber += 1;
            return adapterNumber === 1
                ? new FauxAdapter([
                    {
                        role: "assistant",
                        content: [{
                            type: "tool_call",
                            id: "spawn-child",
                            name: "async_subagent",
                            input: { description: "write the background marker" },
                        }],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "tool_use",
                    },
                    textResponse("Background work started."),
                    textResponse("Background result received."),
                ])
                : new FauxAdapter([
                    {
                        role: "assistant",
                        content: [{
                            type: "tool_call",
                            id: "write-marker",
                            name: "bash",
                            input: { command: `printf child > ${outside}` },
                        }],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "tool_use",
                    },
                    textResponse("Marker written."),
                ]);
        },
        model: "faux/test",
        approvalMode: "ask",
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
        const attachment = parent.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({
            type: "prompt",
            content: "Start the marker task",
        });
        let approval: ToolApprovalUiRequestUpdate | undefined;
        while (true) {
            const update = await attachment.receive();
            if (
                update.type === "ui_request"
                && isToolApprovalUiRequestUpdate(update)
            ) {
                approval = update;
            }
            if (update.type === "turn_finished") {
                break;
            }
        }
        approval ??= await receiveToolApproval(attachment);
        expect(approval.request).toMatchObject({
            sourceAgentId: expect.any(String),
            sourceTask: "write the background marker",
        });
        expect(approval.request.permissionGrants).toBeUndefined();
        attachment.send({
            type: "ui_response",
            requestId: approval.requestId,
            response: { type: "tool_approval", decision: "allow_once" },
        });

        expect(await waitForTaskNotification(attachment)).toMatchObject({
            content: "Marker written.",
        });
        expect(await finishTurnText(attachment)).toBe(
            "Background result received.",
        );
        expect(await readFile(outside, "utf8")).toBe("child");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
        await rm(outside, { force: true });
    }
});

test("async subagent concurrency has an explicit cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-background-limit-"));
    let adapterNumber = 0;
    const registry = new AgentRegistry({
        createAdapter: () => {
            adapterNumber += 1;
            return adapterNumber === 1
                ? new FauxAdapter([
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "tool_call",
                                id: "first-background",
                                name: "async_subagent",
                                input: { description: "first task" },
                            },
                            {
                                type: "tool_call",
                                id: "second-background",
                                name: "async_subagent",
                                input: { description: "second task" },
                            },
                        ],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "tool_use",
                    },
                    textResponse("Launches handled."),
                    textResponse("Background result received."),
                ])
                : new FauxAdapter([textResponse("child done")], {
                    delayMs: 50,
                });
        },
        model: "faux/test",
        approvalMode: "auto",
        maxConcurrentBackgroundAgents: 1,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        eventLogPathForId: (id) => join(root, `${id}-events.jsonl`),
    });

    try {
        expect(() =>
            new AgentRegistry({
                createAdapter: () => new FauxAdapter([]),
                model: "faux/test",
                approvalMode: "auto",
                maxConcurrentBackgroundAgents: 0,
            })
        ).toThrow("Maximum concurrent child agents must be a positive integer");

        const parent = await registry.create({
            id: "parent",
            workspace: root,
            sessionPath: join(root, "parent.jsonl"),
        });
        await runPrompt(parent.attach(), "Start both tasks", false);
        const results = (await SessionStore.open(join(root, "parent.jsonl")))
            .messages()
            .filter((message) => message.role === "tool_result");
        expect(results).toHaveLength(2);
        expect(results.some((message) =>
            message.role === "tool_result"
            && message.isError
            && message.content[0]?.text
                === "Async subagent limit reached (1 running)."
        )).toBe(true);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("restored idle subagents do not consume async concurrency slots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-restored-background-limit-"));
    const parentPath = join(root, "parent.jsonl");
    const childPath = join(root, "old-child.jsonl");
    await SessionStore.create(parentPath, {
        sessionId: "parent",
        cwd: root,
    });
    await SessionStore.create(childPath, {
        sessionId: "old-child",
        cwd: root,
        parentId: "parent",
    });
    let adapterNumber = 0;
    const registry = new AgentRegistry({
        createAdapter: () => {
            adapterNumber += 1;
            if (adapterNumber === 1) {
                return new FauxAdapter([
                    {
                        role: "assistant",
                        content: [{
                            type: "tool_call",
                            id: "new-background",
                            name: "async_subagent",
                            input: { description: "new task" },
                        }],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "tool_use",
                    },
                    textResponse("Launch handled."),
                    textResponse("Background result received."),
                ]);
            }
            return adapterNumber === 2
                ? new FauxAdapter([])
                : new FauxAdapter([textResponse("new child done")]);
        },
        model: "faux/test",
        approvalMode: "auto",
        maxConcurrentBackgroundAgents: 1,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        eventLogPathForId: (id) => join(root, `${id}-events.jsonl`),
    });

    try {
        const parent = await registry.resume({ sessionPath: parentPath });
        await registry.resume({ sessionPath: childPath });
        await runPrompt(parent.attach(), "Start another task", false);
        const results = (await SessionStore.open(parentPath)).messages()
            .filter((message) => message.role === "tool_result");
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ isError: false });
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

test("a restarted registry replays a durable resident failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-failure-replay-"));
    const sessionPath = join(root, "agent.jsonl");
    const store = await SessionStore.create(sessionPath, {
        sessionId: "failed-agent",
        cwd: root,
    });
    await store.appendAgentFailure(
        "failure-1",
        "Resident agent stopped unexpectedly",
    );
    let adapterCreations = 0;
    const registry = new AgentRegistry({
        createAdapter() {
            adapterCreations += 1;
            return new FauxAdapter([textResponse("must not run")]);
        },
        model: "faux/test",
        approvalMode: "auto",
    });

    try {
        const agent = await registry.resume({ sessionPath });
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");
        expect(await attachment.receive()).toEqual({
            type: "agent_failed",
            failureId: "failure-1",
            detail: "Resident agent stopped unexpectedly",
            seq: 1,
        });
        await expect(attachment.receive()).rejects.toThrow();
        expect(() => attachment.send({ type: "prompt", content: "retry" }))
            .toThrow();
        expect(adapterCreations).toBe(0);
        expect(registry.list()).toMatchObject([{
            id: "failed-agent",
            status: "failed",
        }]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a failure-record write error still reaches live attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-failure-write-"));
    const sessionPath = join(root, "agent.jsonl");
    const backupPath = join(root, "agent.backup.jsonl");
    const registry = createRegistry(() => [textResponse("must not finish")]);

    try {
        const agent = await registry.create({
            id: "volatile-failure-agent",
            workspace: root,
            sessionPath,
            eventLogPath: join(root, "events.jsonl"),
        });
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");

        await rename(sessionPath, backupPath);
        await mkdir(sessionPath);
        attachment.send({ type: "prompt", content: "trigger persistence" });
        const failure = await attachment.receive();
        expect(failure).toMatchObject({
            type: "agent_failed",
            detail: "Resident agent stopped unexpectedly",
        });
        await expect(attachment.receive()).rejects.toThrow();
        expect(() => attachment.send({
            type: "prompt",
            content: "must stay terminal",
        })).toThrow();
        expect(registry.list()).toMatchObject([{
            id: "volatile-failure-agent",
            status: "failed",
        }]);

        await rm(sessionPath, { recursive: true, force: true });
        await rename(backupPath, sessionPath);
        expect((await SessionStore.open(sessionPath)).agentFailure())
            .toBeUndefined();
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
        approvalMode: "auto",
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

async function finishTurnText(
    attachment: AgentAttachment,
): Promise<string> {
    let text = "";
    while (true) {
        const update = await attachment.receive();
        if (update.type === "assistant_delta") {
            text += update.text;
        } else if (update.type === "turn_finished") {
            return text;
        }
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

test("editing the pool keeps the running model and reports the new list", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-pool-"));
    const edits: { action: string; provider: string; model: string }[] = [];
    let pooled: {
        provider: string;
        model: string;
        label: string;
        available: boolean;
        status: "ready" | "needs_verify";
        levels: never[];
    }[] = [
        {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            label: "GPT-5.6-Sol",
            available: true,
            status: "ready",
            levels: [],
        },
    ];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        approvalMode: "auto",
        readPool: () => pooled,
        admitToPool: async (entry, onStep) => {
            edits.push({ action: "add", ...entry });
            onStep({
                step: "response",
                label: "Model responds",
                status: "passed",
            });
            pooled = [{
                ...entry,
                label: entry.model,
                available: true,
                status: "ready",
                levels: [],
            }, ...pooled];
            return { verdict: "added" };
        },
        removeFromPool: (entry) => {
            edits.push({ action: "remove", ...entry });
            pooled = pooled.filter((item) => item.model !== entry.model);
        },
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        });

        const steps: string[] = [];
        const added = await registry.poolAdd(agent.id, {
            provider: "openrouter",
            model: "  moonshotai/kimi-k3  ",
        }, (step) => steps.push(`${step.step}:${step.status}`));

        expect(added.verdict).toBe("added");
        expect(steps).toEqual(["response:passed"]);
        expect(added.settings?.pooled).toMatchObject([
            { provider: "openrouter", model: "moonshotai/kimi-k3" },
            { provider: "openai-codex", model: "gpt-5.6-sol" },
        ]);

        const settings = await registry.poolRemove(agent.id, {
            provider: "openai-codex",
            model: "  gpt-5.6-sol  ",
        });

        expect(edits).toEqual([
            {
                action: "add",
                provider: "openrouter",
                model: "moonshotai/kimi-k3",
            },
            {
                action: "remove",
                provider: "openai-codex",
                model: "gpt-5.6-sol",
            },
        ]);
        // Keeping a model is not choosing one: the turn still runs on kimi.
        expect(settings).toMatchObject({
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
        });
        expect(settings?.pooled).toMatchObject([
            { provider: "openrouter", model: "moonshotai/kimi-k3" },
        ]);

        expect(await registry.poolAdd("no-such-agent", {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
        }, () => {})).toEqual({
            verdict: "unavailable",
            reason: "admission unavailable",
        });
        expect(await registry.poolRemove("no-such-agent", {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
        })).toBeUndefined();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a stored effort a model's discovered levels refuse is not served", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-refused-effort-"));
    const cacheDir = join(root, "cache");
    const makeRegistry = () => new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        provider: "ollama",
        model: "granite4.1:8b",
        reasoningEffort: "max",
        approvalMode: "auto",
        cacheDir,
    });
    const readSettings = async (
        agent: { attach: () => AgentAttachment },
        requestId: string,
    ) => {
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({ type: "get_model_settings", requestId });
        while (true) {
            const update = await receiveModelSettings(attachment);
            if (update.requestId === requestId) {
                return update.settings;
            }
        }
    };
    const writeSnapshot = () => writeFile(
        join(cacheDir, "ollama.json"),
        JSON.stringify({
            schema_version: 2,
            provider: "ollama",
            models: [
                { id: "granite4.1:8b", label: "granite4.1:8b", levels: [] },
            ],
        }),
    );

    const liveRegistry = makeRegistry();
    try {
        await mkdir(cacheDir, { recursive: true });
        const agent = await liveRegistry.create({
            id: "granite",
            workspace: root,
            sessionPath: join(root, "granite.jsonl"),
        });
        // No snapshot yet: the optimistic fallback keeps the stored dial.
        expect(await readSettings(agent, "before")).toMatchObject({
            reasoningEffort: "max",
        });

        await writeSnapshot();
        const settings = await readSettings(agent, "after");
        expect(settings.reasoningEffort).toBeUndefined();
        expect(settings.availableReasoningEfforts).toEqual([]);
    } finally {
        await liveRegistry.close();
    }

    const resumedRegistry = makeRegistry();
    try {
        const resumed = await resumedRegistry.resume({
            sessionPath: join(root, "granite.jsonl"),
        });
        const settings = await readSettings(resumed, "resumed");
        expect(settings.reasoningEffort).toBeUndefined();
        expect(settings.availableReasoningEfforts).toEqual([]);
    } finally {
        await resumedRegistry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an agent starts even when the configured provider has no credential", async () => {
    // Otherwise there is no way back: no credential means no agent, no agent
    // means no TUI, and the connect pane that fixes it lives inside the TUI.
    // This replaces an older rule that a failure to build the adapter left no
    // agent registered. Nothing builds an adapter at create any more, so the
    // failure lands on the first turn, where it can be read and acted on.
    const root = await mkdtemp(join(tmpdir(), "vera-agent-nocreds-"));
    const registry = new AgentRegistry({
        createAdapter: () => {
            throw new Error("No credentials for provider openrouter.");
        },
        model: "faux/test",
        approvalMode: "auto",
    });

    try {
        const agent = await registry.create({
            id: "fresh",
            workspace: root,
            sessionPath: join(root, "fresh.jsonl"),
        });

        expect(agent.id).toBe("fresh");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

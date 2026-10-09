import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import {
    defaultVeraConfigPath,
    loadVeraConfig,
} from "../../../src/config.ts";
import { includedExtensionConfigs } from "../../../src/extensions/included.ts";
import { loadExtensionManifest } from "../../../src/extensions/manifest.ts";
import { startExtensionRegistry } from "../../../src/extensions/registry.ts";
import { AgentRegistry } from "../../../src/host/agent-registry.ts";
import { subagentPoolPolicy } from "../../../src/host/subagent-policy.ts";
import { pooledModels } from "../../../src/model/catalog-view.ts";
import { applyModelOperation } from "../../../src/model/model-operations.ts";
import { loadPoolFile } from "../../../src/model/pool-file-loader.ts";
import {
    addPoolModel,
    recordModelVerification,
} from "../../../src/model/pool-file-store.ts";
import type { SuggestedModel } from "../../../src/model/supported-models.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../../src/model/types.ts";
import { SessionStore } from "../../../src/store/session-store.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("missing subagent settings are configured and confirmed through the real TUI store", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-subagent-config-"));
    const workspace = join(home, "workspace");
    const sessionDirectory = join(home, "sessions");
    const poolPath = join(home, ".vera", "pool.json");
    const previousPoolPath = process.env.VERA_POOL_FILE;
    process.env.VERA_POOL_FILE = poolPath;
    const availableModels: readonly SuggestedModel[] = [
        {
            provider: "faux",
            model: "test",
            label: "Parent",
            description: "scripted parent model",
        },
        {
            provider: "ollama",
            model: "worker",
            label: "Worker",
            description: "in your library subagent model",
        },
    ];
    let adapterCount = 0;
    let childModelCalls = 0;
    let registry: AgentRegistry | undefined;
    let configPath = "";
    let configDirectoryLocked = false;

    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 35,
        dependencies: async () => {
            await Bun.write(join(workspace, ".keep"), "");
            addPoolModel("ollama/worker", { added: true }, { path: poolPath });
            recordModelVerification("ollama/worker", {
                probe: { ok: true, seen: "2026-09-22" },
            }, { path: poolPath });
            configPath = defaultVeraConfigPath();
            registry = new AgentRegistry({
                createAdapter(): ModelAdapter {
                    adapterCount += 1;
                    const child = adapterCount > 1;
                    const delegate = new FauxAdapter(child
                        ? [textResponse("Child completed.", "worker")]
                        : [
                            {
                                role: "assistant",
                                content: [
                                    {
                                        type: "tool_call",
                                        id: "spawn-one",
                                        name: "async_subagent",
                                        input: {
                                            description: "first delegated task",
                                            model: "composer-2",
                                        },
                                    },
                                    {
                                        type: "tool_call",
                                        id: "spawn-two",
                                        name: "async_subagent",
                                        input: {
                                            description: "second delegated task",
                                            model: "composer-3",
                                        },
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
                            textResponse("Both launches handled.", "test"),
                        ]);
                    return {
                        stream(request) {
                            if (child) childModelCalls += 1;
                            return delegate.stream(request);
                        },
                    };
                },
                provider: "faux",
                model: "test",
                approvalMode: "auto",
                availableModels,
                readPool: () => pooledModels(availableModels, {
                    userPath: poolPath,
                }),
                readPolicy: () => subagentPoolPolicy({
                    userPath: poolPath,
                    configPath,
                }),
                sessionPathForId: (id) => join(sessionDirectory, `${id}.jsonl`),
            });
            const parent = await registry.create({
                id: "parent",
                workspace,
                sessionPath: join(sessionDirectory, "parent.jsonl"),
            });
            const attachment = parent.attach();
            let detached = false;
            const client: TuiAgentClient = {
                agentId: parent.id,
                workspace: parent.workspace,
                async send(command) {
                    attachment.send(command);
                },
                receive(signal) {
                    return attachment.receive(signal);
                },
                async detach() {
                    if (detached) return;
                    detached = true;
                    attachment.detach();
                },
                close() {
                    if (detached) return;
                    detached = true;
                    attachment.detach();
                },
            };
            return { client };
        },
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("delegate both tasks");
        session.sendKey("Enter");

        let pane = await session.waitForVisiblePane("Subagent models");
        expect(pane).toContain("Not set");
        expect(pane).toContain("Assigned · fallback order");
        expect(pane).toContain("Connected models");
        expect(pane).toContain("Worker");
        expect(pane).toContain("Parent model fallback");
        expect(pane).toContain("test");
        expect(adapterCount).toBe(1);
        expect(childModelCalls).toBe(0);
        expect(registry?.list()).toHaveLength(1);

        // Typing filters the list to the worker; Enter assigns it without
        // dismissing the policy pane.
        session.sendText("work");
        pane = await session.waitForVisiblePaneWhere(
            (frame) => !frame.includes("Not set"),
            "the search to filter out Not set",
        );
        expect(pane).not.toContain("Parent model fallback");
        expect(pane).toContain("Worker");
        chmodSync(dirname(configPath), 0o500);
        configDirectoryLocked = true;
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Could not write the assignment");
        expect(pane).toContain("Subagent models");
        expect(existsSync(configPath)).toBe(false);

        // A failed durable write leaves the same picker retryable. Restoring
        // the store and pressing Enter again completes the original request.
        chmodSync(dirname(configPath), 0o700);
        configDirectoryLocked = false;
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("1. Worker");
        expect(pane).toContain("Subagent models");
        expect(pane).toContain("⏎ remove");
        expect(pane).not.toContain("Connected models");
        expect(pane).toContain("Worker");
        expect(adapterCount).toBe(1);
        expect(childModelCalls).toBe(0);
        expect(registry?.list()).toHaveLength(1);
        expect(loadVeraConfig({ path: configPath }).model_assignments?.subagents)
            .toMatchObject({
                models: [{ provider: "ollama", model: "worker" }],
            });
        expect(loadVeraConfig({ path: configPath })
            .model_assignments?.subagents?.models?.[0]?.reasoning_effort)
            .toBeUndefined();

        // Saving only updates configuration. Leaving the destination advances
        // to the distinct launch confirmation.
        session.sendKey("Escape");
        pane = await session.waitForVisiblePane("Continue 2 waiting subagent launches?");
        expect(pane).toContain("composer-2→ollama/worker");
        expect(pane).toContain("composer-3→ollama/worker");
        expect(pane).toContain("1. Continue");
        expect(pane).toContain("2. Cancel");
        expect(adapterCount).toBe(1);
        expect(childModelCalls).toBe(0);
        expect(registry?.list()).toHaveLength(1);

        session.sendText("1");
        await session.waitForVisiblePane("Both launches handled.");
        await waitFor(() => childModelCalls === 2, "two child model calls");

        const children = registry?.list().filter((agent) =>
            agent.parent_id === "parent") ?? [];
        expect(children).toHaveLength(2);
        expect(adapterCount).toBe(3);
        for (const child of children) {
            const store = await SessionStore.open(child.session_path);
            expect(store.modelSettings()).toEqual({
                provider: "ollama",
                model: "worker",
            });
            expect(store.header.delegation).toEqual({
                kind: "subagent",
                parentId: "parent",
                models: [{ provider: "ollama", model: "worker" }],
            });
        }
    } finally {
        if (configDirectoryLocked) {
            chmodSync(dirname(configPath), 0o700);
        }
        await session.close();
        await registry?.close();
        if (previousPoolPath === undefined) {
            delete process.env.VERA_POOL_FILE;
        } else {
            process.env.VERA_POOL_FILE = previousPoolPath;
        }
    }
}, 30_000);

test("assigning a model outside the pool adds it to favorites and the subagent runs on it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-subagent-pool-"));
    const workspace = join(home, "workspace");
    const sessionDirectory = join(home, "sessions");
    const poolPath = join(home, ".vera", "pool.json");
    const previousPoolPath = process.env.VERA_POOL_FILE;
    process.env.VERA_POOL_FILE = poolPath;
    const availableModels: readonly SuggestedModel[] = [
        { provider: "faux", model: "test", label: "Parent", description: "scripted parent model" },
        { provider: "ollama", model: "worker", label: "Worker", description: "favorite" },
        { provider: "ollama", model: "corvid", label: "Corvid", description: "connected, not a favorite" },
    ];
    let adapterCount = 0;
    let childModelCalls = 0;
    let registry: AgentRegistry | undefined;
    let configPath = "";

    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 35,
        dependencies: async () => {
            await Bun.write(join(workspace, ".keep"), "");
            addPoolModel("ollama/worker", { added: true }, { path: poolPath });
            configPath = defaultVeraConfigPath();
            registry = new AgentRegistry({
                createAdapter(): ModelAdapter {
                    adapterCount += 1;
                    const child = adapterCount > 1;
                    const delegate = new FauxAdapter(child
                        ? [textResponse("Plunder logged.", "corvid")]
                        : [
                            {
                                role: "assistant",
                                content: [{
                                    type: "tool_call",
                                    id: "spawn-one",
                                    name: "async_subagent",
                                    input: { description: "count the shiny loot" },
                                }],
                                source: { provider: "faux", api: "scripted", model: "test" },
                                usage: emptyUsage(),
                                stopReason: "tool_use",
                            },
                            textResponse("Launch handled.", "test"),
                        ]);
                    return {
                        stream(request) {
                            if (child) childModelCalls += 1;
                            return delegate.stream(request);
                        },
                    };
                },
                provider: "faux",
                model: "test",
                approvalMode: "auto",
                availableModels,
                readPool: () => pooledModels(availableModels, { userPath: poolPath }),
                readPolicy: () => subagentPoolPolicy({ userPath: poolPath, configPath }),
                sessionPathForId: (id) => join(sessionDirectory, `${id}.jsonl`),
            });
            const parent = await registry.create({
                id: "parent",
                workspace,
                sessionPath: join(sessionDirectory, "parent.jsonl"),
            });
            const attachment = parent.attach();
            const client: TuiAgentClient = {
                agentId: parent.id,
                workspace: parent.workspace,
                async send(command) {
                    attachment.send(command);
                },
                receive(signal) {
                    return attachment.receive(signal);
                },
                async detach() {
                    attachment.detach();
                },
                close() {
                    attachment.detach();
                },
            };
            return {
                client,
                operateModels: async (operation, onResult) => {
                    await applyModelOperation(operation, {
                        path: poolPath,
                        discovered: availableModels,
                        assignments: [],
                        createAdapter: () => { throw new Error("keep does not call a provider"); },
                        onResult,
                    });
                    return undefined;
                },
            };
        },
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("delegate the loot count");
        session.sendKey("Enter");

        let pane = await session.waitForVisiblePane("Subagent models");
        expect(pane).toMatch(/Worker[^\n]*favorite/);
        expect(pane.indexOf("Worker")).toBeLessThan(pane.indexOf("Corvid"));

        session.sendText("corvid");
        await session.waitForVisiblePaneWhere(
            (frame) => !frame.includes("Worker"),
            "the search to leave only Corvid",
        );
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("1. Corvid");
        await waitFor(
            () => loadPoolFile({ userPath: poolPath }).merged.models["ollama/corvid"]?.added === true,
            "Corvid to join the pool",
        );

        session.sendKey("Escape");
        pane = await session.waitForVisiblePane("Continue 1 waiting subagent launch");
        session.sendText("1");
        await session.waitForVisiblePane("Launch handled.");
        await waitFor(() => childModelCalls === 1, "the child model call");

        const children = registry?.list().filter((agent) =>
            agent.parent_id === "parent") ?? [];
        expect(children).toHaveLength(1);
        const store = await SessionStore.open(children[0]!.session_path);
        expect(store.modelSettings()).toEqual({ provider: "ollama", model: "corvid" });
    } finally {
        await session.close();
        await registry?.close();
        if (previousPoolPath === undefined) {
            delete process.env.VERA_POOL_FILE;
        } else {
            process.env.VERA_POOL_FILE = previousPoolPath;
        }
    }
}, 30_000);

test("assigning eco a model outside the pool lets explorer run on it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-eco-pool-"));
    const workspace = join(home, "workspace");
    const sessionDirectory = join(home, "sessions");
    const poolPath = join(home, ".vera", "pool.json");
    const previousPoolPath = process.env.VERA_POOL_FILE;
    process.env.VERA_POOL_FILE = poolPath;
    const availableModels: readonly SuggestedModel[] = [
        { provider: "faux", model: "test", label: "Parent", description: "scripted parent model" },
        { provider: "ollama", model: "corvid", label: "Corvid", description: "connected, not a favorite" },
    ];
    const extensions = await startExtensionRegistry({
        extensions: includedExtensionConfigs([]).filter((config) =>
            loadExtensionManifest(config.path).manifest.id === "vera.explorer"),
    });
    let adapterCount = 0;
    const childRequests: ModelRequest[] = [];
    let registry: AgentRegistry | undefined;
    let configPath = "";

    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 35,
        dependencies: async () => {
            await Bun.write(join(workspace, ".keep"), "");
            configPath = defaultVeraConfigPath();
            registry = new AgentRegistry({
                createAdapter(): ModelAdapter {
                    adapterCount += 1;
                    const child = adapterCount > 1;
                    const delegate = new FauxAdapter(child
                        ? [textResponse("The hoard is under the third plank.", "corvid")]
                        : [
                            {
                                role: "assistant",
                                content: [{
                                    type: "tool_call",
                                    id: "spawn-explorer",
                                    name: "subagent",
                                    input: { agent: "explorer", description: "find where the hoard is buried" },
                                }],
                                source: { provider: "faux", api: "scripted", model: "test" },
                                usage: emptyUsage(),
                                stopReason: "tool_use",
                            },
                            textResponse("Explorer reported back.", "test"),
                        ]);
                    return {
                        stream(request) {
                            if (child) childRequests.push(request);
                            return delegate.stream(request);
                        },
                    };
                },
                provider: "faux",
                model: "test",
                approvalMode: "auto",
                availableModels,
                registeredAgents: extensions.agents(),
                readPool: () => pooledModels(availableModels, { userPath: poolPath }),
                readPolicy: () => ({
                    ...subagentPoolPolicy({ userPath: poolPath, configPath }),
                    candidates: pooledModels(availableModels, { userPath: poolPath, includeUncurated: true }),
                }),
                sessionPathForId: (id) => join(sessionDirectory, `${id}.jsonl`),
            });
            const parent = await registry.create({
                id: "parent",
                workspace,
                sessionPath: join(sessionDirectory, "parent.jsonl"),
            });
            const attachment = parent.attach();
            const client: TuiAgentClient = {
                agentId: parent.id,
                workspace: parent.workspace,
                async send(command) {
                    attachment.send(command);
                },
                receive(signal) {
                    return attachment.receive(signal);
                },
                async detach() {
                    attachment.detach();
                },
                close() {
                    attachment.detach();
                },
            };
            return {
                client,
                operateModels: async (operation, onResult) => {
                    await applyModelOperation(operation, {
                        path: poolPath,
                        discovered: availableModels,
                        assignments: [],
                        createAdapter: () => { throw new Error("keep does not call a provider"); },
                        onResult,
                    });
                    return undefined;
                },
            };
        },
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("assign model defaults");
        await session.waitForVisiblePane("Assign model defaults");
        session.sendKey("Enter");
        await session.waitForVisiblePane("unset, inherits its intent");
        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Corvid");
        session.sendText("corvid");
        session.sendKey("Enter");
        await waitFor(
            () => loadPoolFile({ userPath: poolPath }).merged.models["ollama/corvid"]?.added === true,
            "Corvid to join the pool",
        );
        let pane = await session.waitForVisiblePane("eco → corvid");
        expect(pane).toContain("Adding corvid to favorites");

        session.sendText("find the hoard");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Explorer reported back.");
        expect(pane).not.toContain("is not in the pool");
        expect(childRequests).toHaveLength(1);
        expect([childRequests[0]!.provider, childRequests[0]!.model]).toEqual(["ollama", "corvid"]);
        expect(childRequests[0]!.systemPrompt).toContain("Investigate the assigned question");
    } finally {
        await session.close();
        await registry?.close();
        await extensions.close();
        if (previousPoolPath === undefined) {
            delete process.env.VERA_POOL_FILE;
        } else {
            process.env.VERA_POOL_FILE = previousPoolPath;
        }
    }
}, 30_000);

function textResponse(text: string, model: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function waitFor(
    predicate: () => boolean,
    description: string,
): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await Bun.sleep(20);
    }
    throw new Error(`Timed out waiting for ${description}`);
}

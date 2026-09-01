import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import {
    defaultVeraConfigPath,
    loadVeraConfig,
} from "../../../src/config.ts";
import { AgentRegistry } from "../../../src/host/agent-registry.ts";
import { subagentPoolPolicy } from "../../../src/host/subagent-policy.ts";
import { pooledModels } from "../../../src/model/catalog-view.ts";
import { addPoolModel } from "../../../src/model/pool-file-store.ts";
import type { SuggestedModel } from "../../../src/model/supported-models.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
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
            description: "shortlisted subagent model",
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
        expect(pane).toContain("Available from Shortlist");
        expect(pane).toContain("Worker");
        expect(pane).toContain("Parent model fallback");
        expect(pane).toContain("test");
        expect(adapterCount).toBe(1);
        expect(childModelCalls).toBe(0);
        expect(registry?.list()).toHaveLength(1);

        // Not set opens selected; p assigns the shortlisted worker without
        // dismissing the policy pane.
        session.sendKey("Down");
        chmodSync(dirname(configPath), 0o500);
        configDirectoryLocked = true;
        session.sendText("p");
        pane = await session.waitForVisiblePane("Could not write the assignment");
        expect(pane).toContain("Subagent models");
        expect(pane).toContain("Not set");
        expect(existsSync(configPath)).toBe(false);

        // A failed durable write leaves the same picker retryable. Restoring
        // the store and pressing p again completes the original request.
        chmodSync(dirname(configPath), 0o700);
        configDirectoryLocked = false;
        session.sendText("p");
        pane = await session.waitForVisiblePane("1. Worker");
        expect(pane).toContain("Subagent models");
        expect(pane).not.toContain("Not set");
        expect(pane).toContain("p remove");
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

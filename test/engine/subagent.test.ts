import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createSubagentEffectApplier as createStrictSubagentEffectApplier,
    resolveSpawnModelChoice,
    runSubagent,
} from "../../src/engine/subagent.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import {
    createProtocolEncoder,
    type ToolApprovalUiRequestUpdate,
} from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelInputMessage,
    type ModelMessage,
    type ModelRequest,
} from "../../src/model/types.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";
import {
    withoutCallDuration,
    withoutSessionUsage,
} from "../support/wire-usage.ts";

function createSubagentEffectApplier(
    options: Parameters<typeof createStrictSubagentEffectApplier>[0],
): ReturnType<typeof createStrictSubagentEffectApplier> {
    return createStrictSubagentEffectApplier({
        ...options,
        readPolicy: options.readPolicy ?? (() => ({
            assigned: (options.readPool?.() ?? []).map((entry) => ({
                provider: entry.provider,
                model: entry.model,
            })),
            allowSelf: true,
        })),
    });
}

test("two real subagent effects overlap and create separate sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-siblings-"));
    const sessionPaths: string[] = [];
    const childRequests: ModelRequest[] = [];
    let activeChildren = 0;
    let maximumActiveChildren = 0;
    const adapter: ModelAdapter = {
        stream(request) {
            childRequests.push(request);
            const prompt = firstText(request.messages[0]);
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            activeChildren += 1;
            maximumActiveChildren = Math.max(
                maximumActiveChildren,
                activeChildren,
            );
            void (async () => {
                await Bun.sleep(prompt.startsWith("slow") ? 30 : 5);
                activeChildren -= 1;
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: `${prompt} result` }],
                        source: {
                            provider: "faux",
                            api: "concurrent",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                });
            })();
            return stream;
        },
    };
    const applyEffect = createSubagentEffectApplier({
        adapter,
        workspace: root,
        sessionPathForId(id) {
            const path = join(root, `${id}.jsonl`);
            sessionPaths.push(path);
            return path;
        },
    });
    const signal = new AbortController().signal;

    try {
        const results = await Promise.all([
            applyEffect({
                type: "spawn_subagent",
                description: "slow child",
            }, signal, {
                approvalMode: "auto",
                model: "test",
            }),
            applyEffect({
                type: "spawn_subagent",
                description: "fast child",
            }, signal, {
                approvalMode: "auto",
                model: "test",
            }),
        ]);

        expect(maximumActiveChildren).toBe(2);
        expect(results.map((result) => result.output)).toEqual([
            "slow child result",
            "fast child result",
        ]);
        expect(sessionPaths).toHaveLength(2);
        const childPrompts: string[] = [];
        for (const path of sessionPaths) {
            const messages = (await SessionStore.open(path)).messages();
            childPrompts.push(firstText(messages[0]));
        }
        expect(childPrompts.sort()).toEqual(["fast child", "slow child"]);
        for (const request of childRequests) {
            expect(request.tools?.map((tool) => tool.name)).not.toContain(
                "subagent",
            );
            expect(request.tools?.map((tool) => tool.name)).not.toContain(
                "async_subagent",
            );
            expect(request.tools?.map((tool) => tool.name)).not.toContain(
                "ask_user",
            );
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a child's boundary crossing goes to the auto reviewer, not the relay", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-review-"));
    // `env` is harmless to run and genuinely unclassified, so in auto mode it
    // routes to review rather than being statically allowed.
    const crossing: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_1",
            name: "bash",
            input: { command: "env" },
        }],
        source: { provider: "faux", api: "scripted", model: "child-model" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const done: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "child done" }],
        source: { provider: "faux", api: "scripted", model: "child-model" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const requests: ModelRequest[] = [];
    let childCalls = 0;
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            if (request.model === "reviewer-model") {
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: '{"outcome":"allow"}' }],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: "reviewer-model",
                        },
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                });
            } else {
                childCalls += 1;
                stream.push({
                    type: "done",
                    message: childCalls === 1 ? crossing : done,
                });
            }
            return stream;
        },
    };
    let relayed = 0;

    try {
        const result = await runSubagent({
            adapter,
            model: "child-model",
            description: "inspect the environment",
            workspace: root,
            approvalMode: "auto",
            sessionPath: join(root, "child.jsonl"),
            sessionMetadata: { contextAssemblyMode: "bare" },
            reviewer: { models: [{ model: "reviewer-model" }] },
            relayToolApproval: async () => {
                relayed += 1;
                return "deny";
            },
        });

        expect(result.isError).toBe(false);
        // The review happened on the configured reviewer model, and the
        // action never fell back to the parent-relayed approval prompt.
        expect(relayed).toBe(0);
        const review = requests.find((next) => next.model === "reviewer-model");
        expect(review?.systemPrompt).toContain(
            "You review one proposed action",
        );
        // The allow let the command actually run: the child's next request
        // carries a real tool result, not a denial.
        const followUp = requests.filter((next) =>
            next.model === "child-model"
        ).at(-1);
        const toolResult = followUp?.messages.find((message) =>
            message.role === "tool_result"
        );
        expect(toolResult).toBeDefined();
        expect(JSON.stringify(toolResult)).toContain("PATH=");
        expect((await SessionStore.open(join(root, "child.jsonl"))).header)
            .toMatchObject({ contextAssemblyMode: "bare" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("without reviewer settings a child reviews on its own model", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-self-review-"));
    const crossing: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_1",
            name: "bash",
            input: { command: "env" },
        }],
        source: { provider: "faux", api: "scripted", model: "child-model" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const done: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "child done" }],
        source: { provider: "faux", api: "scripted", model: "child-model" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const reviewerModels: string[] = [];
    let childCalls = 0;
    const adapter: ModelAdapter = {
        stream(request) {
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            if (
                request.systemPrompt?.includes("You review one proposed action")
            ) {
                reviewerModels.push(request.model);
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: '{"outcome":"allow"}' }],
                        source: {
                            provider: "faux",
                            api: "scripted",
                            model: request.model,
                        },
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                });
            } else {
                childCalls += 1;
                stream.push({
                    type: "done",
                    message: childCalls === 1 ? crossing : done,
                });
            }
            return stream;
        },
    };

    try {
        const result = await runSubagent({
            adapter,
            model: "child-model",
            description: "inspect the environment",
            workspace: root,
            approvalMode: "auto",
            sessionPath: join(root, "child.jsonl"),
        });

        expect(result.isError).toBe(false);
        // Mirrors the parent's fallback: no configured reviewer means the
        // review runs on the child's own model, not nothing.
        expect(reviewerModels).toEqual(["child-model"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("subagent inherits the parent turn model and reasoning", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-model-"));
    const final: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "child done" }],
        source: { provider: "faux", api: "scripted", model: "selected" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([final]);
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(nextRequest) {
            request = nextRequest;
            return faux.stream(nextRequest);
        },
    };
    const applyEffect = createSubagentEffectApplier({
        adapter,
        workspace: root,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
    });

    try {
        const result = await applyEffect({
            type: "spawn_subagent",
            description: "use the selected model",
        }, new AbortController().signal, {
            approvalMode: "auto",
            model: "selected",
            reasoningEffort: "high",
        });

        expect(request?.model).toBe("selected");
        expect(request?.reasoningEffort).toBe("high");
        expect(result.isError).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a pooled model override replaces the parent settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-override-"));
    const final: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "child done" }],
        source: { provider: "pin-provider", api: "scripted", model: "small-model" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([final]);
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(nextRequest) {
            request = nextRequest;
            return faux.stream(nextRequest);
        },
    };
    const applyEffect = createSubagentEffectApplier({
        adapter,
        workspace: root,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        readPool: () => [{
            provider: "pin-provider",
            model: "small-model",
            label: "Small",
            available: true,
            verified: true,
            levels: [{ id: "low", label: "Low" }],
        }],
    });

    try {
        const result = await applyEffect({
            type: "spawn_subagent",
            description: "use the override",
            model: "small-model",
            reasoningEffort: "low",
        }, new AbortController().signal, {
            approvalMode: "auto",
            provider: "parent-provider",
            model: "selected",
            reasoningEffort: "high",
        });

        expect(request?.model).toBe("small-model");
        expect(request?.provider).toBe("pin-provider");
        expect(request?.reasoningEffort).toBe("low");
        expect(result.isError).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a spawn with no override runs the configured subagent default", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-default-"));
    const final: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "child done" }],
        source: { provider: "cheap-provider", api: "scripted", model: "cheap-model" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([final]);
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(nextRequest) {
            request = nextRequest;
            return faux.stream(nextRequest);
        },
    };
    const applyEffect = createSubagentEffectApplier({
        adapter,
        workspace: root,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        subagentModel: {
            provider: "cheap-provider",
            model: "cheap-model",
            reasoningEffort: "medium",
        },
        readPool: () => [{
            provider: "cheap-provider", model: "cheap-model", label: "cheap",
            available: true, verified: true,
            levels: [{ id: "medium", label: "Medium" }],
        }],
    });

    try {
        const result = await applyEffect({
            type: "spawn_subagent",
            description: "run on the default",
        }, new AbortController().signal, {
            approvalMode: "auto",
            provider: "parent-provider",
            model: "expensive-model",
            reasoningEffort: "max",
        });

        expect(request?.model).toBe("cheap-model");
        expect(request?.provider).toBe("cheap-provider");
        expect(request?.reasoningEffort).toBe("medium");
        expect(result.isError).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an unpooled model override is refused before a child starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-unpooled-"));
    const final: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "child done" }],
        source: { provider: "faux", api: "scripted", model: "selected" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([final]);
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(nextRequest) {
            request = nextRequest;
            return faux.stream(nextRequest);
        },
    };
    const applyEffect = createSubagentEffectApplier({
        adapter,
        workspace: root,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        readPool: () => [{
            provider: "pin-provider",
            model: "small-model",
            label: "Small",
            available: true,
            verified: true,
            levels: [],
        }],
    });

    try {
        const result = await applyEffect({
            type: "spawn_subagent",
            description: "use a made-up model",
            model: "haiku",
        }, new AbortController().signal, {
            approvalMode: "auto",
            model: "selected",
        });

        expect(result.isError).toBe(true);
        expect(request).toBeUndefined();
        expect(result.output).toContain("not permitted for subagents");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an unavailable pool entry falls through like an unpooled model", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-unverified-"));
    const final: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "child done" }],
        source: { provider: "faux", api: "scripted", model: "selected" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([final]);
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(nextRequest) {
            request = nextRequest;
            return faux.stream(nextRequest);
        },
    };
    const applyEffect = createSubagentEffectApplier({
        adapter,
        workspace: root,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        readPool: () => [{
            provider: "pin-provider",
            model: "small-model",
            label: "Small",
            available: false,
            verified: false,
            levels: [],
        }],
    });

    try {
        const result = await applyEffect({
            type: "spawn_subagent",
            description: "use an unverified model",
            model: "small-model",
        }, new AbortController().signal, {
            approvalMode: "auto",
            model: "selected",
        });

        expect(result.isError).toBe(false);
        expect(request?.model).toBe("selected");
        expect(result.output).toContain("parent-model fallback is enabled");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("subagent tool approvals relay to the parent owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-approval-"));
    const outside = `${root}-outside.txt`;
    const toolCall: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "outside-write",
            name: "bash",
            input: { command: `printf child > ${outside}` },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const final: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "child done" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const relayed: ToolApprovalUiRequestUpdate[] = [];

    try {
        const result = await runSubagent({
            adapter: new FauxAdapter([toolCall, final]),
            model: "test",
            description: "write the child marker",
            workspace: root,
            approvalMode: "ask",
            sessionPath: join(root, "child.jsonl"),
            relayToolApproval(update, sourceAgentId, sourceTask) {
                relayed.push(update);
                expect(sourceAgentId).toBeString();
                expect(sourceTask).toBe("write the child marker");
                return Promise.resolve("allow_once");
            },
        });

        expect(result).toMatchObject({ text: "child done", isError: false });
        expect(relayed).toHaveLength(1);
        expect(relayed[0]?.request.toolCall).toEqual({
            id: "outside-write",
            name: "bash",
            input: { command: `printf child > ${outside}` },
        });
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { force: true });
    }
});

test("subagent concurrency has an explicit defaultable cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-limit-"));
    const applyEffect = createSubagentEffectApplier({
        adapter: new FauxAdapter([
            {
                role: "assistant",
                content: [{ type: "text", text: "first done" }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        ], { delayMs: 30 }),
        workspace: root,
        maxConcurrentChildren: 1,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
    });
    const context = { approvalMode: "auto" as const, model: "test" };
    const signal = new AbortController().signal;

    try {
        const first = applyEffect({
            type: "spawn_subagent",
            description: "first",
        }, signal, context);
        const second = await applyEffect({
            type: "spawn_subagent",
            description: "second",
        }, signal, context);

        expect(second).toEqual({
            kind: "output",
            output: "Subagent limit reached (1 running).",
            isError: true,
        });
        expect((await first).isError).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("aborting a subagent cancels its relayed approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-approval-abort-"));
    const outside = `${root}-outside.txt`;
    const controller = new AbortController();
    let markApprovalStarted: (() => void) | undefined;
    const approvalStarted = new Promise<void>((resolve) => {
        markApprovalStarted = resolve;
    });
    const applyEffect = createSubagentEffectApplier({
        adapter: new FauxAdapter([{
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "waiting-write",
                name: "bash",
                input: { command: `printf child > ${outside}` },
            }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        }]),
        workspace: root,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        relayToolApproval(_update, _sourceAgentId, _sourceTask, signal) {
            markApprovalStarted?.();
            return new Promise((resolve) => {
                signal.addEventListener(
                    "abort",
                    () => resolve("deny"),
                    { once: true },
                );
            });
        },
    });

    try {
        const running = applyEffect({
            type: "spawn_subagent",
            description: "wait for approval",
        }, controller.signal, {
            approvalMode: "ask",
            model: "test",
        });
        await approvalStarted;
        controller.abort();
        expect(await Promise.race([
            running.then(
                () => "settled",
                () => "settled",
            ),
            Bun.sleep(200).then(() => "timed out"),
        ])).toBe("settled");
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { force: true });
    }
});

function firstText(message: ModelInputMessage | undefined): string {
    const block = message?.content[0];
    return block?.type === "text" ? block.text : "";
}

test("parent receives the real child final text as its tool result", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-parent-"));
    let childSessionPath: string | undefined;
    const parentToolCall: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_child",
            name: "subagent",
            input: { description: "Trace the request path" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const childFinal: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "The socket reaches the registry." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const parentFinal: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "The child traced it." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const adapter = new FauxAdapter([parentToolCall, childFinal, parentFinal]);
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(root),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "full_access",
        enabledToolEffects: ["spawn_subagent"],
        applyToolEffect: createSubagentEffectApplier({
            adapter,
            workspace: root,
            sessionPathForId(id) {
                childSessionPath = join(root, `${id}.jsonl`);
                return childSessionPath;
            },
        }),
    };

    try {
        channel.client.send({ type: "prompt", content: "Delegate this" });
        const turn = runTurn(adapter, "test", state);
        while ((await channel.client.receive()).type !== "turn_finished") {
            // Drain the parent updates while both loops run.
        }

        expect(withoutCallDuration(await turn)).toEqual(parentFinal);
        const toolResult = state.messages.find(
            (message) => message.role === "tool_result",
        );
        expect(toolResult?.content[0]?.text).toBe(
            "The socket reaches the registry.",
        );
        expect(childSessionPath).toBeString();
        const childMessages = (await SessionStore.open(childSessionPath!))
            .messages();
        expect(childMessages.map(withoutCallDuration)).toEqual([
            {
                role: "user",
                content: [{ type: "text", text: "Trace the request path" }],
            },
            childFinal,
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a failed child model request returns an error tool result", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-error-"));
    const applyEffect = createSubagentEffectApplier({
        adapter: new FauxAdapter([]),
        workspace: root,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
    });

    try {
        const result = await applyEffect({
            type: "spawn_subagent",
            description: "fail before responding",
        }, new AbortController().signal, {
            approvalMode: "auto",
            model: "test",
        });

        expect(result).toEqual({
            kind: "output",
            output: "Faux adapter has no scripted response left",
            isError: true,
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("subagent effects inherit the parent turn permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-permissions-"));
    const sessionPath = join(root, "child.jsonl");
    const toolCall: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "child-pwd",
            name: "bash",
            input: { command: "pwd" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const final: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "child done" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const applyEffect = createSubagentEffectApplier({
        adapter: new FauxAdapter([toolCall, final]),
        workspace: root,
        sessionPathForId: () => sessionPath,
    });

    try {
        await applyEffect({
            type: "spawn_subagent",
            description: "report the workspace",
        }, new AbortController().signal, {
            approvalMode: "full_access",
            model: "test",
        });

        const childStore = await SessionStore.open(sessionPath);
        expect(childStore.approvalMode()).toBe("full_access");
        const result = childStore.messages().find(
            (message) => message.role === "tool_result",
        );
        expect(result).toMatchObject({
            role: "tool_result",
            toolName: "bash",
            isError: false,
        });
        expect(result?.content[0]?.text).toContain(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("subagent uses fresh context, ordinary tools, and a durable session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-"));
    const sessionPath = join(root, "child.jsonl");
    const response: AssistantMessage = {
        role: "assistant",
        content: [
            { type: "thinking", text: "private working" },
            { type: "text", text: "The request enters through the socket." },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([response]);
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(nextRequest) {
            request = nextRequest;
            return faux.stream(nextRequest);
        },
    };

    try {
        const result = await runSubagent({
            adapter,
            model: "test",
            description: "Trace the request path",
            workspace: root,
            approvalMode: "auto",
            sessionId: "child-1",
            sessionPath,
        });

        expect(result).toEqual({
            text: "The request enters through the socket.",
            isError: false,
            sessionId: "child-1",
            sessionPath,
        });
        expect(request?.messages).toEqual([{
            role: "user",
            content: [{ type: "text", text: "Trace the request path" }],
        }]);
        expect(request?.tools?.map((tool) => tool.name)).not.toContain(
            "subagent",
        );
        expect(
            (await SessionStore.open(sessionPath)).messages()
                .map(withoutCallDuration),
        ).toEqual([
            {
                role: "user",
                content: [{ type: "text", text: "Trace the request path" }],
            },
            response,
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an immediate parent abort stops before the child model call", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-early-abort-"));
    const controller = new AbortController();
    const final: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "should not run" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([final]);
    let modelCalls = 0;
    const adapter: ModelAdapter = {
        stream(request) {
            modelCalls += 1;
            return faux.stream(request);
        },
    };

    try {
        const child = runSubagent({
            adapter,
            model: "test",
            description: "do not start",
            workspace: root,
            approvalMode: "auto",
            sessionId: "child-early-abort",
            sessionPath: join(root, "child.jsonl"),
            signal: controller.signal,
        });
        controller.abort(new Error("Parent turn aborted immediately"));

        await expect(child).rejects.toThrow("Parent turn aborted immediately");
        expect(modelCalls).toBe(0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("aborting the parent signal cancels the child turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-"));
    const sessionPath = join(root, "aborted-child.jsonl");
    const controller = new AbortController();
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "this should not finish" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([response], { chunkSize: 1, delayMs: 20 });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const adapter: ModelAdapter = {
        stream(request) {
            markStarted?.();
            return faux.stream(request);
        },
    };

    try {
        const child = runSubagent({
            adapter,
            model: "test",
            description: "Work until cancelled",
            workspace: root,
            approvalMode: "auto",
            sessionId: "child-abort",
            sessionPath,
            signal: controller.signal,
        });
        await started;
        controller.abort(new Error("Parent turn aborted"));

        await expect(child).rejects.toThrow("Parent turn aborted");
        const messages = (await SessionStore.open(sessionPath)).messages();
        expect(messages.at(-1)).toMatchObject({
            role: "assistant",
            stopReason: "aborted",
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a subagent inherits the parent's scratch directory in its prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-scratch-"));
    const childRequests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            childRequests.push(request);
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            stream.push({
                type: "done",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    source: { provider: "faux", api: "test", model: "test" },
                    usage: emptyUsage(),
                    stopReason: "stop",
                },
            });
            return stream;
        },
    };
    const applyEffect = createSubagentEffectApplier({
        adapter,
        workspace: root,
        scratchDir: "/tmp/vera/parent-session",
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
    });

    try {
        await applyEffect({
            type: "spawn_subagent",
            description: "child task",
        }, new AbortController().signal, {
            approvalMode: "auto",
            model: "test",
        });

        expect(childRequests[0]?.systemPrompt).toContain(
            "/tmp/vera/parent-session",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a subagent loads contextual contributions with its own wear and workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-context-"));
    let context: unknown;
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(next) {
            request = next;
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            stream.push({
                type: "done",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    source: { provider: "faux", api: "test", model: "test" },
                    usage: emptyUsage(),
                    stopReason: "stop",
                },
            });
            return stream;
        },
    };

    try {
        await runSubagent({
            adapter,
            model: "test",
            description: "child task",
            workspace: root,
            approvalMode: "auto",
            agentWear: {
                name: "explore",
                instructions: "Explore the code.",
            },
            loadContextualContributions: async (
                _instructionRoot,
                _skills,
                next,
            ) => {
                context = next;
                return [{
                    id: "host.standing-instructions",
                    owner: "host",
                    target: "contextual",
                    title: "Standing instructions",
                    content: "[explore-child]\nExplore carefully.",
                }];
            },
        });

        expect(context).toEqual({
            sessionId: expect.any(String),
            turn: "user",
            workspace: root,
            agent: "explore",
        });
        expect(request?.systemPrompt).toContain("[explore-child]");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the pool file's subagent default is the rung a spawn with no suggestion lands on", () => {
    const resolved = resolveSpawnModelChoice(
        {},
        { approvalMode: "auto", provider: "openrouter", model: "session" },
        () => [{
            provider: "openrouter", model: "worker", label: "worker",
            available: true, verified: true, levels: [],
        }],
        undefined,
        {
            assigned: [{ provider: "openrouter", model: "worker" }],
            subagentDefault: "openrouter/worker",
        },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.model).toBe("worker");
    expect(resolved.notice).toBeUndefined();
});

test("a model with no reasoning control drops the requested effort", () => {
    const resolved = resolveSpawnModelChoice(
        { model: "openrouter/worker", reasoningEffort: "high" },
        { approvalMode: "auto", provider: "openrouter", model: "session" },
        () => [{
            provider: "openrouter", model: "worker", label: "worker",
            available: true, verified: true, levels: [],
        }],
        undefined,
        { assigned: [{ provider: "openrouter", model: "worker" }] },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.model).toBe("worker");
    expect(resolved.reasoningEffort).toBeUndefined();
    expect(resolved.notice).toContain("does not offer that level");
});

test("an out-of-policy spawn carries no substitution because it is refused", () => {
    const resolved = resolveSpawnModelChoice(
        { model: "openrouter/absent" },
        { approvalMode: "auto", provider: "openrouter", model: "session" },
        () => [],
        undefined,
        { allowSelf: true },
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("not permitted for subagents");
});

test("an empty strict policy is a typed configuration requirement", () => {
    const resolved = resolveSpawnModelChoice(
        { model: "requested-worker" },
        { approvalMode: "auto", provider: "openrouter", model: "parent" },
        () => [],
        undefined,
        {},
    );
    expect(resolved).toEqual({
        ok: false,
        reason: "configuration_required",
        error: "No subagent models are configured. Choose models in Defaults -> Subagents.",
    });
});

test("a sync spawn waits for configuration and persists the refreshed boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-configure-sync-"));
    const context = {
        sessionId: "parent-session",
        approvalMode: "auto" as const,
        provider: "faux",
        model: "parent",
    };
    const pool = [{
        provider: "faux",
        model: "worker",
        label: "Worker",
        available: true,
        verified: true,
        levels: [],
    }] as const;
    let policy: Parameters<typeof resolveSpawnModelChoice>[4] = {};
    let modelCalls = 0;
    let childPath = "";
    let continueConfiguration: (() => void) | undefined;
    const configured = new Promise<void>((resolve) => {
        continueConfiguration = resolve;
    });
    const apply = createStrictSubagentEffectApplier({
        adapter: {
            stream(request) {
                modelCalls += 1;
                return new FauxAdapter([{
                    role: "assistant",
                    content: [{ type: "text", text: "child done" }],
                    source: {
                        provider: "faux",
                        api: "scripted",
                        model: "worker",
                    },
                    usage: emptyUsage(),
                    stopReason: "stop",
                }])
                    .stream(request);
            },
        },
        workspace: root,
        sessionPathForId: (id) => {
            childPath = join(root, `${id}.jsonl`);
            return childPath;
        },
        readPool: () => pool,
        readPolicy: () => policy ?? {},
        async requestMissingConfiguration() {
            await configured;
            return resolveSpawnModelChoice(
                {},
                context,
                () => pool,
                undefined,
                policy,
            );
        },
    });
    try {
        const pending = apply({
            type: "spawn_subagent",
            description: "configured child",
            model: "composer-2",
        }, new AbortController().signal, context);
        await Bun.sleep(0);
        expect(modelCalls).toBe(0);
        policy = { assigned: [{ provider: "faux", model: "worker" }] };
        continueConfiguration?.();
        const result = await pending;
        expect(result.isError).toBe(false);
        expect(modelCalls).toBe(1);
        const child = await SessionStore.open(childPath);
        expect(child.header.delegation).toEqual({
            kind: "subagent",
            parentId: "parent-session",
            models: [{ provider: "faux", model: "worker" }],
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("configured sync siblings recheck concurrency after waiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-configure-limit-"));
    const context = {
        sessionId: "parent-session",
        approvalMode: "auto" as const,
        provider: "faux",
        model: "parent",
    };
    const pool = [{
        provider: "faux",
        model: "worker",
        label: "Worker",
        available: true,
        verified: true,
        levels: [],
    }] as const;
    let policy: Parameters<typeof resolveSpawnModelChoice>[4] = {};
    const waiters: Array<(resolution: ReturnType<
        typeof resolveSpawnModelChoice
    >) => void> = [];
    let modelCalls = 0;
    const apply = createStrictSubagentEffectApplier({
        adapter: {
            stream(request) {
                modelCalls += 1;
                return new FauxAdapter([{
                    role: "assistant",
                    content: [{ type: "text", text: "child done" }],
                    source: {
                        provider: "faux",
                        api: "scripted",
                        model: "worker",
                    },
                    usage: emptyUsage(),
                    stopReason: "stop",
                }], { delayMs: 30 }).stream(request);
            },
        },
        workspace: root,
        maxConcurrentChildren: 1,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        readPool: () => pool,
        readPolicy: () => policy ?? {},
        requestMissingConfiguration() {
            return new Promise((resolve) => waiters.push(resolve));
        },
    });
    try {
        const signal = new AbortController().signal;
        const first = apply({
            type: "spawn_subagent",
            description: "first configured child",
        }, signal, context);
        const second = apply({
            type: "spawn_subagent",
            description: "second configured child",
        }, signal, context);
        while (waiters.length < 2) await Bun.sleep(0);
        policy = { assigned: [{ provider: "faux", model: "worker" }] };
        const resolution = resolveSpawnModelChoice(
            {},
            context,
            () => pool,
            undefined,
            policy,
        );
        for (const resume of waiters) resume(resolution);

        const results = await Promise.all([first, second]);
        expect(results.filter((result) => !result.isError)).toHaveLength(1);
        expect(results.filter((result) => result.isError)).toEqual([
            expect.objectContaining({
                output: "Subagent limit reached (1 running).",
            }),
        ]);
        expect(modelCalls).toBe(1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a spawn may name the pool entry it wants by its user-chosen name", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-named-"));
    const final: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "child done" }],
        source: { provider: "pin-provider", api: "scripted", model: "small-model" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([final]);
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(nextRequest) {
            request = nextRequest;
            return faux.stream(nextRequest);
        },
    };
    const applyEffect = createSubagentEffectApplier({
        adapter,
        workspace: root,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        readPool: () => [{
            provider: "pin-provider",
            model: "small-model",
            label: "Small",
            poolName: "frosty",
            available: true,
            verified: true,
            levels: [{ id: "low", label: "Low" }],
        }],
    });

    try {
        const result = await applyEffect({
            type: "spawn_subagent",
            description: "use the named entry",
            model: "frosty",
        }, new AbortController().signal, {
            approvalMode: "auto",
            provider: "parent-provider",
            model: "selected",
        });

        expect(request?.provider).toBe("pin-provider");
        expect(request?.model).toBe("small-model");
        expect(result.isError).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import {
    createProtocolEncoder,
    type AgentUpdateSender,
} from "../../src/engine/protocol.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

const API_REMINDER = "Contents of .vera/rules/api.md:\n\n"
    + "Use the shared error helper.";
const BOTH_REMINDER = "Contents of .vera/rules/api.md:\n\n"
    + "Use the shared error helper.\n\n"
    + "Contents of .vera/rules/web.md:\n\n"
    + "Keep the web client a sibling.";

const temporaryWorkspaces: string[] = [];

afterAll(() => {
    for (const workspace of temporaryWorkspaces) {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("a matching read injects one internal reminder before the next model request", async () => {
    const workspace = seedWorkspace();
    writeRule(workspace, "api.md", ["src/api/**"], "Use the shared error helper.\n");
    const requests: ModelRequest[] = [];
    const { channel, state, start } = setupTurn(
        workspace,
        [
            toolCall("call_read", "read", { path: "src/api/handler.ts" }),
            assistantText("done"),
        ],
        requests,
    );

    channel.client.send({ type: "prompt", content: "fix the handler" });
    const turn = start();
    await drainTurn(channel);
    await turn;

    expect(requests).toHaveLength(2);
    expect(internalReminders(requests[0]?.messages ?? [])).toEqual([]);
    expect(internalReminders(requests[1]?.messages ?? [])).toEqual([API_REMINDER]);
    expect(state.injectedRulePaths).toEqual(
        new Set([join(workspace, ".vera", "rules", "api.md")]),
    );
    expect(internalReminders(state.messages)).toHaveLength(1);
});

test("two matching reads in one assistant message share one reminder", async () => {
    const workspace = seedWorkspace();
    mkdirSync(join(workspace, "src", "web"), { recursive: true });
    writeFileSync(join(workspace, "src", "web", "app.ts"), "export {};\n");
    writeRule(workspace, "api.md", ["src/api/**"], "Use the shared error helper.\n");
    writeRule(workspace, "web.md", ["src/web/**"], "Keep the web client a sibling.\n");
    const requests: ModelRequest[] = [];
    const { channel, start } = setupTurn(
        workspace,
        [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        id: "call_api",
                        name: "read",
                        input: { path: "src/api/handler.ts" },
                    },
                    {
                        type: "tool_call",
                        id: "call_web",
                        name: "read",
                        input: { path: "src/web/app.ts" },
                    },
                ],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "tool_use",
            },
            assistantText("done"),
        ],
        requests,
    );

    channel.client.send({ type: "prompt", content: "look at both" });
    const turn = start();
    await drainTurn(channel);
    await turn;

    expect(internalReminders(requests[1]?.messages ?? [])).toEqual([BOTH_REMINDER]);
});

test("a second read of the same tree does not inject again until compact", async () => {
    const workspace = seedWorkspace();
    writeFileSync(join(workspace, "src", "api", "nested.ts"), "export {};\n");
    writeRule(workspace, "api.md", ["src/api/**"], "Use the shared error helper.\n");
    const requests: ModelRequest[] = [];
    const { channel, state, start } = setupTurn(
        workspace,
        [
            toolCall("call_one", "read", { path: "src/api/handler.ts" }),
            toolCall("call_two", "read", { path: "src/api/nested.ts" }),
            assistantText("done"),
        ],
        requests,
    );

    channel.client.send({ type: "prompt", content: "read twice" });
    const turn = start();
    await drainTurn(channel);
    await turn;

    expect(internalReminders(state.messages)).toHaveLength(1);
    expect(internalReminders(requests[2]?.messages ?? [])).toEqual([API_REMINDER]);
});

test("a missed glob, a write, and a failed read do not inject", async () => {
    const workspace = seedWorkspace();
    mkdirSync(join(workspace, "src", "web"), { recursive: true });
    writeFileSync(join(workspace, "src", "web", "app.ts"), "export {};\n");
    writeRule(workspace, "api.md", ["src/api/**"], "Use the shared error helper.\n");

    await expectNoReminder(workspace, [
        toolCall("call_web", "read", { path: "src/web/app.ts" }),
        assistantText("done"),
    ]);
    await expectNoReminder(workspace, [
        toolCall("call_write", "write", {
            path: "src/api/new.ts",
            content: "export {};\n",
        }),
        assistantText("done"),
    ]);
    await expectNoReminder(workspace, [
        toolCall("call_missing", "read", { path: "src/api/missing.ts" }),
        assistantText("done"),
    ]);
});

test("an unknown frontmatter key alone is always on, so a read does not inject", async () => {
    const workspace = seedWorkspace();
    writeFileSync(
        join(workspace, ".vera", "rules", "later.md"),
        "---\ncommands:\n  - \"bun test\"\n---\n\nTUI test trap.\n",
    );
    await expectNoReminder(workspace, [
        toolCall("call_read", "read", { path: "src/api/handler.ts" }),
        assistantText("done"),
    ]);
});

test("a rule with malformed frontmatter does not inject", async () => {
    const workspace = seedWorkspace();
    writeFileSync(
        join(workspace, ".vera", "rules", "api.md"),
        "---\npaths: 17\n---\n\nUse the shared error helper.\n",
    );
    await expectNoReminder(workspace, [
        toolCall("call_read", "read", { path: "src/api/handler.ts" }),
        assistantText("done"),
    ]);
});

test("an empty rules directory does not inject", async () => {
    const workspace = seedWorkspace();
    writeRule(workspace, "api.md", ["src/api/**"], "Use the shared error helper.\n");
    removeRule(workspace, "api.md");
    await expectNoReminder(workspace, [
        toolCall("call_read", "read", { path: "src/api/handler.ts" }),
        assistantText("done"),
    ]);
});

test("a hand-built turn without the inject set does not inject", async () => {
    const workspace = seedWorkspace();
    writeRule(workspace, "api.md", ["src/api/**"], "Use the shared error helper.\n");
    const requests: ModelRequest[] = [];
    const { channel, start } = setupTurn(
        workspace,
        [
            toolCall("call_read", "read", { path: "src/api/handler.ts" }),
            assistantText("done"),
        ],
        requests,
        { omitInjectSet: true },
    );

    channel.client.send({ type: "prompt", content: "read api" });
    const turn = start();
    await drainTurn(channel);
    await turn;

    expect(internalReminders(requests[1]?.messages ?? [])).toEqual([]);
});

test("loadOptionalContext false skips inject even with the set present", async () => {
    const workspace = seedWorkspace();
    writeRule(workspace, "api.md", ["src/api/**"], "Use the shared error helper.\n");
    const requests: ModelRequest[] = [];
    const { channel, start } = setupTurn(
        workspace,
        [
            toolCall("call_read", "read", { path: "src/api/handler.ts" }),
            assistantText("done"),
        ],
        requests,
        { loadOptionalContext: false },
    );

    channel.client.send({ type: "prompt", content: "read api" });
    const turn = start();
    await drainTurn(channel);
    await turn;

    expect(internalReminders(requests[1]?.messages ?? [])).toEqual([]);
});

function seedWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), "vera-rules-turn-"));
    temporaryWorkspaces.push(workspace);
    mkdirSync(join(workspace, "src", "api"), { recursive: true });
    mkdirSync(join(workspace, ".vera", "rules"), { recursive: true });
    writeFileSync(join(workspace, "src", "api", "handler.ts"), "export {};\n");
    return workspace;
}

function writeRule(
    workspace: string,
    name: string,
    globs: readonly string[],
    body: string,
): void {
    const frontmatter = globs.length === 0
        ? ""
        : `---\npaths:\n${globs.map((glob) => `  - "${glob}"`).join("\n")}\n---\n\n`;
    writeFileSync(join(workspace, ".vera", "rules", name), frontmatter + body);
}

function removeRule(workspace: string, name: string): void {
    rmSync(join(workspace, ".vera", "rules", name), { force: true });
}

function setupTurn(
    workspace: string,
    responses: readonly AssistantMessage[],
    requests: ModelRequest[],
    options: {
        readonly omitInjectSet?: boolean;
        readonly loadOptionalContext?: boolean;
    } = {},
): {
    readonly channel: ReturnType<typeof createInProcessChannel>;
    readonly state: RunTurnState;
    readonly start: () => ReturnType<typeof runTurn>;
} {
    const faux = new FauxAdapter([...responses]);
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine as AgentUpdateSender));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        ...(options.omitInjectSet === true
            ? {}
            : { injectedRulePaths: new Set<string>() }),
        ...(options.loadOptionalContext === undefined
            ? {}
            : { loadOptionalContext: options.loadOptionalContext }),
    };
    return {
        channel,
        state,
        start: () => runTurn(adapter, "test", state),
    };
}

function toolCall(
    id: string,
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id,
            name,
            input,
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function assistantText(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function internalReminders(
    messages: readonly {
        readonly role: string;
        readonly internal?: boolean;
        readonly content: readonly {
            readonly type: string;
            readonly text?: string;
        }[];
    }[],
): string[] {
    return messages.flatMap((message) => {
        if (message.role !== "user" || message.internal !== true) {
            return [];
        }
        const [block] = message.content;
        return block?.type === "text" && typeof block.text === "string"
            ? [block.text]
            : [];
    });
}

async function expectNoReminder(
    workspace: string,
    responses: readonly AssistantMessage[],
): Promise<void> {
    const requests: ModelRequest[] = [];
    const { channel, start } = setupTurn(workspace, responses, requests);
    channel.client.send({ type: "prompt", content: "go" });
    const turn = start();
    await drainTurn(channel);
    await turn;
    expect(internalReminders(requests.at(-1)?.messages ?? [])).toEqual([]);
}

async function drainTurn(
    channel: ReturnType<typeof createInProcessChannel>,
): Promise<void> {
    while (true) {
        const update = await channel.client.receive();
        if (update.type === "turn_finished") {
            return;
        }
    }
}

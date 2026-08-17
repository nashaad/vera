import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createReminderHook,
    loadReminderRules,
} from "../../src/host/reminder-rules.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
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

async function writeRules(lines: readonly string[]): Promise<{
    readonly dir: string;
    readonly path: string;
}> {
    const dir = await mkdtemp(join(tmpdir(), "vera-reminder-rules-"));
    const path = join(dir, "rules.toml");
    await writeFile(path, lines.join("\n"));
    return { dir, path };
}

test("a missing rules file reads as no rules", async () => {
    const file = await loadReminderRules("/nonexistent/rules.toml");
    expect(file.rules).toEqual([]);
});

test("valid rules load and malformed entries are skipped", async () => {
    const { dir, path } = await writeRules([
        "cooldown_minutes = 5",
        "",
        "[[rules]]",
        'id = "plan"',
        'match = "**/plan*.md"',
        'remind = "Update the index."',
        "",
        "[[rules]]",
        'id = "broken"',
        'match = "**/x.md"',
    ]);
    try {
        expect(await loadReminderRules(path)).toEqual({
            cooldownMinutes: 5,
            rules: [
                { id: "plan", match: "**/plan*.md", remind: "Update the index." },
            ],
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("unparseable TOML reads as no rules", async () => {
    const { dir, path } = await writeRules(["[[rules", "not toml"]);
    try {
        expect((await loadReminderRules(path)).rules).toEqual([]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("the hook appends the reminder to a matching successful write", async () => {
    const { dir, path } = await writeRules([
        "[[rules]]",
        'id = "plan"',
        'match = "**/plan*.md"',
        'remind = "Update the index."',
    ]);
    try {
        const hook = createReminderHook(path);
        const outcome = await hook({
            type: "post_tool_use",
            toolCall: {
                id: "call_1",
                name: "write",
                input: { path: "notes/plan-v2.md", content: "x" },
            },
            result: {
                toolCallId: "call_1",
                toolName: "write",
                content: [{ type: "text", text: "Wrote 1 bytes" }],
                isError: false,
            },
            workspace: "/work",
            durationMs: 1,
        });
        expect(outcome).toEqual({
            power: "mutate",
            patch: {
                content: [
                    { type: "text", text: "Wrote 1 bytes" },
                    { type: "text", text: "Reminder: Update the index." },
                ],
            },
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("the hook observes errors, non-writing tools, misses, and cooldowns", async () => {
    const { dir, path } = await writeRules([
        "[[rules]]",
        'id = "plan"',
        'match = "**/plan*.md"',
        'remind = "Update the index."',
    ]);
    try {
        const hook = createReminderHook(path);
        const payload = (name: string, filePath: string, isError: boolean) => ({
            type: "post_tool_use" as const,
            toolCall: { id: "c", name, input: { path: filePath } },
            result: {
                toolCallId: "c",
                toolName: name,
                content: [],
                isError,
            },
            workspace: "/work",
            durationMs: 1,
        });

        expect(await hook(payload("write", "plan.md", true)))
            .toEqual({ power: "observe" });
        expect(await hook(payload("read", "plan.md", false)))
            .toEqual({ power: "observe" });
        expect(await hook(payload("write", "other.txt", false)))
            .toEqual({ power: "observe" });
        expect((await hook(payload("write", "plan.md", false))).power)
            .toBe("mutate");
        // Within the cooldown the same rule stays quiet.
        expect(await hook(payload("write", "plan.md", false)))
            .toEqual({ power: "observe" });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a matching write carries the reminder into the next model round", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-reminder-loop-"));
    const { dir, path } = await writeRules([
        "[[rules]]",
        'id = "plan"',
        'match = "**/plan*.md"',
        'remind = "Update the plan index."',
    ]);
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_write",
            name: "write",
            input: { path: "plan-v2.md", content: "the plan" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([toolCallResponse, finalResponse]);
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const hooks = new ToolHooks();
    hooks.registerPostToolUse(createReminderHook(path));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "full_access",
    };

    try {
        channel.client.send({ type: "prompt", content: "write the plan" });
        const turn = runTurn(adapter, "test", state);
        while (true) {
            const update = await channel.client.receive();
            if (update.type === "turn_finished") {
                break;
            }
        }
        await turn;

        expect(requests).toHaveLength(2);
        const toolResult = requests[1]?.messages.find(
            (message) => message.role === "tool_result",
        );
        expect(JSON.stringify(toolResult?.content)).toContain(
            "Reminder: Update the plan index.",
        );
    } finally {
        await rm(workspace, { recursive: true, force: true });
        await rm(dir, { recursive: true, force: true });
    }
});

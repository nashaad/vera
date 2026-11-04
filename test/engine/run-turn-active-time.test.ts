import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const temporaryDirectories: string[] = [];
afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("runTurn excludes time spent waiting for an ask_user answer", async () => {
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_question",
            name: "ask_user",
            input: {
                question: "Continue?",
                choices: [
                    { id: "continue", label: "Continue" },
                    { id: "stop", label: "Stop" },
                ],
            },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const directory = mkdtempSync(join(tmpdir(), "turn-active-time-"));
    temporaryDirectories.push(directory);
    const sessionPath = join(directory, "session.jsonl");
    const store = await SessionStore.create(sessionPath, {
        sessionId: "active-time-test",
        cwd: process.cwd(),
    });
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const state: RunTurnState = {
        messages: [],
        store,
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        enableUserInteraction: true,
    };
    channel.client.send({ type: "prompt", content: "Continue the task" });

    const startedAt = performance.now();
    const turn = runTurn(
        new FauxAdapter([toolCallResponse, finalResponse]),
        "test",
        state,
    );
    const question = await receiveUserQuestion(channel);
    const waitStartedAt = performance.now();
    await Bun.sleep(250);
    const waitDurationMs = performance.now() - waitStartedAt;
    channel.client.send({
        type: "ui_response",
        requestId: question.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "continue",
        },
    });

    const result = await turn;
    const elapsedMs = performance.now() - startedAt;
    const activeDurationMs = result.turnTiming?.durationMs;

    if (activeDurationMs === undefined) {
        throw new Error("The completed turn has no timing value");
    }
    expect(elapsedMs - activeDurationMs).toBeGreaterThan(waitDurationMs - 50);
    expect(state.messages.at(-1)).toMatchObject({ turnTiming: result.turnTiming });
    const reopened = await SessionStore.open(sessionPath);
    expect(reopened.messages().at(-1)).toMatchObject({
        role: "assistant",
        turnTiming: result.turnTiming,
    });
});

async function receiveUserQuestion(
    channel: ReturnType<typeof createInProcessChannel>,
) {
    const seen: string[] = [];
    try {
        while (true) {
            const update = await channel.client.receive(AbortSignal.timeout(3_000));
            seen.push(update.type);
            if (update.type === "ui_request") {
                seen.push(update.request.type);
                if (update.request.type === "user_question") return update;
            }
        }
    } catch {
        throw new Error(`User question was not received. Updates: ${seen.join(", ")}`);
    }
}

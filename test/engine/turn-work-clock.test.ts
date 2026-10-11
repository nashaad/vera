import { expect, test } from "bun:test";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { TurnWorkClock } from "../../src/engine/turn-work-clock.ts";

test("turn work clock excludes user request waits and counts active work", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);
    let now = 0;
    const clock = router.beginTurnTiming(new TurnWorkClock(() => now));

    now += 100;
    const answer = router.requestUserQuestion({
        question: "Continue?",
        choices: [{ id: "yes", label: "Yes" }],
    });
    const question = await receiveUiRequest(channel.client);
    now += 10_000;
    channel.client.send({
        type: "ui_response",
        requestId: question.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "yes",
        },
    });
    await answer;

    now += 200;
    const approval = router.requestToolApproval(
        { id: "call_1", name: "bash", input: { command: "echo ok" } },
        "test approval",
        { timeoutMs: 60_000 },
    );
    const approvalRequest = await receiveUiRequest(channel.client);
    now += 20_000;
    channel.client.send({
        type: "ui_response",
        requestId: approvalRequest.requestId,
        response: { type: "tool_approval", decision: "allow_once" },
    });
    await approval;

    now += 50;
    const configuration = router.requestConfigurationRequired({
        destination: { kind: "model" },
        reason: "Select a model",
        pendingAction: { id: "subagent_1", kind: "subagent_launch", count: 1 },
    });
    const configurationRequest = await receiveUiRequest(channel.client);
    now += 30_000;
    channel.client.send({
        type: "ui_response",
        requestId: configurationRequest.requestId,
        response: { type: "configuration_required", outcome: "configured" },
    });
    await configuration;

    now += 250;
    expect(router.finishTurnTiming(clock)).toBe(600);
});

test("overlapping user requests keep the turn clock paused until all resolve", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);
    let now = 0;
    const clock = router.beginTurnTiming(new TurnWorkClock(() => now));

    now += 100;
    const answer = router.requestUserQuestion({
        question: "Continue?",
        choices: [{ id: "yes", label: "Yes" }],
    });
    const approval = router.requestToolApproval(
        { id: "call_2", name: "bash", input: { command: "echo ok" } },
        "test approval",
        { timeoutMs: 60_000 },
    );
    const questionRequest = await receiveUiRequest(channel.client);
    const approvalRequest = await receiveUiRequest(channel.client);

    now += 1_000;
    channel.client.send({
        type: "ui_response",
        requestId: questionRequest.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "yes",
        },
    });
    await answer;

    now += 500;
    channel.client.send({
        type: "ui_response",
        requestId: approvalRequest.requestId,
        response: { type: "tool_approval", decision: "allow_once" },
    });
    await approval;

    now += 100;
    expect(router.finishTurnTiming(clock)).toBe(200);
});

test("finishing a paused clock freezes its active duration", () => {
    let now = 0;
    const clock = new TurnWorkClock(() => now);

    now += 100;
    clock.pause();
    now += 1_000;
    expect(clock.finish()).toBe(100);

    now += 1_000;
    clock.resume();
    expect(clock.finish()).toBe(100);
});

async function receiveUiRequest(
    client: ReturnType<typeof createInProcessChannel>["client"],
): Promise<Extract<
    Awaited<ReturnType<typeof client.receive>>,
    { readonly type: "ui_request" }
>> {
    while (true) {
        const update = await client.receive();
        if (update.type === "ui_request") return update;
    }
}

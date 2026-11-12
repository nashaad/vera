import { expect, test } from "bun:test";

import {
    DROP_OLDEST_STRATEGY_ID,
    dropOldestStrategy,
} from "../../src/engine/compaction-drop-oldest.ts";
import {
    BUNDLED_COMPACTION_STRATEGIES,
    DEFAULT_COMPACTION_STRATEGY_ID,
} from "../../src/engine/compaction-binding.ts";
import {
    CompactionRejectedError,
    projectionHoldsPrompt,
    promptWords,
    validateProposal,
    workingPrompt,
    type CompactionProposal,
    type CompactionRequest,
} from "../../src/engine/compaction.ts";
import { measureMessages } from "../../src/engine/context-measurement.ts";
import { assertToolCallsPaired } from "../../src/model/tool-pairing.ts";
import {
    emptyUsage,
    type ModelMessage,
    type UserMessage,
} from "../../src/model/types.ts";

const SOURCE = { provider: "faux", api: "scripted", model: "test" } as const;

function user(text: string, internal = false): ModelMessage {
    return {
        role: "user",
        content: [{ type: "text", text }],
        ...(internal ? { internal: true } : {}),
    };
}

function steer(text: string): UserMessage {
    return {
        role: "user",
        content: [{ type: "text", text }],
        arrivedDuringTurn: true,
    };
}

function imageOnly(attachmentId: string): UserMessage {
    return { role: "user", content: [{ type: "image_attachment", attachmentId }] };
}

function answer(text: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: SOURCE,
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function call(id: string, path: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "read", input: { path } }],
        source: SOURCE,
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function result(id: string, text: string): ModelMessage {
    return {
        role: "tool_result",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
    };
}

function words(label: string): string {
    return `${label} `.repeat(300);
}

function plainTurn(label: string): ModelMessage[] {
    return [user(words(label)), answer(words(`${label} answer`))];
}

function run(
    messages: readonly ModelMessage[],
    targetTokens: number,
): Promise<ModelMessage[]> {
    const request: CompactionRequest = { messages, targetTokens, models: {} };
    return dropOldestStrategy.compact(request, new AbortController().signal)
        .then((proposal) => [...validateProposal(proposal, request)]);
}

function texts(messages: readonly ModelMessage[]): string[] {
    return messages.map((message) =>
        message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("")
            .split(" ")[0] ?? ""
    );
}

function propose(
    messages: readonly ModelMessage[],
    targetTokens: number,
    previousProjectionCount = 0,
): Promise<CompactionProposal> {
    const request: CompactionRequest = {
        messages,
        targetTokens,
        models: {},
        previousProjectionCount,
    };
    return dropOldestStrategy.compact(request, new AbortController().signal);
}

function keptFrom(turn: readonly ModelMessage[], cut: number): ModelMessage[] {
    return [...turn.slice(0, 1), ...turn.slice(cut)];
}

function steppedTurn(label = "charlie"): ModelMessage[] {
    return [
        user(words(label)),
        call("call_1", "src/a.ts"),
        result("call_1", words("first body")),
        call("call_2", "src/b.ts"),
        result("call_2", words("second body")),
        answer(words(`${label} answer`)),
    ];
}

test("the strategy is registered beside the summary, declares no model and keeps the prompt", () => {
    expect(dropOldestStrategy.id).toBe(DROP_OLDEST_STRATEGY_ID);
    expect(dropOldestStrategy.models).toEqual([]);
    expect(dropOldestStrategy.keepsPrompt).toBe(true);
    expect(BUNDLED_COMPACTION_STRATEGIES).toContain(dropOldestStrategy);
    expect(DEFAULT_COMPACTION_STRATEGY_ID).toBe("vera/full-summary");
});

test("the newest whole turns that fit are kept and the older ones are dropped", async () => {
    const span = [
        ...plainTurn("alpha"),
        ...plainTurn("bravo"),
        ...plainTurn("charlie"),
        ...plainTurn("delta"),
    ];
    const target = measureMessages([
        ...plainTurn("charlie"),
        ...plainTurn("delta"),
    ]);

    const kept = await run(span, target);

    expect(kept.length).toBe(4);
    expect(texts(kept)[0]).toBe("charlie");
    expect(measureMessages(kept)).toBeLessThanOrEqual(target);
});

test("one token less than the next turn needs drops that turn", async () => {
    const span = [
        ...plainTurn("alpha"),
        ...plainTurn("bravo"),
        ...plainTurn("charlie"),
    ];
    const withBravo = measureMessages([
        ...plainTurn("bravo"),
        ...plainTurn("charlie"),
    ]);

    const kept = await run(span, withBravo - 1);

    expect(kept.length).toBe(2);
    expect(texts(kept)[0]).toBe("charlie");
    expect(measureMessages(kept)).toBeLessThanOrEqual(withBravo - 1);
});

test("a tool call and its result are kept or dropped together", async () => {
    const span = [
        ...plainTurn("alpha"),
        user(words("bravo")),
        call("call_1", "src/a.ts"),
        result("call_1", words("file body")),
        answer(words("bravo answer")),
        ...plainTurn("charlie"),
    ];
    const withBravo = measureMessages(span.slice(2));
    const onlyCharlie = measureMessages(plainTurn("charlie"));

    const keepsBravo = await run(span, withBravo);
    expect(keepsBravo.some((message) => message.role === "tool_result")).toBe(
        true,
    );
    expect(() => assertToolCallsPaired(keepsBravo, "kept")).not.toThrow();

    const dropsBravo = await run(span, onlyCharlie);
    expect(dropsBravo.some((message) => message.role === "tool_result")).toBe(
        false,
    );
    expect(dropsBravo.some((message) => message.role === "assistant" &&
        message.content.some((block) => block.type === "tool_call"))).toBe(false);
});

test("the projection never opens on a tool result or an unpaired call, at any target", async () => {
    const span = [
        ...plainTurn("alpha"),
        user(words("bravo")),
        call("call_1", "src/a.ts"),
        result("call_1", words("file body")),
        answer(words("bravo answer")),
        user(words("charlie")),
        call("call_2", "src/b.ts"),
        result("call_2", words("second body")),
        answer(words("charlie answer")),
    ];
    const total = measureMessages(span);

    let accepted = 0;
    for (let target = 1; target <= total; target += 37) {
        let proposal: CompactionProposal;
        try {
            proposal = await propose(span, target);
        } catch (error) {
            expect(error).toBeInstanceOf(CompactionRejectedError);
            continue;
        }
        accepted += 1;
        expect(proposal.projection[0]?.role).toBe("user");
        expect(() =>
            assertToolCallsPaired(proposal.projection, "kept")
        ).not.toThrow();
        expect(measureMessages(proposal.projection)).toBeLessThanOrEqual(target);
    }
    expect(accepted).toBeGreaterThan(0);
});

test("messages that a user did not write stay inside the turn they belong to", async () => {
    const span = [
        ...plainTurn("alpha"),
        user(words("bravo")),
        answer(words("bravo answer")),
        user(words("reminder"), true),
        answer(words("bravo followup")),
    ];
    const bravoTurn = measureMessages(span.slice(2));

    const kept = await run(span, bravoTurn);

    expect(kept.length).toBe(4);
    expect(texts(kept)[0]).toBe("bravo");
    expect(texts(kept)[2]).toBe("reminder");
});

test("messages before the first user turn are never kept", async () => {
    const span = [answer(words("orphan")), ...plainTurn("alpha")];

    const kept = await run(span, 1_000_000);

    expect(kept.length).toBe(2);
    expect(texts(kept)[0]).toBe("alpha");
});

test("a newest turn larger than the target is refused, not returned over the target", async () => {
    const span = plainTurn("alpha");
    const target = measureMessages(span) - 1;

    const attempt = run(span, target);

    await expect(attempt).rejects.toBeInstanceOf(CompactionRejectedError);
    await expect(attempt).rejects.toMatchObject({ roomRelated: true });
});

test("a span with no user turn is refused with nothing to keep", async () => {
    const attempt = run([answer(words("orphan"))], 1_000_000);

    await expect(attempt).rejects.toBeInstanceOf(CompactionRejectedError);
    await expect(attempt).rejects.toMatchObject({ roomRelated: false });
});

test("the cut lands on the earliest assistant message whose suffix fits", async () => {
    const turn = steppedTurn();

    const proposal = await propose(turn, measureMessages(keptFrom(turn, 3)));

    expect(proposal.projection).toEqual(keptFrom(turn, 3));
});

test("one token less than that suffix moves the cut to the next assistant message", async () => {
    const turn = steppedTurn();

    const proposal = await propose(
        turn,
        measureMessages(keptFrom(turn, 3)) - 1,
    );

    expect(proposal.projection).toEqual(keptFrom(turn, 5));
});

test("the cut never lands on a tool result", async () => {
    const turn = steppedTurn();
    const total = measureMessages(turn);
    let accepted = 0;
    for (let target = 1; target <= total; target += 37) {
        let proposal: CompactionProposal;
        try {
            proposal = await propose(turn, target);
        } catch (error) {
            expect(error).toBeInstanceOf(CompactionRejectedError);
            expect(error).toMatchObject({ roomRelated: true });
            continue;
        }
        accepted += 1;
        expect(proposal.projection.at(1)?.role).not.toBe("tool_result");
        expect(() =>
            assertToolCallsPaired(proposal.projection, "kept")
        ).not.toThrow();
    }
    expect(accepted).toBeGreaterThan(0);
});

test("an internal reminder is never a cut point", async () => {
    const turn: ModelMessage[] = [
        user(words("charlie")),
        call("call_1", "src/a.ts"),
        result("call_1", words("first body")),
        user(words("reminder"), true),
        answer(words("charlie answer")),
    ];

    const proposal = await propose(turn, measureMessages(keptFrom(turn, 3)));

    expect(proposal.projection).toEqual(keptFrom(turn, 4));
});

test("a prompt that cannot sit beside its newest step is refused as room-related", async () => {
    const turn = steppedTurn();
    const attempt = propose(turn, measureMessages(keptFrom(turn, 5)) - 1);

    await expect(attempt).rejects.toBeInstanceOf(CompactionRejectedError);
    await expect(attempt).rejects.toMatchObject({ roomRelated: true });
});

test("dropped counts whole turns and the steps cut from the newest turn", async () => {
    const turn = steppedTurn();

    const cut = await propose(
        [...plainTurn("alpha"), ...turn],
        measureMessages(keptFrom(turn, 3)),
    );
    expect(cut.dropped).toEqual({ wholeTurns: 1, cutTurnSteps: 1 });

    const whole = await propose(
        [...plainTurn("alpha"), ...plainTurn("charlie")],
        measureMessages(plainTurn("charlie")),
    );
    expect(whole.dropped).toEqual({ wholeTurns: 1, cutTurnSteps: 0 });
});

test("a step with two tool results counts as one dropped step", async () => {
    const parallel: ModelMessage = {
        role: "assistant",
        content: [
            { type: "tool_call", id: "call_1", name: "read", input: { path: "src/a.ts" } },
            { type: "tool_call", id: "call_2", name: "read", input: { path: "src/b.ts" } },
        ],
        source: SOURCE,
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const turn: ModelMessage[] = [
        user(words("charlie")),
        parallel,
        result("call_1", words("first body")),
        result("call_2", words("second body")),
        answer(words("charlie answer")),
    ];

    const cut = await propose(
        [...plainTurn("alpha"), ...turn],
        measureMessages(keptFrom(turn, 4)),
    );

    expect(cut.projection).toEqual(keptFrom(turn, 4));
    expect(cut.dropped).toEqual({ wholeTurns: 1, cutTurnSteps: 1 });
});

test("promptWords keeps the text of a prompt and its arrival flag", () => {
    const prompt: UserMessage = {
        role: "user",
        content: [
            { type: "text", text: "first" },
            { type: "image_attachment", attachmentId: "image-1" },
            { type: "text", text: "second" },
        ],
        arrivedDuringTurn: true,
    };

    expect(promptWords(prompt)).toEqual({
        role: "user",
        content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
        ],
        arrivedDuringTurn: true,
    });
});

test("promptWords of an attachment-only prompt is undefined", () => {
    const prompt: UserMessage = {
        role: "user",
        content: [{ type: "image_attachment", attachmentId: "image-1" }],
    };

    expect(promptWords(prompt)).toBeUndefined();
});

test("promptWords leaves out an unset arrival flag and copies its blocks", () => {
    const prompt: UserMessage = {
        role: "user",
        content: [{ type: "text", text: "hello" }],
    };

    const copy = promptWords(prompt);

    expect(copy).toEqual(prompt);
    expect(copy).not.toHaveProperty("arrivedDuringTurn");
    expect(copy?.content.at(0)).not.toBe(prompt.content.at(0));
});

test("projectionHoldsPrompt finds a user message with the same words and flag", () => {
    const prompt: UserMessage = {
        role: "user",
        content: [{ type: "text", text: "charlie" }],
        arrivedDuringTurn: true,
    };

    expect(
        projectionHoldsPrompt([user("alpha"), { ...prompt }], prompt),
    ).toBe(true);
});

test("projectionHoldsPrompt rejects other words, another flag, an internal copy, or a message not from the user", () => {
    const prompt: UserMessage = {
        role: "user",
        content: [{ type: "text", text: "charlie" }],
    };
    const flagged: UserMessage = { ...prompt, arrivedDuringTurn: true };

    expect(projectionHoldsPrompt([user("bravo")], prompt)).toBe(false);
    expect(projectionHoldsPrompt([user("charlie")], flagged)).toBe(false);
    expect(projectionHoldsPrompt([{ ...flagged }], prompt)).toBe(false);
    expect(projectionHoldsPrompt([{ ...prompt, internal: true }], prompt))
        .toBe(false);
    expect(projectionHoldsPrompt([answer("charlie")], prompt)).toBe(false);
});

test("workingPrompt is the newest turn start unless an answer follows it", () => {
    expect(
        workingPrompt([...plainTurn("alpha"), user(words("bravo")), call("call_1", "src/a.ts")])
            ?.index,
    ).toBe(2);
    expect(workingPrompt(plainTurn("alpha"))).toBeUndefined();
});

test("a wordless prompt being worked on keeps its image", async () => {
    const prompt = imageOnly("image-1");
    const working = [
        prompt,
        call("call_1", "src/a.ts"),
        result("call_1", words("body")),
    ];

    const kept = await run(
        [...plainTurn("alpha"), ...working],
        measureMessages(working),
    );

    expect(kept).toEqual(working);
    expect(projectionHoldsPrompt(kept, prompt)).toBe(true);
});

test("a wordless turn that is no longer worked on is dropped whole with its steers", async () => {
    const span = [
        imageOnly("image-2"),
        steer(words("steer")),
        call("call_1", "src/a.ts"),
        result("call_1", words("body")),
        ...plainTurn("charlie"),
    ];

    const proposal = await propose(span, measureMessages(plainTurn("charlie")));

    expect(proposal.projection).toEqual(plainTurn("charlie"));
    expect(proposal.dropped).toEqual({ wholeTurns: 1, cutTurnSteps: 0 });
});

test("a cut that cannot keep the older turn's newest step moves to the next turn start", async () => {
    const newest = [
        user(words("delta")),
        call("call_3", "src/c.ts"),
        result("call_3", words("third body")),
    ];
    const span = [
        ...steppedTurn(),
        imageOnly("image-2"),
        answer(words("wordless answer")),
        ...newest,
    ];

    const proposal = await propose(span, measureMessages(newest));

    expect(proposal.projection).toEqual(newest);
    expect(proposal.dropped).toEqual({ wholeTurns: 2, cutTurnSteps: 0 });
});

test("an older cut turn keeps its prompt and newest step past a wordless turn", async () => {
    const newest = [
        user(words("delta")),
        call("call_3", "src/c.ts"),
        result("call_3", words("third body")),
    ];
    const span = [
        ...steppedTurn(),
        imageOnly("image-2"),
        answer(words("wordless answer")),
        ...newest,
    ];
    const opening = [user(words("charlie")), answer(words("charlie answer"))];

    const proposal = await propose(span, measureMessages([...opening, ...newest]));

    expect(proposal.projection).toEqual([...opening, ...newest]);
    expect(proposal.dropped).toEqual({ wholeTurns: 1, cutTurnSteps: 2 });
});

test("the earlier unit drops its wordless turns and is kept only when it fits", async () => {
    const span = [
        imageOnly("image-3"),
        answer(words("wordless answer")),
        ...plainTurn("alpha"),
        ...steppedTurn("bravo"),
        ...plainTurn("charlie"),
    ];
    const beside = [
        ...plainTurn("alpha"),
        user(words("bravo")),
        answer(words("bravo answer")),
        ...plainTurn("charlie"),
    ];
    const withoutUnit = [
        user(words("bravo")),
        answer(words("bravo answer")),
        ...plainTurn("charlie"),
    ];

    const kept = await propose(span, measureMessages(beside), 4);
    expect(kept.projection).toEqual(beside);
    expect(kept.dropped).toEqual({ wholeTurns: 1, cutTurnSteps: 2 });

    const dropped = await propose(span, measureMessages(withoutUnit), 4);
    expect(dropped.projection).toEqual(withoutUnit);
    expect(dropped.dropped).toEqual({ wholeTurns: 2, cutTurnSteps: 2 });
});

test("an earlier summary is kept past two older turns beside the cut turn, and dropped and counted when it does not fit", async () => {
    const summary = user(words("summary"));
    const newest = plainTurn("delta");
    const span = [
        summary,
        ...plainTurn("alpha"),
        ...plainTurn("bravo"),
        ...steppedTurn("charlie"),
        ...newest,
    ];
    const withSummary = [
        summary,
        user(words("charlie")),
        answer(words("charlie answer")),
        ...newest,
    ];
    const withoutSummary = withSummary.slice(1);

    const kept = await propose(span, measureMessages(withSummary), 1);
    expect(kept.projection).toEqual(withSummary);
    expect(kept.dropped).toEqual({ wholeTurns: 2, cutTurnSteps: 2 });

    const dropped = await propose(span, measureMessages(withoutSummary), 1);
    expect(dropped.projection).toEqual(withoutSummary);
    expect(dropped.dropped).toEqual({ wholeTurns: 3, cutTurnSteps: 2 });
});

test("an earlier summary is kept past two older turns beside the newest turns, and dropped and counted when it does not fit", async () => {
    const summary = user(words("summary"));
    const newest = plainTurn("delta");
    const span = [
        summary,
        ...plainTurn("alpha"),
        ...plainTurn("bravo"),
        ...plainTurn("charlie"),
        ...newest,
    ];
    const withSummary = [summary, ...newest];

    const kept = await propose(span, measureMessages(withSummary), 1);
    expect(kept.projection).toEqual(withSummary);
    expect(kept.dropped).toEqual({ wholeTurns: 3, cutTurnSteps: 0 });

    const dropped = await propose(span, measureMessages(newest), 1);
    expect(dropped.projection).toEqual(newest);
    expect(dropped.dropped).toEqual({ wholeTurns: 4, cutTurnSteps: 0 });
});

test("an earlier unit stops before a turn that straddles its end, and that turn is dropped and counted", async () => {
    const alpha = [user("alpha"), answer("alpha answer")];
    const newest = plainTurn("delta");
    const span = [
        ...alpha,
        ...plainTurn("bravo"),
        ...plainTurn("charlie"),
        ...newest,
    ];
    const kept = [...alpha, ...newest];

    const proposal = await propose(span, measureMessages(kept), 3);

    expect(proposal.projection).toEqual(kept);
    expect(proposal.dropped).toEqual({ wholeTurns: 2, cutTurnSteps: 0 });
});

test("a steer is a step start, so a cut can land on it", async () => {
    const opener = user(words("charlie"));
    const steering = steer(words("steer"));
    const closing = answer(words("charlie answer"));
    const turn: ModelMessage[] = [
        opener,
        call("call_1", "src/a.ts"),
        result("call_1", words("first body")),
        steering,
        closing,
    ];

    const proposal = await propose(
        turn,
        measureMessages([opener, steering, closing]),
    );

    expect(proposal.projection).toEqual([opener, steering, closing]);
});

test("a projection may carry an attachment the request holds, and no other", () => {
    const image = imageOnly("image-1");
    const request: CompactionRequest = {
        messages: [image],
        targetTokens: 1_000_000,
        models: {},
    };

    expect(() => validateProposal({ projection: [image] }, request))
        .not.toThrow();
    expect(() =>
        validateProposal({ projection: [imageOnly("image-2")] }, request)
    ).toThrow(CompactionRejectedError);
});

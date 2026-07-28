import { expect, test } from "bun:test";

import {
    FULL_SUMMARY_MODEL_SLOT,
    fullSummaryStrategy,
} from "../../src/engine/compaction-full-summary.ts";
import { CompactionRejectedError } from "../../src/engine/compaction.ts";
import {
    CompletionUnavailableError,
    type CompleteText,
} from "../../src/engine/completion-service.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

test("the projection is one message that says what it is", async () => {
    // Without the label the next turn reads a description of the work as a
    // fresh instruction to do it again.
    const { proposal } = await compact(span(), () => "the note");

    expect(proposal.projection.length).toBe(1);
    const message = proposal.projection[0];
    expect(message?.role).toBe("user");
    expect(text(message)).toContain("summary of the earlier part");
    expect(text(message)).toContain("the note");
});

test("no assistant turn is invented to carry the summary", async () => {
    const { proposal } = await compact(span(), () => "the note");

    expect(
        proposal.projection.some((message) => message.role === "assistant"),
    ).toBe(false);
});

test("the transcript carries every message in the span", async () => {
    const { prompt } = await compact(span(), () => "the note");

    expect(prompt).toContain("first question");
    expect(prompt).toContain("an answer");
    expect(prompt).toContain("read");
    expect(prompt).toContain("file contents");
    expect(prompt).toContain("last question");
});

test("an oversized tool result is clamped, and the clamp says so", async () => {
    const messages: ModelMessage[] = [
        user("do it"),
        {
            role: "tool_result",
            toolCallId: "call_1",
            toolName: "bash",
            content: [{
                type: "text",
                text: `START${"x".repeat(20_000)}FINISH`,
            }],
            isError: false,
        },
    ];
    const { prompt } = await compact(messages, () => "the note");

    expect(prompt).toContain("characters omitted");
    // Tail-biased, because a command's outcome is at its end.
    expect(prompt).toContain("START");
    expect(prompt).toContain("FINISH");
});

test("an empty summary is refused rather than appended", async () => {
    await expect(compact(span(), () => "   ")).rejects.toBeInstanceOf(
        CompactionRejectedError,
    );
});

test("a missing model slot is refused before any transcript is built", async () => {
    await expect(
        fullSummaryStrategy.compact(
            { messages: span(), targetTokens: 2_000, models: {} },
            new AbortController().signal,
        ),
    ).rejects.toBeInstanceOf(CompactionRejectedError);
});

test("an unavailable model stays unavailable, not a rejection", async () => {
    // The scheduler tells these apart: one says the strategy answered badly,
    // the other says no model answered at all.
    await expect(
        compact(span(), () => {
            throw new CompletionUnavailableError("no route");
        }),
    ).rejects.toBeInstanceOf(CompletionUnavailableError);
});

test("the word budget stays under the token target it will be checked against", async () => {
    const { words } = await compact(span(), () => "the note", 3_000);

    expect(words).toBeGreaterThan(0);
    expect(words).toBeLessThan(3_000);
});

async function compact(
    messages: readonly ModelMessage[],
    respond: () => string,
    targetTokens = 2_000,
): Promise<{
    proposal: Awaited<ReturnType<typeof fullSummaryStrategy.compact>>;
    prompt: string;
    words: number;
}> {
    let prompt = "";
    const complete: CompleteText = async (request) => {
        const block = request.messages[0]?.content[0];
        prompt = block !== undefined && block.type === "text" ? block.text : "";
        return { text: respond(), model: "test" };
    };
    const proposal = await fullSummaryStrategy.compact(
        {
            messages,
            targetTokens,
            models: { [FULL_SUMMARY_MODEL_SLOT]: complete },
        },
        new AbortController().signal,
    );
    const match = /roughly (\d+) words/.exec(prompt);
    return { proposal, prompt, words: Number(match?.[1] ?? 0) };
}

function span(): ModelMessage[] {
    return [
        user("first question"),
        {
            role: "assistant",
            content: [
                { type: "text", text: "an answer" },
                { type: "tool_call", id: "call_1", name: "read", input: {} },
            ],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        {
            role: "tool_result",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "file contents" }],
            isError: false,
        },
        user("last question"),
    ];
}

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function text(message: ModelMessage | undefined): string {
    const block = message?.content[0];
    return block !== undefined && block.type === "text" ? block.text : "";
}

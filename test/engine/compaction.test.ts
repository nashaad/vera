import { expect, test } from "bun:test";

import {
    CompactionRejectedError,
    validateProposal,
    type CompactionRequest,
} from "../../src/engine/compaction.ts";
import type { ModelMessage } from "../../src/model/types.ts";

const request: CompactionRequest = {
    messages: [],
    targetTokens: 1_000,
    models: {},
};

function reject(projection: unknown): void {
    expect(() =>
        validateProposal(
            { projection: projection as readonly ModelMessage[] },
            request,
        )
    ).toThrow(CompactionRejectedError);
}

test("a usable projection passes through unchanged", () => {
    const projection: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "a summary" }] },
    ];

    expect(validateProposal({ projection }, request)).toBe(projection);
});

test("an empty projection is refused, since it would erase the session", () => {
    reject([]);
});

test("a projection is refused when it is not an array of messages", () => {
    reject(["not a message"]);
    reject([null]);
});

test("an unknown role is refused", () => {
    reject([{ role: "system", content: [{ type: "text", text: "x" }] }]);
});

test("a message with no content is refused", () => {
    reject([{ role: "user", content: [] }]);
});

test("a projection cannot open with a tool result, which has nothing to answer", () => {
    reject([
        {
            role: "tool_result",
            toolCallId: "call_1",
            content: [{ type: "text", text: "done" }],
        },
    ]);
});

test("an unpaired tool call is refused", () => {
    reject([
        {
            role: "assistant",
            content: [
                { type: "tool_call", id: "call_1", name: "read", input: {} },
            ],
        },
    ]);
});

test("an attachment reference is refused rather than dropped", () => {
    // The reference resolves against a store the projection outlives, so it
    // would fail at the provider on some later turn with nothing to explain it.
    reject([
        {
            role: "user",
            content: [{ type: "image_attachment", attachmentId: "att_1" }],
        },
    ]);
});

test("a projection over the target is refused, because compacting has to make room", () => {
    const projection: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "x".repeat(80_000) }] },
    ];

    expect(() => validateProposal({ projection }, request)).toThrow(
        /over the 1000/,
    );
});

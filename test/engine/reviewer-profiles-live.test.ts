import { expect, test } from "bun:test";

import { createReviewerProfileRouter } from "../../src/engine/run-turn.ts";
import type { ToolReviewRequest } from "../../src/engine/reviewer.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ModelStream,
} from "../../src/model/types.ts";

const REQUEST: ToolReviewRequest = {
    toolCall: { id: "call_1", name: "bash", input: { command: "ls" } },
    workspace: "/tmp",
    reason: "it reads outside the workspace",
};

function verdict(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

class RecordingAdapter implements ModelAdapter {
    readonly models: string[] = [];

    stream(request: ModelRequest): ModelStream {
        this.models.push(request.model);
        const stream = new ModelEventStream();
        stream.push({ type: "start" });
        stream.push({
            type: "done",
            message: verdict(
                JSON.stringify({
                    decision: "allow",
                    reason: "fine",
                    risk_level: "low",
                    user_authorization: "unknown",
                }),
            ),
        });
        return stream;
    }
}

function unavailable(): never {
    throw new Error("the default reviewer should not be asked");
}

// A reviewer profile repointed at another model mid-session has to reach the
// next review in the session that is already running.
test("a profile repointed mid-session is used on the next review", async () => {
    const adapter = new RecordingAdapter();
    let profiles: Record<string, { models: { model: string }[] }> = {
        careful: { models: [{ model: "first" }] },
    };
    const route = createReviewerProfileRouter(
        unavailable,
        adapter,
        () => profiles as never,
    );
    await route("careful", REQUEST, new AbortController().signal);
    profiles = { careful: { models: [{ model: "second" }] } };
    await route("careful", REQUEST, new AbortController().signal);
    expect(adapter.models).toEqual(["first", "second"]);
});

test("a profile removed mid-session stops being available", async () => {
    const adapter = new RecordingAdapter();
    let profiles: Record<string, unknown> = {
        careful: { models: [{ model: "first" }] },
    };
    const route = createReviewerProfileRouter(
        unavailable,
        adapter,
        () => profiles as never,
    );
    await route("careful", REQUEST, new AbortController().signal);
    profiles = {};
    const after = await route(
        "careful",
        REQUEST,
        new AbortController().signal,
    );
    expect(after.decision).toBe("unavailable");
});

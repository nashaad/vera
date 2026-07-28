import { expect, test } from "bun:test";

import { messageSubagentTool } from "../../src/tools/message-subagent.ts";
import { notifyParentTool } from "../../src/tools/notify-parent.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const runtime = new ToolRuntime("/workspace");
const signal = new AbortController().signal;

test("message_subagent returns a parent-scoped message effect", async () => {
    expect(await messageSubagentTool.execute({
        subagent_id: "child-1",
        message: "Also inspect the parser.",
    }, runtime, signal)).toEqual({
        kind: "effect",
        effect: {
            type: "message_subagent",
            subagentId: "child-1",
            message: "Also inspect the parser.",
        },
    });
});

test("notify_parent returns a durable attention effect", async () => {
    expect(await notifyParentTool.execute({
        message: "I need a decision.",
    }, runtime, signal)).toEqual({
        kind: "effect",
        effect: {
            type: "notify_parent",
            message: "I need a decision.",
        },
    });
});

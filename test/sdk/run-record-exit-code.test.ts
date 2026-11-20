import { expect, test } from "bun:test";

import { ToolCallRecord } from "../../src/sdk/run-record.ts";
import type { EngineEvent } from "../../src/engine/events.ts";

test("structured Agent run records retain an observed tool exit code", () => {
    const record = new ToolCallRecord();
    const start: EngineEvent = {
        type: "tool_execution_started",
        toolCall: { type: "tool_call", id: "call-1", name: "bash", input: {} },
    };
    const finish: EngineEvent = {
        type: "tool_execution_finished",
        toolCall: { type: "tool_call", id: "call-1", name: "bash", input: {} },
        result: {
            role: "tool_result",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "failed" }],
            isError: true,
            exitCode: 3,
        },
        durationMs: 5,
    };

    record.observe(start);
    record.observe(finish);
    expect(record.list()).toEqual([{
        id: "call-1",
        name: "bash",
        args: {},
        output: "failed",
        isError: true,
        exitCode: 3,
        durationMs: 5,
    }]);
});

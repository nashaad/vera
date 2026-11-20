import { expect, test } from "bun:test";

import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { emitExperimentalAgentEvent } from "../../clients/tui/main/watchers.ts";

test("experimental TUI tool_finished events preserve an observed exit code", () => {
    const events: unknown[] = [];
    const runtime = {
        experimentalTuiHost: { agentEvent: (event: unknown) => events.push(event) },
    } as unknown as TuiRuntime;

    emitExperimentalAgentEvent(runtime, {
        type: "tool_finished",
        tool: "bash",
        output: "failed",
        isError: true,
        exitCode: 7,
        seq: 1,
    });

    expect(events).toEqual([{
        type: "tool_finished",
        tool: "bash",
        output: "failed",
        isError: true,
        exitCode: 7,
    }]);
});

test("experimental TUI events omit an absent exit code", () => {
    const events: unknown[] = [];
    const runtime = {
        experimentalTuiHost: { agentEvent: (event: unknown) => events.push(event) },
    } as unknown as TuiRuntime;

    emitExperimentalAgentEvent(runtime, {
        type: "tool_finished",
        tool: "bash",
        seq: 1,
    });

    expect(events).toEqual([{ type: "tool_finished", tool: "bash" }]);
});

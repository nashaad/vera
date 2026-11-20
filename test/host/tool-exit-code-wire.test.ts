import { expect, test } from "bun:test";

import { applyThreadUpdate, projectStoredEntries } from "../../clients/shared/thread-facts.ts";
import { parseAgentUpdate } from "../../src/host/agent-update-wire.ts";

const liveUpdate = {
    type: "tool_finished" as const,
    tool: "bash",
    output: "failed command",
    isError: true,
    exitCode: 11,
    seq: 4,
};
const replayUpdate = {
    type: "history" as const,
    entries: [{
        kind: "tool_result" as const,
        tool: "bash",
        output: "failed command",
        isError: true,
        exitCode: 11,
    }],
    seq: 5,
};

test("host wire and shared thread facts preserve exit codes in live and replay", () => {
    expect(parseAgentUpdate(liveUpdate)).toEqual(liveUpdate);
    expect(parseAgentUpdate(replayUpdate)).toEqual(replayUpdate);
    expect(parseAgentUpdate({ ...liveUpdate, exitCode: 1.5 })).toBeUndefined();
    expect(parseAgentUpdate({ ...liveUpdate, exitCode: "11" })).toBeUndefined();
    expect(parseAgentUpdate({
        ...replayUpdate,
        entries: [{ ...replayUpdate.entries[0], exitCode: 1.5 }],
    })).toBeUndefined();

    const live = applyThreadUpdate({ stored: [], live: [] }, liveUpdate, 100);
    expect(live.live[0]).toMatchObject({ kind: "tool_result", exitCode: 11 });
    expect(projectStoredEntries(replayUpdate.entries)[0])
        .toMatchObject({ kind: "tool_result", exitCode: 11 });
});

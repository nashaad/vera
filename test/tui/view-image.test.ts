import { expect, test } from "bun:test";

import { applyAgentUpdate, createTuiState } from "../../clients/tui/state.ts";

test("view_image uses the ordinary terminal tool presentation", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "view_image",
        args: { path: "/workspace/cove.png" },
        seq: 1,
    });
    expect(state.entries).toContainEqual(expect.objectContaining({
        kind: "tool_header", active: true, command: "view_image /workspace/cove.png",
    }));
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "view_image",
        output: "cove.png: PNG, 3x2, 95 bytes",
        isError: false,
        seq: 2,
    });
    expect(state.entries).toContainEqual(expect.objectContaining({
        kind: "tool_header", header: "Worked", detailPreview: "  └ cove.png: PNG, 3x2, 95 bytes",
    }));
});

test("view_image errors stay visible in terminal tool details", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "view_image",
        args: { path: "/workspace/link.png" },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "view_image",
        output: "Use /outside/image.png instead",
        isError: true,
        seq: 2,
    });
    expect(state.entries).toContainEqual(expect.objectContaining({
        kind: "tool_header", detailPreview: "  └ Use /outside/image.png instead",
    }));
});

import { expect, test } from "bun:test";

import {
    applyAgentUpdate,
    createTuiState,
    renderTuiEntry,
    toggleTuiToolDetails,
    type TuiState,
    type TuiTextTranscriptEntry,
} from "../../clients/tui/state.ts";

function toolHeaders(state: TuiState): TuiTextTranscriptEntry[] {
    return state.entries.filter((entry): entry is TuiTextTranscriptEntry =>
        entry.kind === "tool_header"
    );
}

function rendered(entry: TuiTextTranscriptEntry): string {
    return renderTuiEntry(entry).chunks.map((chunk) => chunk.text).join("");
}

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
        kind: "tool_header", header: "Failed", detailPreview: "  └ Use /outside/image.png instead",
    }));
});

for (const tool of ["view_image", "web_search", "monitor", "crow_map"]) {
    test(`@core ${tool} uses its error flag for live and reopened tool results`, () => {
        const args = { path: "missing.png" };
        const error = "The crow cannot find the map";
        let live = applyAgentUpdate(createTuiState(), {
            type: "tool_started", tool, args, seq: 1,
        });
        live = applyAgentUpdate(live, {
            type: "tool_finished", tool, output: error, isError: true, seq: 2,
        });
        const reopened = applyAgentUpdate(createTuiState(), {
            type: "history", seq: 1, entries: [
                { kind: "tool", tool, args },
                { kind: "tool_result", tool, output: error, isError: true },
            ],
        });
        for (const state of [live, reopened]) {
            const [header] = toolHeaders(state);
            expect(header).toMatchObject({ header: "Failed", expanded: false });
            expect(rendered(header!)).toContain("Failed");
            expect(rendered(header!)).toContain(error);
            expect(rendered(header!)).not.toContain("Searched the web");
            const expanded = toggleTuiToolDetails(state);
            expect(expanded.entries).toContainEqual(expect.objectContaining({
                kind: "tool", result: true, text: error,
            }));
            expect(expanded.entries.find((entry) =>
                entry.kind === "tool" && entry.result === true
            )).not.toHaveProperty("hidden", true);
        }

        let success = applyAgentUpdate(createTuiState(), {
            type: "tool_started", tool, args, seq: 1,
        });
        success = applyAgentUpdate(success, {
            type: "tool_finished", tool, output: "No error in the map", isError: false, seq: 2,
        });
        expect(toolHeaders(success)[0]?.header).toBe("Worked");
        const reopenedSuccess = applyAgentUpdate(createTuiState(), {
            type: "history", seq: 1, entries: [
                { kind: "tool", tool, args },
                { kind: "tool_result", tool, output: "No error in the map", isError: false },
            ],
        });
        expect(toolHeaders(reopenedSuccess)[0]?.header).toBe("Worked");
    });
}

test("extension failure uses the built-in failure color and spacing", () => {
    const states = ["edit", "view_image"].map((tool) => {
        let state = applyAgentUpdate(createTuiState(), {
            type: "tool_started", tool, args: { path: "missing.png" }, seq: 1,
        });
        state = applyAgentUpdate(state, {
            type: "tool_finished", tool, output: "Missing image file", isError: true, seq: 2,
        });
        return renderTuiEntry(toolHeaders(state)[0]!);
    });
    expect(states[1]!.chunks.find((chunk) => chunk.text === "Failed"))
        .toEqual(states[0]!.chunks.find((chunk) => chunk.text === "Failed"));
    expect(states[1]!.chunks.find((chunk) => chunk.text === "Missing image file"))
        .toEqual(states[0]!.chunks.find((chunk) => chunk.text === "Missing image file"));
    expect(states[1]!.chunks.map((chunk) => chunk.text).join("")).toBe(
        "  Failed  view_image missing.png  Ctrl+T details\n  └ Missing image file",
    );
});

test("consecutive extension failures keep their errors visible when folded", () => {
    let live = createTuiState();
    live = applyAgentUpdate(live, {
        type: "tool_started", tool: "view_image", args: { path: "missing.png" }, seq: 1,
    });
    live = applyAgentUpdate(live, {
        type: "tool_finished", tool: "view_image", output: "Missing image", isError: true, seq: 2,
    });
    live = applyAgentUpdate(live, {
        type: "tool_started", tool: "crow_map", args: { path: "lost.png" }, seq: 3,
    });
    live = applyAgentUpdate(live, {
        type: "tool_finished", tool: "crow_map", output: "Lost map", isError: true, seq: 4,
    });
    const reopened = applyAgentUpdate(createTuiState(), {
        type: "history", seq: 1, entries: [
            { kind: "tool", tool: "view_image", args: { path: "missing.png" } },
            { kind: "tool_result", tool: "view_image", output: "Missing image", isError: true },
            { kind: "tool", tool: "crow_map", args: { path: "lost.png" } },
            { kind: "tool_result", tool: "crow_map", output: "Lost map", isError: true },
        ],
    });
    for (const state of [live, reopened]) {
        const folded = toolHeaders(state).map(rendered).join("\n");
        expect(folded).toContain("Missing image");
        expect(folded).toContain("Lost map");
    }
});

test("a folded failure still previews an error when another result is empty", () => {
    let live = createTuiState();
    live = applyAgentUpdate(live, {
        type: "tool_started", tool: "view_image", args: { path: "missing.png" }, seq: 1,
    });
    live = applyAgentUpdate(live, {
        type: "tool_finished", tool: "view_image", output: "Missing image", isError: true, seq: 2,
    });
    live = applyAgentUpdate(live, {
        type: "tool_started", tool: "crow_map", args: { path: "lost.png" }, seq: 3,
    });
    live = applyAgentUpdate(live, {
        type: "tool_finished", tool: "crow_map", output: "", isError: true, seq: 4,
    });
    const reopened = applyAgentUpdate(createTuiState(), {
        type: "history", seq: 1, entries: [
            { kind: "tool", tool: "view_image", args: { path: "missing.png" } },
            { kind: "tool_result", tool: "view_image", output: "Missing image", isError: true },
            { kind: "tool", tool: "crow_map", args: { path: "lost.png" } },
            { kind: "tool_result", tool: "crow_map", output: "", isError: true },
        ],
    });
    for (const state of [live, reopened]) {
        expect(toolHeaders(state).map(rendered).join("\n")).toContain("Missing image");
    }
});

test("repeated extension failures keep every error in the folded preview", () => {
    let live = createTuiState();
    for (const [index, output] of ["First missing image", "Second missing image"].entries()) {
        live = applyAgentUpdate(live, {
            type: "tool_started", tool: "view_image", args: { path: "missing.png" }, seq: index * 2 + 1,
        });
        live = applyAgentUpdate(live, {
            type: "tool_finished", tool: "view_image", output, isError: true, seq: index * 2 + 2,
        });
    }
    const reopened = applyAgentUpdate(createTuiState(), {
        type: "history", seq: 1, entries: [
            { kind: "tool", tool: "view_image", args: { path: "missing.png" } },
            { kind: "tool_result", tool: "view_image", output: "First missing image", isError: true },
            { kind: "tool", tool: "view_image", args: { path: "missing.png" } },
            { kind: "tool_result", tool: "view_image", output: "Second missing image", isError: true },
        ],
    });
    for (const state of [live, reopened]) {
        const folded = toolHeaders(state).map(rendered).join("\n");
        expect(folded).toContain("First missing image");
        expect(folded).toContain("Second missing image");
    }
});

test("a withheld extension call remains did not run", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "history", seq: 1, entries: [
            { kind: "tool", tool: "view_image", args: { path: "missing.png" } },
            { kind: "tool_result", tool: "view_image", output: "Not run", isError: true, withheld: true },
        ],
    });
    expect(toolHeaders(state)[0]?.header).toBe("Did not run");
});

test("mixed extension results keep each outcome on its own group", () => {
    let live = createTuiState();
    live = applyAgentUpdate(live, {
        type: "tool_started", tool: "view_image", args: { path: "missing.png" }, seq: 1,
    });
    live = applyAgentUpdate(live, {
        type: "tool_started", tool: "crow_map", args: { path: "map.png" }, seq: 2,
    });
    live = applyAgentUpdate(live, {
        type: "tool_finished", tool: "view_image", output: "Missing image", isError: true, seq: 3,
    });
    live = applyAgentUpdate(live, {
        type: "tool_finished", tool: "crow_map", output: "Map found", isError: false, seq: 4,
    });
    const reopened = applyAgentUpdate(createTuiState(), {
        type: "history", seq: 1, entries: [
            { kind: "tool", tool: "view_image", args: { path: "missing.png" } },
            { kind: "tool", tool: "crow_map", args: { path: "map.png" } },
            { kind: "tool_result", tool: "view_image", output: "Missing image", isError: true },
            { kind: "tool_result", tool: "crow_map", output: "Map found", isError: false },
        ],
    });
    for (const state of [live, reopened]) {
        const headers = toolHeaders(state);
        expect(headers.map((header) => header.header)).toEqual(["Failed", "Worked"]);
        expect(rendered(headers[0]!)).toContain("Missing image");
        expect(rendered(headers[1]!)).toContain("Map found");
    }
});

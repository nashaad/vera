import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    applyAgentUpdate,
    createTuiState,
    toggleTuiToolDetails,
    type TuiState,
    type TuiTextTranscriptEntry,
} from "../../clients/tui/state.ts";
import {
    createTuiToolHeader,
    createTuiToolRow,
} from "../../clients/tui/tool-row.ts";

const COMMAND = "bun test test/tui/driven/footer-layout.test.ts";

function waitedState(): TuiState {
    let state = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "bash",
        args: { command: COMMAND },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "bash",
        output: "Process still running after 10.0s (process_id: p-1, pid: 4411).",
        processId: "p-1",
        seq: 2,
    });
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "process",
        args: { action: "read", process_id: "p-1" },
        seq: 3,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "process",
        output: "still running (1)",
        processId: "p-1",
        seq: 4,
    });
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "process",
        args: { action: "read", process_id: "p-1" },
        seq: 5,
    });
    return applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "process",
        output: "still running (2)",
        processId: "p-1",
        seq: 6,
    });
}

function waitEntries(state: TuiState): TuiTextTranscriptEntry[] {
    return state.entries.filter((entry): entry is TuiTextTranscriptEntry =>
        entry.kind !== "diff" && entry.waitProcessId !== undefined
    );
}

function frameRows(frame: string): string[] {
    return frame.split("\n").map((row) => row.trimEnd());
}

test("a folded wait row names the command and the newest result", async () => {
    const state = waitedState();
    const [header] = waitEntries(state);
    expect(header?.kind).toBe("tool_header");

    const setup = await createTestRenderer({ width: 64, height: 4 });
    setup.renderer.root.add(createTuiToolHeader(
        setup.renderer,
        "wait-folded",
        header!,
        0,
    ));

    try {
        await setup.flush();
        const rows = frameRows(setup.captureCharFrame());
        const first = rows.findIndex((row) => row.includes("Waited"));
        expect(first).toBeGreaterThan(-1);
        expect(rows[first]).toContain(COMMAND);
        expect(rows[first + 1]?.trim()).toBe("└ still running (2)");
    } finally {
        setup.renderer.destroy();
    }
});

test("an expanded wait row shows the command and the full newest result", async () => {
    const state = toggleTuiToolDetails(waitedState());
    const entries = waitEntries(state);
    expect(entries.map((entry) => [entry.kind, entry.prefix, entry.text])).toEqual([
        ["tool_header", undefined, "- Waited"],
        ["tool", "  │ ", COMMAND],
        ["tool", "  └ ", "still running (2)"],
    ]);

    const setup = await createTestRenderer({ width: 64, height: 6 });
    const header = entries[0];
    const call = entries[1];
    const result = entries[2];
    setup.renderer.root.add(createTuiToolHeader(
        setup.renderer,
        "wait-expanded-header",
        header!,
        0,
    ));
    setup.renderer.root.add(createTuiToolRow(
        setup.renderer,
        "wait-expanded-call",
        call!,
        0,
    ));
    setup.renderer.root.add(createTuiToolRow(
        setup.renderer,
        "wait-expanded-result",
        result!,
        0,
    ));

    try {
        await setup.flush();
        const rows = frameRows(setup.captureCharFrame()).filter((row) =>
            row.trim().length > 0
        );
        const first = rows.findIndex((row) => row.includes("Waited"));
        expect(rows.slice(first, first + 3)).toEqual([
            "▾ Waited",
            `  │ ${COMMAND}`,
            "  └ still running (2)",
        ]);
    } finally {
        setup.renderer.destroy();
    }
});

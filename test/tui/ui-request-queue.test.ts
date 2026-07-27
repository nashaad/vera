import { expect, test } from "bun:test";

import { applyTuiUiRequestUpdate } from "../../clients/tui/ui-request-queue.ts";
import type { UiRequestUpdate } from "../../src/engine/protocol.ts";

function approval(id: string, seq: number): UiRequestUpdate {
    return {
        type: "ui_request",
        requestId: id,
        request: {
            type: "tool_approval",
            toolCall: { id: `call-${id}`, name: "bash", input: {} },
            reason: "Approval needed.",
            warning: "Runs with user permissions.",
        },
        seq,
    };
}

test("TUI queues simultaneous requests and advances in arrival order", () => {
    const queued: UiRequestUpdate[] = [];
    const first = approval("first", 1);
    const second = approval("second", 2);
    const third = approval("third", 3);

    let current = applyTuiUiRequestUpdate(undefined, queued, first);
    current = applyTuiUiRequestUpdate(current, queued, second);
    current = applyTuiUiRequestUpdate(current, queued, third);
    expect(current?.requestId).toBe("first");
    expect(queued.map((request) => request.requestId)).toEqual([
        "second",
        "third",
    ]);

    current = applyTuiUiRequestUpdate(current, queued, {
        type: "ui_request_closed",
        requestId: "first",
        seq: 4,
    });
    expect(current?.requestId).toBe("second");
    expect(queued.map((request) => request.requestId)).toEqual(["third"]);
});

test("TUI removes a queued request that closes before display", () => {
    const queued: UiRequestUpdate[] = [];
    const first = approval("first", 1);
    let current = applyTuiUiRequestUpdate(undefined, queued, first);
    current = applyTuiUiRequestUpdate(
        current,
        queued,
        approval("second", 2),
    );

    current = applyTuiUiRequestUpdate(current, queued, {
        type: "ui_request_closed",
        requestId: "second",
        seq: 3,
    });
    expect(current?.requestId).toBe("first");
    expect(queued).toEqual([]);
});

import { expect, test } from "bun:test";

import {
    applyTuiApprovalUpdate,
    createTuiApprovalResponse,
    renderTuiApproval,
    tuiApprovalDecision,
} from "../../clients/tui/approval.ts";
import type { UiRequestUpdate } from "../../src/engine/protocol.ts";

const request: UiRequestUpdate = {
    type: "ui_request",
    requestId: "request-1",
    request: {
        type: "tool_approval",
        toolCall: {
            id: "call-1",
            name: "bash",
            input: { command: "curl https://example.com" },
        },
        reason: "This command may access the network.",
        warning: "This command runs with your full user permissions.",
    },
    seq: 1,
};

test("TUI approval shows the exact command and honest warning", () => {
    expect(renderTuiApproval(request)).toBe([
        "$ curl https://example.com",
        "",
        "This command may access the network.",
        "This command runs with your full user permissions.",
        "",
        "[y] allow    [n/esc] deny",
    ].join("\n"));
});

test("TUI approval accepts explicit allow and deny keys", () => {
    expect(tuiApprovalDecision({ name: "y" })).toBe("allow");
    expect(tuiApprovalDecision({ name: "n" })).toBe("deny");
    expect(tuiApprovalDecision({ name: "escape" })).toBe("deny");
    expect(tuiApprovalDecision({ name: "y", ctrl: true })).toBeUndefined();
    expect(tuiApprovalDecision({ name: "return" })).toBeUndefined();
    expect(createTuiApprovalResponse(request, { name: "y" })).toEqual({
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow" },
    });
});

test("TUI approval closes only for its matching request ID", () => {
    expect(applyTuiApprovalUpdate(undefined, request)).toBe(request);
    expect(applyTuiApprovalUpdate(request, {
        type: "ui_request_closed",
        requestId: "another-request",
        seq: 2,
    })).toBe(request);
    expect(applyTuiApprovalUpdate(request, {
        type: "ui_request_closed",
        requestId: "request-1",
        seq: 3,
    })).toBeUndefined();
});

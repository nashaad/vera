import { expect, test } from "bun:test";

import {
    createStdioApprovalResponse,
    renderStdioApproval,
} from "../../clients/stdio/approval.ts";
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
        commandPrefix: { tokens: ["curl", "https://example.com"] },
    },
    seq: 1,
};

test("stdio approval shows the command and returns a typed answer", () => {
    expect(renderStdioApproval(request)).toContain(
        "$ curl https://example.com\nThis command may access the network.",
    );
    expect(createStdioApprovalResponse(request, "1")).toEqual({
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow_once" },
    });
    expect(createStdioApprovalResponse(request, "2").response).toEqual({
        type: "tool_approval",
        decision: "allow_prefix",
    });
    expect(createStdioApprovalResponse(request, "anything else").response)
        .toEqual({ type: "tool_approval", decision: "deny" });
    expect(createStdioApprovalResponse(request, undefined).response)
        .toEqual({ type: "tool_approval", decision: "deny" });
});

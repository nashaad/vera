import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    applyTuiApprovalUpdate,
    createTuiApprovalView,
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
        "[y] allow [n/esc] deny",
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

test("TUI approval pins its actions in short and narrow terminals", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 18,
        kittyKeyboard: true,
    });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(longRequest());
    view.focus();

    try {
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("Tool approval");
        expect(frame).toContain("$ grep");
        expect(frame).toContain("[y] allow [n/esc] deny");
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        expect(view.box.zIndex).toBe(20);
        expect(view.actions.screenY).toBeLessThan(18);

        setup.resize(42, 10);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("Tool approval");
        expect(frame).toContain("$ grep");
        expect(frame).toContain("[y] allow [n/esc] deny");
        expect(view.actions.screenY).toBeLessThan(10);
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(9);
        expect(view.details.scrollHeight).toBeGreaterThan(view.details.height);

        const actionsY = view.actions.screenY;
        setup.mockInput.pressKey("\x1b[6~");
        await setup.flush();
        expect(view.details.scrollTop).toBeGreaterThan(0);
        expect(view.actions.screenY).toBe(actionsY);
        expect(setup.captureCharFrame()).toContain(
            "[y] allow [n/esc] deny",
        );

        setup.resize(24, 6);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("[y] allow");
        expect(frame).toContain("[n/esc]");
        expect(frame).toContain("deny");
        expect(view.actions.screenY + view.actions.height).toBeLessThanOrEqual(5);
    } finally {
        setup.renderer.destroy();
    }
});

function longRequest(): UiRequestUpdate {
    return {
        ...request,
        request: {
            ...request.request,
            toolCall: {
                ...request.request.toolCall,
                input: {
                    command: `grep -rli -i "${"prompt.assembly|".repeat(20)}" /a/very/long/project/path --include="*.md"`,
                },
            },
        },
    };
}

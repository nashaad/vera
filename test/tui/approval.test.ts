import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    applyTuiApprovalUpdate,
    createTuiApprovalView,
    createTuiApprovalResponse,
    renderTuiApproval,
    tuiApprovalDecision,
} from "../../clients/tui/approval.ts";
import type {
    ToolApprovalUiRequestUpdate,
} from "../../src/engine/protocol.ts";

const request: ToolApprovalUiRequestUpdate = {
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
        permissionGrants: [{
            kind: "capability",
            when: { capability: "network", executable: "curl" },
            scope: "session",
            lifetime: "session",
        }],
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
        "Session grants: capability: capability=network, executable=curl",
        "",
        "1  Allow once",
        "2  Allow similar this session  capability: capability=network, executable=curl",
        "3  Deny  esc",
    ].join("\n"));
});

test("TUI approval accepts numeric once, similar, and deny keys", () => {
    expect(tuiApprovalDecision({ name: "1" })).toBe("allow_once");
    expect(tuiApprovalDecision({ name: "2" })).toBe("allow_similar");
    expect(tuiApprovalDecision({ name: "3" })).toBe("deny");
    expect(tuiApprovalDecision({ name: "escape" })).toBe("deny");
    expect(tuiApprovalDecision({ name: "1", ctrl: true })).toBeUndefined();
    expect(tuiApprovalDecision({ name: "return" })).toBeUndefined();
    expect(createTuiApprovalResponse(request, { name: "1" })).toEqual({
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow_once" },
    });
    expect(createTuiApprovalResponse(request, { name: "2" })).toEqual({
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow_similar" },
    });
});

test("TUI approval disables session grants when none can be derived", () => {
    const withoutGrants = {
        ...request,
        request: { ...request.request, permissionGrants: undefined },
    };
    expect(createTuiApprovalResponse(withoutGrants, { name: "2" }))
        .toBeUndefined();
    expect(renderTuiApproval(withoutGrants)).toContain(
        "2  Allow similar this session  not available for this command",
    );
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
        expect(frame).toContain("1  Allow once");
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        expect(view.box.zIndex).toBe(20);
        expect(view.actions.screenY).toBeLessThan(18);

        setup.resize(42, 10);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("Tool approval");
        expect(frame).toContain("$ grep");
        expect(frame).toContain("1  Allow once");
        expect(view.actions.screenY).toBeLessThan(10);
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(9);
        expect(view.details.scrollHeight).toBeGreaterThan(view.details.height);

        const actionsY = view.actions.screenY;
        setup.mockInput.pressKey("\x1b[6~");
        await setup.flush();
        expect(view.details.scrollTop).toBeGreaterThan(0);
        expect(view.actions.screenY).toBe(actionsY);
        expect(setup.captureCharFrame()).toContain(
            "1  Allow once",
        );

        setup.resize(24, 6);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("1  Allow once");
        expect(frame).toContain("3  Deny");
        expect(view.actions.screenY + view.actions.height).toBeLessThanOrEqual(5);
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI approval grows with content before details begin scrolling", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 18,
        kittyKeyboard: true,
    });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;

    try {
        view.update(requestWithCommand("pwd", "short-request"));
        await setup.flush();
        const shortHeight = view.box.height;
        expect(view.box.screenY + shortHeight).toBe(17);
        expect(view.details.scrollHeight).toBe(view.details.height);

        view.update(requestWithCommand(
            `grep ${"prompt.assembly|".repeat(8)}`,
            "medium-request",
        ));
        await setup.flush();
        const mediumHeight = view.box.height;
        expect(mediumHeight).toBeGreaterThan(shortHeight);
        expect(view.details.scrollHeight).toBe(view.details.height);

        view.update(requestWithCommand(
            `grep ${"prompt.assembly|".repeat(100)}`,
            "overflow-request",
        ));
        await setup.flush();
        expect(view.box.height).toBeGreaterThan(mediumHeight);
        expect(view.box.height).toBeLessThanOrEqual(16);
        expect(view.box.screenY + view.box.height).toBe(17);
        expect(view.details.scrollHeight).toBeGreaterThan(view.details.height);
        expect(setup.captureCharFrame()).toContain("1  Allow once");
    } finally {
        setup.renderer.destroy();
    }
});

function longRequest(): ToolApprovalUiRequestUpdate {
    return requestWithCommand(
        `grep -rli -i "${"prompt.assembly|".repeat(20)}" /a/very/long/project/path --include="*.md"`,
        "long-request",
    );
}

function requestWithCommand(
    command: string,
    requestId: string,
): ToolApprovalUiRequestUpdate {
    return {
        ...request,
        requestId,
        request: {
            ...request.request,
            toolCall: {
                ...request.request.toolCall,
                input: { command },
            },
        },
    };
}

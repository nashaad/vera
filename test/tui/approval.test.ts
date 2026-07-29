import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    applyTuiApprovalUpdate,
    createTuiApprovalView,
    createTuiApprovalResponse,
    renderTuiApproval,
    selectableApprovalKeys,
    tuiApprovalHint,
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
            kind: "command",
            when: { tool: "bash", executable: "curl" },
            scope: "session",
            lifetime: "session",
        }],
    },
    seq: 1,
};

test("TUI approval shows the exact command and honest warning", () => {
    expect(renderTuiApproval(request)).toBe([
        "Permission required · bash",
        "This command may access the network.",
        "",
        "$ curl https://example.com",
        "",
        "This command runs with your full user permissions.",
        "",
        // The predicate rides on the row that offers it rather than repeating
        // itself as a block above the answers.
        "1 Allow once  ·  2 Session curl  ·  3 Deny  ·  4 Always",
    ].join("\n"));
});

test("child approvals identify their agent and task", () => {
    const childRequest: ToolApprovalUiRequestUpdate = {
        ...request,
        request: {
            ...request.request,
            sourceAgentId: "12345678-aaaa-bbbb-cccc-123456789abc",
            sourceTask: "Run the focused tests",
            reason:
                "Permission mode ask requires ask: bash:unknown (ask.default).",
        },
    };

    expect(renderTuiApproval(childRequest)).toContain(
        "Requested by agent 12345678\nTask: Run the focused tests",
    );
    // A reason that only restates the header is dropped, the mode expression
    // with it.
    expect(renderTuiApproval(childRequest)).not.toContain("Permission mode");
    expect(renderTuiApproval(childRequest)).not.toContain("ask.default");
    expect(renderTuiApproval(childRequest)).not.toContain("Session");
    expect(renderTuiApproval(childRequest)).not.toContain("Always");
    expect(tuiApprovalHint(childRequest)).toBe(
        "approval required · 1 once · 3/esc deny · ctrl+c stop",
    );
    expect(tuiApprovalHint(request)).toContain("2 session prefix");
    expect(selectableApprovalKeys(childRequest)).toEqual(["1", "3"]);
    expect(createTuiApprovalResponse(childRequest, { name: "2" }))
        .toBeUndefined();
    expect(createTuiApprovalResponse(childRequest, { name: "4" }))
        .toBeUndefined();
});

test("TUI approval accepts numeric once, similar, and deny keys", () => {
    expect(tuiApprovalDecision({ name: "1" })).toBe("allow_once");
    expect(tuiApprovalDecision({ name: "2" })).toBe("allow_similar");
    expect(tuiApprovalDecision({ name: "3" })).toBe("deny");
    expect(tuiApprovalDecision({ name: "4" })).toBe("allow_always");
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
    expect(createTuiApprovalResponse(request, { name: "4" })).toEqual({
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow_always" },
    });
});

test("both remembering rows are unavailable without a derived predicate", () => {
    // No predicate means nothing honest to remember, in either tier. The
    // buttons stay rendered so the key numbering does not shift under the user.
    const noGrants: ToolApprovalUiRequestUpdate = {
        ...request,
        request: { ...request.request, permissionGrants: undefined },
    };
    expect(tuiApprovalDecision({ name: "2" }, false)).toBeUndefined();
    expect(tuiApprovalDecision({ name: "4" }, false)).toBeUndefined();
    const rendered = renderTuiApproval(noGrants);
    expect(rendered).toContain("2 Session");
    expect(rendered).toContain("4 Always");
    expect(rendered).toContain("Session and always are unavailable.");
    expect(selectableApprovalKeys(noGrants)).toEqual(["1", "3"]);
    expect(createTuiApprovalResponse(noGrants, { name: "4" }))
        .toBeUndefined();
});

test("arrow selection moves only across available buttons", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 18,
        kittyKeyboard: true,
    });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    const noGrants: ToolApprovalUiRequestUpdate = {
        ...request,
        requestId: "request-no-grants",
        request: { ...request.request, permissionGrants: undefined },
    };
    view.update(noGrants);

    try {
        // Only 1 and 3 are selectable, so a single → lands on Deny: the
        // unavailable session/always buttons are skipped, not stopped on.
        expect(view.handleKey(noGrants, { name: "right" }))
            .toEqual({ handled: true });
        const denied = view.handleKey(noGrants, { name: "return" });
        expect(denied.response).toEqual({
            type: "ui_response",
            requestId: "request-no-grants",
            response: { type: "tool_approval", decision: "deny" },
        });
        // ← from the first button stays put and still confirms Allow once.
        view.update(request);
        expect(view.handleKey(request, { name: "left" }))
            .toEqual({ handled: true });
        expect(view.handleKey(request, { name: "return" }).response).toEqual({
            type: "ui_response",
            requestId: "request-1",
            response: { type: "tool_approval", decision: "allow_once" },
        });
        // Digits keep answering directly regardless of the highlight.
        expect(view.handleKey(request, { name: "4" }).response).toEqual({
            type: "ui_response",
            requestId: "request-1",
            response: { type: "tool_approval", decision: "allow_always" },
        });
        expect(view.handleKey(request, { name: "a" }))
            .toEqual({ handled: false });

        // Up/down remain available to the focused details scroller.
        expect(view.handleKey(request, { name: "down" }))
            .toEqual({ handled: false });
        expect(view.handleKey(request, { name: "up" }))
            .toEqual({ handled: false });
    } finally {
        setup.renderer.destroy();
    }
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
        expect(frame).toContain("Permission required");
        expect(frame).toContain("$ grep");
        const lines = frame.split("\n");
        const headerLine = lines.find((line) =>
            line.includes("Permission required")
        );
        const commandLine = lines.find((line) => line.includes("$ grep"));
        expect(headerLine?.indexOf("Permission"))
            .toBe(commandLine?.indexOf("$"));
        expect(frame).toContain("1 Allow once");
        expect(frame).toContain("left/right select");
        expect(view.box.bottom).toBe(1);
        expect(view.box.width).toBe(77);
        expect(view.box.left).toBe(2);
        expect(frame.split("\n")[view.box.screenY + view.box.height - 1])
            .toBe(" ".repeat(80));
        expect(view.bar.screenY).toBe(view.box.screenY);
        expect(view.bar.height).toBe(view.box.height);
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        expect(view.box.zIndex).toBe(20);
        expect(view.actions.screenY).toBeLessThan(18);

        setup.resize(42, 12);
        // Geometry is re-read on update, so the resize goes through one.
        view.update(longRequest());
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(view.box.bottom).toBe(1);
        expect(view.box.width).toBe(39);
        expect(view.box.left).toBe(2);
        expect(frame).toContain("Permission required");
        expect(frame).toContain("$ grep");
        expect(frame).toContain("1 Allow once");
        // 42 columns cannot hold the button row, so it wraps rather than
        // clipping an answer off the screen.
        expect(frame).toContain("3 Deny");
        expect(frame).toContain("4 Always");
        expect(frame.split("\n")[view.box.screenY + view.box.height - 1])
            .toBe(" ".repeat(42));
        expect(view.actions.screenY).toBeLessThan(12);
        expect(view.details.scrollHeight).toBeGreaterThan(view.details.height);

        const actionsY = view.actions.screenY;
        setup.mockInput.pressKey("\x1b[6~");
        await setup.flush();
        expect(view.details.scrollTop).toBeGreaterThan(0);
        expect(view.actions.screenY).toBe(actionsY);
        expect(setup.captureCharFrame()).toContain("1 Allow once");

        setup.resize(30, 8);
        view.update(requestWithCommand("pwd", "short-terminal"));
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(view.box.left).toBe(0);
        expect(frame).toContain("1 Allow once");
        // Too narrow to carry the predicate, which the body states instead.
        expect(frame).toContain("2 Session ");
        expect(frame).not.toContain("2 Session curl");
        expect(frame).toContain("3 Deny");
        expect(frame).toContain("4 Always");
        expect(view.bar.visible).toBe(false);

        setup.resize(24, 6);
        view.update(requestWithCommand("pwd", "very-short-terminal"));
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).not.toContain("Permission required");
        expect(frame).toContain("1 Allow once");
        // Too narrow to carry the predicate, which the body states instead.
        expect(frame).toContain("2 Session ");
        expect(frame).not.toContain("2 Session curl");
        expect(frame).toContain("3 Deny");
        expect(frame).toContain("4 Always");
    } finally {
        setup.renderer.destroy();
    }
});

test("a predicate too long for its row is stated in the body", async () => {
    const path = "/private/var/folders/qs/72rgxnlj6djf0j_rwhx0l60m0000gn/T/vera/";
    const longScope: ToolApprovalUiRequestUpdate = {
        ...request,
        requestId: "long-scope",
        request: {
            ...request.request,
            toolCall: {
                id: "call-2",
                name: "write",
                input: { path: `${path}todo.md`, content: "# Internal todo\n" },
            },
            permissionGrants: [{
                kind: "path",
                when: { verb: "write", path },
                scope: "session",
                lifetime: "session",
            }],
        },
    };
    const setup = await createTestRenderer({
        width: 100,
        height: 20,
        kittyKeyboard: true,
    });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;

    try {
        view.update(longScope);
        await setup.flush();
        const frame = setup.captureCharFrame();
        // The answers stay a strip: the path is written once, above them.
        expect(frame).not.toContain(`2 Session write ${path}`);
        expect(frame).toContain("Session and always remember:");
        expect(frame).toContain(path);
        expect(frame).toContain("4 Always");
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
        expect(setup.captureCharFrame()).toContain("1 Allow once");
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

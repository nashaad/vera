import { expect, test } from "bun:test";
import { TextAttributes, type TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    applyTuiApprovalUpdate,
    createTuiApprovalView,
    renderTuiApproval,
    selectableApprovalKeys,
    tuiApprovalHint,
    type TuiApprovalSession,
} from "../../clients/tui/approval.ts";
import {
    activeTuiKeymap,
    installTuiKeymap,
    tuiBindingId,
} from "../../clients/tui/keymap.ts";
import type {
    ToolApprovalUiRequestUpdate,
} from "../../src/engine/protocol.ts";

const ask: TuiApprovalSession = {
    mode: "ask",
    modes: ["readonly", "ask", "auto"],
};

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

test("TUI approval shows the exact command, honest warning, and the ask answers in order", () => {
    expect(renderTuiApproval(request, ask)).toBe([
        "Run curl?",
        "This command may access the network.",
        "",
        "$ curl https://example.com",
        "",
        "This command runs with your full user permissions.",
        "",
        "1 Yes, for this chat",
        "2 Yes, and always allow curl commands",
        "3 Yes, and switch to Approve for me",
        "4 No",
    ].join("\n"));
});

test("TUI approval without a known mode leaves out the switch and leaves no gap", () => {
    expect(renderTuiApproval(request)).toBe([
        "Run curl?",
        "This command may access the network.",
        "",
        "$ curl https://example.com",
        "",
        "This command runs with your full user permissions.",
        "",
        "1 Yes, for this chat",
        "2 Yes, and always allow curl commands",
        "3 No",
    ].join("\n"));
});

test("child approvals identify their agent and task, and take only one-call answers", () => {
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

    expect(renderTuiApproval(childRequest, ask)).toContain(
        "Requested by agent 12345678\nTask: Run the focused tests",
    );
    // A reason that only restates the header is dropped, the mode expression
    // with it.
    expect(renderTuiApproval(childRequest, ask)).not.toContain("Permission mode");
    expect(renderTuiApproval(childRequest, ask)).not.toContain("ask.default");
    expect(renderTuiApproval(childRequest, ask)).not.toContain("Yes, for this chat");
    expect(renderTuiApproval(childRequest, ask)).not.toContain("always allow");
    expect(renderTuiApproval(childRequest, ask)).not.toContain("switch to Approve");
    expect(tuiApprovalHint(childRequest)).toBe(
        "approval required · Esc deny · Ctrl+C stop",
    );
    expect(tuiApprovalHint(request)).toBe(
        "approval required · Tab tell Vera · Esc deny · Ctrl+C stop",
    );
    expect(selectableApprovalKeys(childRequest, ask)).toEqual(["1", "2"]);
});

test("a restricted approval offers this time, no, and the typed answer", () => {
    const restricted: ToolApprovalUiRequestUpdate = {
        ...request,
        request: { ...request.request, restrictedChoices: true },
    };

    expect(selectableApprovalKeys(restricted, ask)).toEqual(["1", "2"]);
    expect(tuiApprovalHint(restricted)).toBe(
        "approval required · Tab tell Vera · Esc deny · Ctrl+C stop",
    );
    expect(renderTuiApproval(restricted, ask)).toContain("1 Yes, this time");
    expect(renderTuiApproval(restricted, ask)).not.toContain("for this chat");
    expect(renderTuiApproval(restricted, ask)).not.toContain("always allow");
    expect(renderTuiApproval(restricted, ask)).not.toContain("switch to Approve");
});

test("without a grant the first answer is this time and the switch still shows", () => {
    const noGrants: ToolApprovalUiRequestUpdate = {
        ...request,
        request: { ...request.request, permissionGrants: undefined },
    };
    expect(renderTuiApproval(noGrants, ask)).toBe([
        "Run this command?",
        "This command may access the network.",
        "",
        "$ curl https://example.com",
        "",
        "This command runs with your full user permissions.",
        "",
        "1 Yes, this time",
        "2 Yes, and switch to Approve for me",
        "3 No",
    ].join("\n"));
    expect(selectableApprovalKeys(noGrants, ask)).toEqual(["1", "2", "3"]);
});

test("TUI approval answers map to the rows in order", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 18,
        kittyKeyboard: true,
    });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(request, ask);
    const answer = (name: string) => view.handleKey(request, { name });

    try {
        expect(answer("1").response?.response).toEqual({
            type: "tool_approval",
            decision: "allow_similar",
        });
        expect(answer("2").response?.response).toEqual({
            type: "tool_approval",
            decision: "allow_always",
        });
        expect(answer("3")).toEqual({
            handled: true,
            response: {
                type: "ui_response",
                requestId: "request-1",
                response: { type: "tool_approval", decision: "allow_once" },
            },
            switchToAuto: true,
        });
        expect(answer("4").response?.response).toEqual({
            type: "tool_approval",
            decision: "deny",
        });
        expect(answer("5")).toEqual({ handled: false });
        expect(answer("a")).toEqual({ handled: false });
        expect(answer("escape").response?.response).toEqual({
            type: "tool_approval",
            decision: "deny",
        });
        expect(view.handleKey(request, { name: "1", ctrl: true }))
            .toEqual({ handled: false });
    } finally {
        setup.renderer.destroy();
    }
});

test("arrow selection walks every offered answer and stops at the edges", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 18,
        kittyKeyboard: true,
    });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(request, ask);

    try {
        expect(view.handleKey(request, { name: "up" })).toEqual({ handled: true });
        expect(view.handleKey(request, { name: "return" }).response?.response)
            .toEqual({ type: "tool_approval", decision: "allow_similar" });
        for (const _ of [1, 2]) view.handleKey(request, { name: "down" });
        expect(view.handleKey(request, { name: "return" }).response?.response)
            .toEqual({ type: "tool_approval", decision: "allow_once" });
        expect(view.handleKey(request, { name: "down" }).handled).toBe(true);
        expect(view.handleKey(request, { name: "return" }).response?.response)
            .toEqual({ type: "tool_approval", decision: "deny" });
        expect(view.handleKey(request, { name: "down" }).handled).toBe(true);
        expect(view.handleKey(request, { name: "return" }).response?.response)
            .toEqual({ type: "tool_approval", decision: "deny" });
        view.handleKey(request, { name: "left" });
        expect(view.handleKey(request, { name: "return" }).response?.response)
            .toEqual({ type: "tool_approval", decision: "allow_once" });
    } finally {
        setup.renderer.destroy();
    }
});

test("every offered row is bright; none is dimmed", async () => {
    const setup = await createTestRenderer({ width: 80, height: 18 });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    const attributes = () => (view.actions.getChildren()[0]!.getChildren() as TextRenderable[])
        .map((row) => row.attributes);

    try {
        view.update(request, ask);
        expect(attributes()).toEqual([
            TextAttributes.BOLD,
            TextAttributes.NONE,
            TextAttributes.NONE,
            TextAttributes.NONE,
        ]);
    } finally {
        setup.renderer.destroy();
    }
});

test("Tab opens the typed answer and Escape returns to the list", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 18,
        kittyKeyboard: true,
    });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(request, ask);

    try {
        expect(view.handleKey(request, { name: "tab" })).toEqual({ handled: true });
        expect(setup.renderer.currentFocusedRenderable?.id)
            .toBe("approval-notes");
        expect(view.handleKey(request, { name: "tab" })).toEqual({ handled: true });
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        expect(view.handleKey(request, { name: "tab" })).toEqual({ handled: true });
        expect(view.handleKey(request, { name: "escape" })).toEqual({ handled: true });
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        // A subagent's call has no typed answer, so Tab stays on the list.
        const child: ToolApprovalUiRequestUpdate = {
            ...request,
            request: { ...request.request, sourceAgentId: "agent-1" },
        };
        view.update(child, ask);
        view.handleKey(child, { name: "tab" });
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
    } finally {
        setup.renderer.destroy();
    }
});

test("modified approval chords pass through to their global owners", async () => {
    const setup = await createTestRenderer({ width: 100, height: 22, kittyKeyboard: true });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(longRequest(), ask);
    view.focus();

    try {
        const cases = [
            { key: { name: "tab", shift: true }, owner: "dials.open" },
            { key: { name: "tab", ctrl: true }, owner: undefined },
            { key: { name: "r", ctrl: true, option: true }, owner: undefined },
        ];
        for (const { key, owner } of cases) {
            expect(tuiBindingId("global", key)).toBe(owner);
            expect(view.handleKey(longRequest(), key)).toEqual({ handled: false });
            expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        }
        expect(view.handleKey(longRequest(), { name: "tab" })).toEqual({ handled: true });
        for (const { key } of cases) {
            expect(view.handleKey(longRequest(), key)).toEqual({ handled: false });
            expect(setup.renderer.currentFocusedRenderable?.id).toBe("approval-notes");
        }
    } finally {
        setup.renderer.destroy();
    }
});

test("approval follows installed binding changes", async () => {
    const original = activeTuiKeymap();
    const setup = await createTestRenderer({ width: 100, height: 22, kittyKeyboard: true });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(longRequest(), ask);
    view.focus();

    try {
        installTuiKeymap(original.map((binding) => {
            if (binding.id === "approval_notes") return { ...binding, keys: ["ctrl+j"] };
            if (binding.id === "expand_call") return { ...binding, keys: ["ctrl+k"] };
            return binding;
        }));
        const multiline = requestWithCommand(
            Array.from({ length: 25 }, (_, index) => `echo crow-${index}`).join("\n"),
            "multiline-request",
        );
        expect(renderTuiApproval(multiline, ask)).toContain("Ctrl+K expand");
        expect(tuiApprovalHint(multiline)).toContain("Ctrl+J tell Vera");
        expect(view.handleKey(longRequest(), { name: "tab" })).toEqual({ handled: false });
        expect(view.handleKey(longRequest(), { name: "j", ctrl: true })).toEqual({ handled: true });
        expect(setup.renderer.currentFocusedRenderable?.id).toBe("approval-notes");
        expect(view.handleKey(longRequest(), { name: "r", ctrl: true })).toEqual({ handled: false });
        expect(view.handleKey(longRequest(), { name: "k", ctrl: true })).toEqual({ handled: true });
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Ctrl+K collapse");
        expect(view.handleKey(longRequest(), { name: "j", ctrl: true })).toEqual({ handled: true });
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Ctrl+J to tell Vera what to do instead");
    } finally {
        installTuiKeymap(original);
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
    view.update(longRequest(), ask);
    view.focus();

    try {
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("Run curl?");
        expect(frame).toContain("$ grep");
        const lines = frame.split("\n");
        const headerLine = lines.find((line) => line.includes("Run curl?"));
        const commandLine = lines.find((line) => line.includes("$ grep"));
        expect(headerLine?.indexOf("Run"))
            .toBe(commandLine?.indexOf("$"));
        expect(frame).toContain("1 Yes, for this chat");
        expect(frame).toContain("2 Yes, and always allow curl commands");
        expect(frame).toContain("Tab to tell Vera what to do instead · Esc to deny");
        expect(view.box.bottom).toBe(0);
        expect(view.box.width).toBe(80);
        expect(view.box.left).toBe(0);
        expect(frame.split("\n")[view.box.screenY + view.box.height - 1])
            .toBe(`┃${" ".repeat(79)}`);
        expect(view.bar.screenY).toBe(view.box.screenY);
        expect(view.bar.height).toBe(view.box.height);
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        expect(view.box.zIndex).toBe(20);
        expect(view.actions.screenY).toBeLessThan(18);

        setup.resize(42, 12);
        // Geometry is re-read on update, so the resize goes through one.
        view.update(longRequest(), ask);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(view.box.bottom).toBe(0);
        expect(view.box.width).toBe(42);
        expect(view.box.left).toBe(0);
        expect(frame).toContain("Run curl?");
        expect(frame).toContain("$ grep");
        expect(frame).toContain("1 Yes, for this chat");
        expect(frame).toContain("2 Yes, and always allow");
        expect(frame.split("\n")[view.box.screenY + view.box.height - 1])
            .toBe(`┃${" ".repeat(41)}`);
        expect(view.actions.screenY).toBeLessThan(12);
        expect(view.details.scrollHeight).toBeGreaterThan(view.details.height);

        const actionsY = view.actions.screenY;
        setup.mockInput.pressKey("\x1b[6~");
        await setup.flush();
        expect(view.details.scrollTop).toBeGreaterThan(0);
        expect(view.actions.screenY).toBe(actionsY);
        expect(setup.captureCharFrame()).toContain("1 Yes, for this chat");

        setup.resize(30, 8);
        view.update(requestWithCommand("pwd", "short-terminal"), ask);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(view.box.left).toBe(0);
        expect(frame).toContain("1 Yes, for this chat");
        expect(frame).toContain("2 Yes, and always");
        // Answer rows win over the footer when the terminal is this short.
        expect(frame).not.toContain("Tab to tell");
        expect(view.bar.visible).toBe(false);

        setup.resize(24, 6);
        view.update(requestWithCommand("pwd", "very-short-terminal"), ask);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).not.toContain("Run curl?");
        expect(frame).toContain("1 Yes, for");
        expect(frame).toContain("2 Yes, and");
    } finally {
        setup.renderer.destroy();
    }
});

test("the always allow row names the file and the body does not repeat it", async () => {
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
                kind: "action",
                when: { verb: "write", path: `${path}todo.md` },
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
        view.update(longScope, ask);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("2 Yes, and always allow writing todo.md");
        expect(frame).not.toContain("remember:");
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI approval grows with content before details begin scrolling", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 22,
        kittyKeyboard: true,
    });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;

    try {
        view.update(requestWithCommand("pwd", "short-request"), ask);
        await setup.flush();
        const shortHeight = view.box.height;
        expect(view.box.screenY + shortHeight).toBe(22);
        expect(view.details.scrollHeight).toBe(view.details.height);

        view.update(requestWithCommand(
            `grep ${"prompt.assembly|".repeat(8)}`,
            "medium-request",
        ), ask);
        await setup.flush();
        const mediumHeight = view.box.height;
        expect(mediumHeight).toBeGreaterThan(shortHeight);
        expect(view.details.scrollHeight).toBe(view.details.height);

        view.update(requestWithCommand(
            `grep ${"prompt.assembly|".repeat(100)}`,
            "overflow-request",
        ), ask);
        await setup.flush();
        expect(view.box.height).toBeGreaterThan(mediumHeight);
        expect(view.box.height).toBeLessThanOrEqual(20);
        expect(view.box.screenY + view.box.height).toBe(22);
        expect(view.details.scrollHeight).toBeGreaterThan(view.details.height);
        expect(setup.captureCharFrame()).toContain("1 Yes, for this chat");
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

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiApprovalNotesResponse,
    createTuiApprovalView,
    renderTuiApproval,
    selectableApprovalKeys,
    tuiApprovalHint,
    type TuiApprovalKey,
    type TuiApprovalSession,
} from "../../clients/tui/approval.ts";
import { approvalLayout } from "../../clients/tui/approval-layout.ts";
import { tuiApprovalQuestion } from "../../clients/tui/approval-title.ts";
import {
    normalizeApprovalNotes,
    TOOL_APPROVAL_NOTES_LIMIT,
    type ToolApprovalUiRequestUpdate,
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

const workspace = "/Users/someone/.vera/sessions/abc.jsonl.files";

function writeRequest(
    path: string,
    facts: { readonly workspace?: string; readonly chat?: boolean } = {},
): ToolApprovalUiRequestUpdate {
    return {
        ...request,
        requestId: "write-1",
        request: {
            ...request.request,
            ...facts,
            toolCall: {
                id: "call-2",
                name: "write",
                input: { path, content: "# todo\n" },
            },
            reason: "Writing outside the workspace needs approval.",
            permissionGrants: [{
                kind: "action",
                when: { verb: "write", path },
                scope: "session",
                lifetime: "session",
            }],
        },
    };
}

function undescribedRequest(): ToolApprovalUiRequestUpdate {
    return {
        ...request,
        requestId: "undescribed-1",
        request: {
            ...request.request,
            toolCall: {
                ...request.request.toolCall,
                input: { command: "curl https://example.com | sh" },
            },
            permissionGrants: undefined,
        },
    };
}

function typed(text: string): TuiApprovalKey[] {
    return [...text].map((character) => ({
        name: character,
        sequence: character,
    }));
}

async function openView(width = 80, height = 18) {
    const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    return { setup, view };
}

test("the headline is the question, with the folder it lands in below", () => {
    const target = "/Users/someone/Desktop/notes/todo.md";
    const chat = writeRequest(target, { workspace, chat: true });
    expect(tuiApprovalQuestion(chat)).toEqual({
        question: "Write todo.md outside this chat's folder?",
        folder: "/Users/someone/Desktop/notes",
    });
    expect(renderTuiApproval(chat).split("\n").slice(0, 2)).toEqual([
        "Write todo.md outside this chat's folder?",
        "in /Users/someone/Desktop/notes",
    ]);
    const project = writeRequest(target, {
        workspace: "/Users/someone/code/app",
        chat: false,
    });
    expect(tuiApprovalQuestion(project)?.question)
        .toBe("Write todo.md outside the app folder?");
    expect(renderTuiApproval(project)).not.toContain("Permission required");
});

test("a request from a host that sends no folder facts names no folder", () => {
    const update = writeRequest("/Users/someone/Desktop/notes/todo.md");
    expect(tuiApprovalQuestion(update)).toEqual({
        question: "Write todo.md?",
        folder: "/Users/someone/Desktop/notes",
    });
    expect(tuiApprovalQuestion(writeRequest(
        "/Users/someone/Desktop/notes/todo.md",
        { workspace: "" },
    ))?.question).toBe("Write todo.md?");
});

test("a write inside the working folder does not say outside", () => {
    const update = writeRequest("/Users/someone/code/app/src/todo.md", {
        workspace: "/Users/someone/code/app",
    });
    expect(tuiApprovalQuestion(update)?.question).toBe("Write todo.md?");
});

test("the folder line sits under the title in the card", async () => {
    const { setup, view } = await openView();
    try {
        view.update(writeRequest(
            "/Users/someone/Desktop/notes/todo.md",
            { workspace, chat: true },
        ));
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const title = lines.findIndex((line) =>
            line.includes("Write todo.md outside this chat's folder?"));
        expect(title).toBeGreaterThanOrEqual(0);
        expect(lines[title + 1]).toContain("in /Users/someone/Desktop/notes");
    } finally {
        setup.renderer.destroy();
    }
});

test("a call the grants cannot describe keeps the tool title and has no folder line", () => {
    const update: ToolApprovalUiRequestUpdate = {
        ...request,
        request: {
            ...request.request,
            toolCall: { id: "call-3", name: "custom_tool", input: {} },
            permissionGrants: undefined,
            workspace,
            chat: true,
        },
    };
    expect(tuiApprovalQuestion(update)).toBeUndefined();
    const rendered = renderTuiApproval(update);
    expect(rendered.split("\n")[0]).toBe("Permission required · custom_tool");
    expect(rendered).not.toContain("\nin ");
});

test("a shell command the grants cannot describe asks to run this command", () => {
    expect(tuiApprovalQuestion(undescribedRequest())?.question)
        .toBe("Run this command?");
});

test("an eval approval asks about the script in the Browser pane", () => {
    const evalRequest: ToolApprovalUiRequestUpdate = {
        ...request,
        requestId: "eval-1",
        request: {
            ...request.request,
            toolCall: {
                id: "call-4",
                name: "builtin_browser_eval",
                input: { script: "return document.title" },
            },
            reason: "Running a script needs approval.",
            warning: "",
            permissionGrants: [{
                kind: "action",
                when: { operation: "desktop.browser.eval" },
                scope: "session",
                lifetime: "session",
            }],
        },
    };
    expect(tuiApprovalQuestion(evalRequest)).toEqual({
        question: "Run a script in the Browser pane?",
    });
    const rendered = renderTuiApproval(evalRequest);
    expect(rendered.split("\n")[0]).toBe("Run a script in the Browser pane?");
    expect(rendered).toContain("return document.title");
});

test("the command appears exactly once", async () => {
    const update = undescribedRequest();
    const text = renderTuiApproval(update);
    expect(text.split("curl https://example.com | sh").length - 1).toBe(1);
    const { setup, view } = await openView();
    try {
        view.update(update);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame.split("curl https://example.com | sh").length - 1).toBe(1);
    } finally {
        setup.renderer.destroy();
    }
});

test("Tab opens a line to type in and Enter denies with what was typed", async () => {
    const { setup, view } = await openView();
    try {
        view.update(request, ask);
        view.focus();
        expect(view.handleKey(request, { name: "tab" })).toEqual({ handled: true });
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("enter send");
        expect(frame).toContain("esc back");
        for (const key of typed("use rg instead")) {
            expect(view.handleKey(request, key).response).toBeUndefined();
        }
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("use rg instead");
        expect(view.handleKey(request, { name: "return" }).response).toEqual({
            type: "ui_response",
            requestId: "request-1",
            response: {
                type: "tool_approval",
                decision: "deny",
                notes: "use rg instead",
            },
        });
    } finally {
        setup.renderer.destroy();
    }
});

test("Ctrl+R expands and collapses the call on the list and in the line", async () => {
    const update: ToolApprovalUiRequestUpdate = {
        ...request,
        requestId: "long-call",
        request: {
            ...request.request,
            toolCall: {
                ...request.request.toolCall,
                input: { command: Array.from({ length: 25 }, (_, i) => `echo crow-${i}`).join("\n") },
            },
        },
    };
    const { setup, view } = await openView(100, 22);
    try {
        view.update(update, ask);
        view.focus();
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Ctrl+R expand");
        expect(view.handleKey(update, { name: "r", ctrl: true })).toEqual({ handled: true });
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Ctrl+R collapse");
        expect(view.handleKey(update, { name: "r", ctrl: true })).toEqual({ handled: true });
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Ctrl+R expand");
        expect(view.handleKey(update, { name: "tab" })).toEqual({ handled: true });
        expect(view.handleKey(update, { name: "r", ctrl: true })).toEqual({ handled: true });
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Ctrl+R collapse");
        expect(view.handleKey(update, { name: "r", ctrl: true })).toEqual({ handled: true });
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Ctrl+R expand");
        expect(view.handleKey(update, { name: "q", ctrl: true })).toEqual({ handled: false });
    } finally {
        setup.renderer.destroy();
    }
});

test("Escape in the line goes back to the answers without answering", async () => {
    const { setup, view } = await openView();
    try {
        view.update(request, ask);
        view.focus();
        view.handleKey(request, { name: "tab" });
        for (const key of typed("half a thought")) view.handleKey(request, key);
        const escaped = view.handleKey(request, { name: "escape" });
        expect(escaped).toEqual({ handled: true });
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).not.toContain("half a thought");
        expect(frame).toContain("Tab to tell Vera what to do instead · Esc to deny");
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        // Back on the answers, so Escape denies again and 1 allows for this chat.
        expect(view.handleKey(request, { name: "1" }).response?.response)
            .toEqual({ type: "tool_approval", decision: "allow_similar" });
        view.handleKey(request, { name: "tab" });
        for (const key of typed("again")) view.handleKey(request, key);
        view.handleKey(request, { name: "escape" });
        expect(view.handleKey(request, { name: "escape" }).response?.response)
            .toEqual({ type: "tool_approval", decision: "deny" });
    } finally {
        setup.renderer.destroy();
    }
});

test("digits typed in the line are text and do not pick an answer", async () => {
    const { setup, view } = await openView();
    try {
        view.update(request, ask);
        view.focus();
        view.handleKey(request, { name: "tab" });
        for (const digit of ["1", "2", "3", "4", "5"]) {
            expect(view.handleKey(request, { name: digit, sequence: digit }).response)
                .toBeUndefined();
        }
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("12345");
        expect(view.handleKey(request, { name: "return" }).response?.response)
            .toEqual({ type: "tool_approval", decision: "deny", notes: "12345" });
    } finally {
        setup.renderer.destroy();
    }
});

test("an empty or blank line sends nothing", async () => {
    const { setup, view } = await openView();
    try {
        view.update(request, ask);
        view.focus();
        view.handleKey(request, { name: "tab" });
        expect(view.handleKey(request, { name: "return" }))
            .toEqual({ handled: true });
        for (const key of typed("   ")) view.handleKey(request, key);
        expect(view.handleKey(request, { name: "return" }))
            .toEqual({ handled: true });
        expect(createTuiApprovalNotesResponse(request, "  \n ")).toBeUndefined();
    } finally {
        setup.renderer.destroy();
    }
});

test("typed and pasted text stops at the notes limit", async () => {
    const { setup, view } = await openView(100, 20);
    try {
        view.update(request, ask);
        view.focus();
        view.handleKey(request, { name: "tab" });
        expect(view.handlePaste("a".repeat(TOOL_APPROVAL_NOTES_LIMIT - 1))).toBe(true);
        for (const key of typed("bcd")) view.handleKey(request, key);
        expect(view.handlePaste("efgh")).toBe(true);
        const response = view.handleKey(request, { name: "return" }).response;
        const notes = response?.response.type === "tool_approval"
            ? response.response.notes
            : undefined;
        expect(notes).toBe(`${"a".repeat(TOOL_APPROVAL_NOTES_LIMIT - 1)}b`);
        expect(notes?.length).toBe(TOOL_APPROVAL_NOTES_LIMIT);
    } finally {
        setup.renderer.destroy();
    }
});

test("a paste outside the line is left to the caller", async () => {
    const { setup, view } = await openView();
    try {
        view.update(request, ask);
        expect(view.handlePaste("hello")).toBe(false);
    } finally {
        setup.renderer.destroy();
    }
});

test("the notes are trimmed before they are sent", () => {
    expect(normalizeApprovalNotes("  keep it small \n")).toBe("keep it small");
    expect(createTuiApprovalNotesResponse(request, "  keep it small \n"))
        .toEqual({
            type: "ui_response",
            requestId: "request-1",
            response: {
                type: "tool_approval",
                decision: "deny",
                notes: "keep it small",
            },
        });
});

test("only the typed answer sends notes; every listed answer leaves them off", async () => {
    const { setup, view } = await openView();
    try {
        view.update(request, ask);
        view.focus();
        for (const name of ["1", "2", "3", "4", "escape"]) {
            const answered = view.handleKey(request, { name }).response?.response;
            expect(answered).toBeDefined();
            expect(answered).not.toHaveProperty("notes");
        }
        // Enter on each of the four plain answers.
        for (const steps of [0, 1, 2, 3]) {
            const fresh = { ...request, requestId: `enter-${steps}` };
            view.update(fresh, ask);
            for (let step = 0; step < steps; step += 1) {
                view.handleKey(fresh, { name: "down" });
            }
            const answered = view.handleKey(fresh, { name: "return" }).response?.response;
            expect(answered).toBeDefined();
            expect(answered).not.toHaveProperty("notes");
        }
    } finally {
        setup.renderer.destroy();
    }
});

test("a subagent's approval has no typed answer and cannot send notes", async () => {
    const child: ToolApprovalUiRequestUpdate = {
        ...request,
        requestId: "child-1",
        request: {
            ...request.request,
            sourceAgentId: "12345678-aaaa-bbbb-cccc-123456789abc",
            sourceTask: "Run the focused tests",
        },
    };
    expect(renderTuiApproval(child, ask)).not.toContain("to tell Vera");
    expect(selectableApprovalKeys(child, ask)).toEqual(["1", "2"]);
    expect(tuiApprovalHint(child)).not.toContain("tell Vera");
    expect(createTuiApprovalNotesResponse(child, "use rg instead")).toBeUndefined();

    const { setup, view } = await openView();
    try {
        view.update(child, ask);
        view.focus();
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain("to tell Vera");
        expect(view.handleKey(child, { name: "tab" })).toEqual({ handled: true });
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        // Down stops at No, the last answer a subagent offers, and Enter denies plainly.
        for (let step = 0; step < 6; step += 1) view.handleKey(child, { name: "down" });
        expect(view.handleKey(child, { name: "return" }).response?.response)
            .toEqual({ type: "tool_approval", decision: "deny" });
    } finally {
        setup.renderer.destroy();
    }
});

test("a classifier denial shows its reason before the action and takes no typed answer", async () => {
    const denied: ToolApprovalUiRequestUpdate = {
        ...request,
        requestId: "review-denied",
        request: {
            ...request.request,
            restrictedChoices: true,
            allowNotes: false,
            review: { decision: "deny", model: "reviewer-model", riskLevel: "high", reason: "The action is unsafe." },
        },
    };
    const message = "The classifier, reviewer-model, denied this. High risk: The action is unsafe.";
    const rendered = renderTuiApproval(denied, ask);
    expect(rendered).toContain(message);
    expect(rendered.indexOf(message)).toBeLessThan(rendered.indexOf("$ curl"));
    expect(selectableApprovalKeys(denied, ask)).toEqual(["1", "2"]);
    expect(tuiApprovalHint(denied)).not.toContain("tell Vera");
    expect(createTuiApprovalNotesResponse(denied, "do something else")).toBeUndefined();

    for (const [width, height] of [[100, 22], [42, 12]] as const) {
        const { setup, view } = await openView(width, height);
        try {
            view.update(denied, ask);
            view.focus();
            await setup.flush();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("The classifier, reviewer-model,");
            expect(frame).toContain("High risk:");
            expect(frame).toContain("1 Yes, this time");
            expect(frame).toContain("2 No");
            expect(frame).not.toContain("to tell Vera");
            expect(frame).not.toContain("always allow");
            const lines = frame.split("\n");
            const reason = lines.find((line) => line.includes("The classifier"));
            expect(reason?.indexOf("The classifier")).toBeGreaterThanOrEqual(2);
            expect(reason?.endsWith(" ")).toBe(true);
            view.handleKey(denied, { name: "tab" });
            expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
            expect(view.handleKey(denied, { name: "1" }).response?.response)
                .toEqual({ type: "tool_approval", decision: "allow_once" });
            expect(view.handleKey(denied, { name: "2" }).response?.response)
                .toEqual({ type: "tool_approval", decision: "deny" });
        } finally {
            setup.renderer.destroy();
        }
    }
});

test("the card keeps every answer on screen down to 40 columns and short heights", async () => {
    const update = writeRequest(
        "/Users/someone/Desktop/notes/todo.md",
        { workspace, chat: true },
    );
    for (const [width, height] of [
        [80, 18],
        [80, 12],
        [60, 14],
        [42, 13],
        [40, 10],
        [40, 8],
        [40, 6],
    ] as const) {
        const { setup, view } = await openView(width, height);
        try {
            view.update(update, ask);
            await setup.flush();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("1 Yes, for this chat");
            expect(frame).toContain("2 Yes, and always");
            expect(frame).toContain("3 Yes, and switch");
            expect(frame).toContain("4 No");
        } finally {
            setup.renderer.destroy();
        }
    }
});

test("the layout drops the folder line, then the hints, then the gap before an answer", () => {
    const base = {
        rows: 4,
        title: "Write todo.md outside this chat's folder?",
        folderLine: "in /Users/someone/Desktop/notes",
    };
    expect(approvalLayout({ ...base, width: 80, height: 22 }))
        .toEqual({ folder: true, hints: true, gap: 1 });
    // Hints need 60 columns.
    expect(approvalLayout({ ...base, width: 50, height: 30 }))
        .toEqual({ folder: true, hints: false, gap: 1 });
    // The folder line goes before the gap or an answer.
    expect(approvalLayout({ ...base, width: 80, height: 13 }))
        .toEqual({ folder: true, hints: false, gap: 1 });
    expect(approvalLayout({ ...base, width: 80, height: 11 }))
        .toEqual({ folder: false, hints: false, gap: 0 });
    // A short terminal never gets the folder line.
    expect(approvalLayout({ ...base, width: 80, height: 10 }).folder).toBe(false);
});

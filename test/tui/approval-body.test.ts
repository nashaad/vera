import { expect, test } from "bun:test";
import { fg } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    tuiApprovalBody,
    tuiApprovalBodyText,
    TUI_APPROVAL_BODY_LINES,
} from "../../clients/tui/approval-body.ts";
import {
    createTuiApprovalView,
    renderTuiApproval,
} from "../../clients/tui/approval.ts";
import {
    TUI_DIFF_ADDED,
    TUI_DIFF_REMOVED,
    TUI_MUTED,
} from "../../clients/tui/state.ts";
import type { ToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import type { JsonObject } from "../../src/sdk/hooks.ts";

function approval(
    name: string,
    input: JsonObject,
    requestId = "request-1",
): ToolApprovalUiRequestUpdate {
    return {
        type: "ui_request",
        requestId,
        request: {
            type: "tool_approval",
            toolCall: { id: "call-1", name, input },
            reason: "Permission mode ask requires ask.",
            warning: "If allowed, this command runs with your full user permissions.",
            permissionGrants: [{
                kind: "action",
                when: { tool: name, path: `${process.cwd()}/clients/tui` },
                scope: "session",
                lifetime: "session",
            }],
        },
        seq: 1,
    };
}

test("an edit is shown as its hunks, not as its JSON", () => {
    const body = tuiApprovalBodyText(approval("edit", {
        path: `${process.cwd()}/clients/tui/question.ts`,
        edits: [{ old_string: "const a = 1;", new_string: "const a = 2;" }],
    }));

    expect(body).toBe([
        // The workspace prefix is the same on every row, so it is not written.
        "clients/tui/question.ts",
        "- const a = 1;",
        "+ const a = 2;",
    ].join("\n"));
    expect(body).not.toContain("old_string");
});

test("an edit keeps unchanged lines as dimmed context around its hunks", () => {
    const body = tuiApprovalBody(approval("edit", {
        path: `${process.cwd()}/clients/tui/question.ts`,
        edits: [{
            old_string: "one\ntwo\nthree\nfour\nfive\nsix",
            new_string: "one\ntwo\nTHREE\nfour\nfive\nSIX",
        }],
    }));

    // Context lines carry one leading space and no marker; only the lines
    // actually removed and added carry theirs.
    expect(body.lines.map((line) => line.text)).toEqual([
        "clients/tui/question.ts",
        " one",
        " two",
        "- three",
        "+ THREE",
        " four",
        " five",
        "- six",
        "+ SIX",
    ]);
    const context = body.lines.filter((line) =>
        line.text.startsWith(" ") && line.text.trim() !== ""
    );
    expect(context.every((line) => line.tone === "muted")).toBe(true);
    expect(body.lines.find((line) => line.text === "- three")?.tone)
        .toBe("del");
    expect(body.lines.find((line) => line.text === "+ THREE")?.tone)
        .toBe("add");
});

test("a long unchanged run collapses behind a gap", () => {
    const block = [
        "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
        "k", "l", "m", "n",
    ];
    const changed = block.map((line) =>
        line === "c" ? "X" : line === "m" ? "Y" : line
    );
    const body = tuiApprovalBody(approval("edit", {
        path: `${process.cwd()}/clients/tui/question.ts`,
        edits: [{
            old_string: block.join("\n"),
            new_string: changed.join("\n"),
        }],
    }));

    // Each change keeps three lines of context; the three unchanged lines
    // between the clusters collapse behind one gap instead of being re-emitted.
    expect(body.lines.map((line) => line.text)).toEqual([
        "clients/tui/question.ts",
        " a",
        " b",
        "- c",
        "+ X",
        " d",
        " e",
        " f",
        " …",
        " j",
        " k",
        " l",
        "- m",
        "+ Y",
        " n",
    ]);
});

test("a diff is a diff regardless of theme: red removals, green additions", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(approval("edit", {
        path: `${process.cwd()}/clients/tui/question.ts`,
        edits: [{
            old_string: "one\ntwo\nthree",
            new_string: "one\nTWO\nthree",
        }],
    }));

    try {
        await setup.flush();
        const chunks = view.detailsText.content.chunks;
        const removed = chunks.find((chunk) => chunk.text.startsWith("- "));
        const added = chunks.find((chunk) => chunk.text.startsWith("+ "));
        const context = chunks.find((chunk) => chunk.text.startsWith(" "));
        // Removals and additions use the diff role colors, never the
        // notice/success palette; context is dimmed.
        expect(removed?.fg).toEqual(fg(TUI_DIFF_REMOVED)("").fg);
        expect(added?.fg).toEqual(fg(TUI_DIFF_ADDED)("").fg);
        expect(context?.fg).toEqual(fg(TUI_MUTED)("").fg);
    } finally {
        setup.renderer.destroy();
    }
});

test("a write is shown as its path and size", () => {
    expect(tuiApprovalBodyText(approval("write", {
        path: "/etc/hosts",
        content: "one\ntwo\n",
    }))).toBe([
        // Outside the workspace the absolute path is the part that matters.
        "/etc/hosts",
        "3 lines",
        // What lands in the file is the thing being approved, so it is shown.
        "+ one",
        "+ two",
        "+ ",
    ].join("\n"));
});

test("an unknown tool still falls back to its serialized call", () => {
    expect(tuiApprovalBodyText(approval("frobnicate", { level: 3 })))
        .toBe('frobnicate {"level":3}');
});

test("a long call is capped until it is expanded", () => {
    const edits = Array.from({ length: 20 }, (_, index) => ({
        old_string: `old ${index}`,
        new_string: `new ${index}`,
    }));
    const update = approval("edit", {
        path: `${process.cwd()}/clients/tui/question.ts`,
        edits,
    });

    const capped = tuiApprovalBody(update);
    expect(capped.hidden).toBeGreaterThan(0);
    expect(capped.lines).toHaveLength(TUI_APPROVAL_BODY_LINES + 1);
    expect(capped.lines.at(-1)?.text)
        .toBe(`… ${capped.hidden} more lines · Ctrl+R expand`);

    const expanded = tuiApprovalBody(update, true);
    expect(expanded.hidden).toBe(0);
    expect(expanded.lines.length)
        .toBe(capped.lines.length - 1 + capped.hidden);
});

test("ctrl+r expands the capped call in place", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const view = createTuiApprovalView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    const update = approval("edit", {
        path: `${process.cwd()}/clients/tui/question.ts`,
        edits: Array.from({ length: 20 }, (_, index) => ({
            old_string: `old ${index}`,
            new_string: `new ${index}`,
        })),
    });
    view.update(update);

    try {
        await setup.flush();
        // The count sits at the foot of the body, which is past the viewport.
        view.details.scrollTo(view.details.scrollHeight);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("more lines · Ctrl+R expand");
        expect(view.handleKey(update, { name: "r", ctrl: true }))
            .toEqual({ handled: true });
        view.details.scrollTo(view.details.scrollHeight);
        await setup.flush();
        expect(setup.captureCharFrame())
            .not.toContain("more lines · Ctrl+R expand");
    } finally {
        setup.renderer.destroy();
    }
});

test("a set of predicates is written out rather than summarized", () => {
    const update = approval("bash", { command: "curl https://example.com" });
    const single = {
        ...update,
        request: {
            ...update.request,
            permissionGrants: [{
                kind: "command" as const,
                when: {
                    tool: "bash",
                    executable: "curl",
                    path: `${process.cwd()}/clients`,
                },
                scope: "session" as const,
                lifetime: "session" as const,
            }],
        },
    };
    // One grant fits on the choice label, and every field of it is written
    // there: a label that named only the executable would understate the grant.
    expect(renderTuiApproval(single)).toContain("2 Session curl clients");
    expect(tuiApprovalBodyText(single)).not.toContain("remember");

    const many = {
        ...update,
        request: {
            ...update.request,
            permissionGrants: [
                ...single.request.permissionGrants,
                {
                    kind: "command" as const,
                    when: { tool: "bash", executable: "wget" },
                    scope: "session" as const,
                    lifetime: "session" as const,
                },
            ],
        },
    };
    expect(renderTuiApproval(many)).toContain("\n2 Session\n");
    expect(tuiApprovalBodyText(many)).toContain("Session and always remember:");
    // The tool name is implied by the executable, so it is not repeated.
    expect(tuiApprovalBodyText(many)).toContain("- wget");
});

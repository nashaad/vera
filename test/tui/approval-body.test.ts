import { beforeEach, expect, test } from "bun:test";
import { fg } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    tuiApprovalBody,
    tuiApprovalBodyText,
    tuiApprovalPath,
    tuiEditHunkLines,
    TUI_APPROVAL_BODY_LINES,
} from "../../clients/tui/approval-body.ts";
import {
    createTuiApprovalView,
    renderTuiApproval,
    type TuiApprovalSession,
} from "../../clients/tui/approval.ts";
import {
    setTuiWorkspaceRoot,
    TUI_DIFF_ADDED,
    TUI_DIFF_REMOVED,
    TUI_MUTED,
} from "../../clients/tui/state.ts";
import type { ToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import type { JsonObject } from "../../src/sdk/hooks.ts";

beforeEach(() => {
    setTuiWorkspaceRoot(process.cwd());
});

const ask: TuiApprovalSession = {
    mode: "ask",
    modes: ["readonly", "ask", "auto"],
};

function approval(
    name: string,
    input: JsonObject,
    requestId = "request-1",
): ToolApprovalUiRequestUpdate {    return {
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

test("an eval script is shown as its lines, not as JSON", () => {
    expect(tuiApprovalBodyText(approval("builtin_browser_eval", {
        script: "const rows = [...document.querySelectorAll('tr')];\nreturn rows.map((row) => row.innerText);",
    }))).toBe([
        "const rows = [...document.querySelectorAll('tr')];",
        "return rows.map((row) => row.innerText);",
    ].join("\n"));
});

test("a long eval script is capped until it is expanded", () => {
    const script = Array.from({ length: 20 }, (_, index) => `const x${index} = ${index};`).join("\n");
    const update = approval("builtin_browser_eval", { script });
    const capped = tuiApprovalBody(update);
    expect(capped.hidden).toBeGreaterThan(0);
    expect(capped.lines.at(-1)?.text).toContain("more lines");
    expect(tuiApprovalBody(update, true).lines.map((line) => line.text)).toEqual(script.split("\n"));
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

test("repeated edit approvals preserve complete and collapsed hunks after input changes", () => {
    const path = `${process.cwd()}/chart.txt`;
    const hunk = {
        old_string: Array.from({ length: 1500 }, (_, index) => `old ${index}`).join("\n"),
        new_string: Array.from({ length: 1500 }, (_, index) => `new ${index}`).join("\n"),
    };
    const update = approval("edit", { path, edits: [hunk] });
    const check = () => {
        const all = [
            { text: tuiApprovalPath(path), tone: "path" as const },
            ...tuiEditHunkLines(hunk.old_string, hunk.new_string),
        ];
        const hidden = Math.max(0, all.length - TUI_APPROVAL_BODY_LINES);
        expect(tuiApprovalBody(update, true)).toEqual({ lines: all, hidden: 0 });
        expect(tuiApprovalBody(update, false)).toEqual(hidden === 0
            ? { lines: all, hidden: 0 }
            : {
                lines: [
                    ...all.slice(0, TUI_APPROVAL_BODY_LINES),
                    { text: `… ${hidden} more lines · Ctrl+R expand`, tone: "muted" },
                ],
                hidden,
            });
    };
    check();
    check();
    const first = tuiApprovalBody(update, true);
    (first.lines[1] as { text: string }).text = "changed by a caller";
    check();
    hunk.old_string = "a\n--deck\nc\n";
    check();
    hunk.new_string = "a\n++sail\nc\n";
    check();
    const replacement = approval("edit", { path, edits: [{ old_string: "old", new_string: "new" }] });
    expect(tuiApprovalBody(replacement, true).lines.slice(1))
        .toEqual([...tuiEditHunkLines("old", "new")]);
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

test("the always-allow row carries the words and the body does not repeat them", () => {
    const update = approval("bash", { command: "curl https://example.com" });
    const single = {
        ...update,
        request: {
            ...update.request,
            permissionGrants: [{
                kind: "command" as const,
                when: { tool: "bash", executable: "curl" },
                scope: "session" as const,
                lifetime: "session" as const,
            }],
        },
    };
    expect(renderTuiApproval(single, ask))
        .toContain("2 Yes, and always allow curl commands");
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
    // Grants the words cannot describe fall back to the fixed phrase.
    expect(renderTuiApproval(many, ask))
        .toContain("2 Yes, and always allow actions like this");
    expect(tuiApprovalBodyText(many)).not.toContain("remember");
});

test("a described bash call is approved by its command alone", () => {
    const body = tuiApprovalBodyText(approval("bash", {
        command: "rm -rf build",
        description: "Tidy up a little",
    }));

    expect(body).toContain("rm -rf build");
    expect(body).not.toContain("Tidy up a little");
});

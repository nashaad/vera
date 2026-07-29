import { expect, test } from "bun:test";
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
        .toBe(`… ${capped.hidden} more lines · ctrl+r expand`);

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
        expect(setup.captureCharFrame()).toContain("more lines · ctrl+r expand");
        expect(view.handleKey(update, { name: "r", ctrl: true }))
            .toEqual({ handled: true });
        view.details.scrollTo(view.details.scrollHeight);
        await setup.flush();
        expect(setup.captureCharFrame())
            .not.toContain("more lines · ctrl+r expand");
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

import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolCallContent } from "../../src/model/types.ts";
import { markJustDone, parseChecklist } from "../../src/tools/checklist.ts";
import { executeToolCall } from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

test("checklist parsing reads task items and the first heading", () => {
    expect(parseChecklist([
        "# Raid the harbour",
        "",
        "Some prose that is not a task.",
        "- [x] Chart the reef",
        "* [ ] Steal the lantern",
        "1. [X] ~~Bribe the gulls~~",
        "- plain bullet",
        "## Later",
    ].join("\n"))).toEqual({
        title: "Raid the harbour",
        items: [
            { text: "Chart the reef", done: true },
            { text: "Steal the lantern", done: false },
            { text: "~~Bribe the gulls~~", done: true },
        ],
    });
    expect(parseChecklist("# Notes\n\n- plain bullet\n")).toBeUndefined();
    expect(parseChecklist("- [ ] untitled\n")).toEqual({
        items: [{ text: "untitled", done: false }],
    });
});

test("just-done marks items newly done, including ones reworded as they were ticked", () => {
    const before = [
        { text: "Chart the reef", done: true },
        { text: "Steal the lantern", done: false },
        { text: "Bribe the gulls", done: false },
    ];
    const after = [
        { text: "Chart the reef", done: true },
        { text: "Steal the lantern; it was brass", done: true },
        { text: "~~Bribe the gulls~~", done: true },
    ];
    expect(markJustDone(before, after)).toEqual([
        { text: "Chart the reef", done: true },
        { text: "Steal the lantern; it was brass", done: true, justDone: true },
        { text: "~~Bribe the gulls~~", done: true, justDone: true },
    ]);
});

test("scratch task lists present as checklists; other scratch writes as scratch diffs", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "vera-ws-")));
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "vera-scratch-")));
    const runtime = new ToolRuntime(
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        scratch,
    );
    const todo = join(scratch, "todo.md");
    try {
        const created = await executeToolCall(toolCall("c1", "write", {
            path: todo,
            content: "# Raid\n\n- [x] Chart the reef\n- [ ] Steal the lantern\n",
        }), runtime);
        expect(created.presentation).toEqual({
            kind: "checklist",
            path: todo,
            title: "Raid",
            items: [
                { text: "Chart the reef", done: true },
                { text: "Steal the lantern", done: false },
            ],
        });

        const ticked = await executeToolCall(toolCall("c2", "edit", {
            path: todo,
            edits: [{
                old_string: "- [ ] Steal the lantern",
                new_string: "- [x] Steal the lantern",
            }],
        }), runtime);
        expect(ticked.presentation).toEqual({
            kind: "checklist",
            path: todo,
            title: "Raid",
            items: [
                { text: "Chart the reef", done: true },
                { text: "Steal the lantern", done: true, justDone: true },
            ],
        });

        const notes = await executeToolCall(toolCall("c3", "write", {
            path: join(scratch, "findings.md"),
            content: "The gulls take bribes.\n",
        }), runtime);
        expect(notes.presentation).toMatchObject({
            kind: "unified_diff",
            scratch: true,
        });

        const userFile = await executeToolCall(toolCall("c4", "write", {
            path: "todo.md",
            content: "- [ ] A user's own list\n",
        }), runtime);
        expect(userFile.presentation?.kind).toBe("unified_diff");
        expect(userFile.presentation).not.toHaveProperty("scratch");
    } finally {
        await rm(workspace, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
    }
});

function toolCall(
    id: string,
    name: string,
    input: Readonly<Record<string, unknown>>,
): ToolCallContent {
    return { type: "tool_call", id, name, input };
}

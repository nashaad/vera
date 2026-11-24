import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../../clients/ui/src/session/Markdown.tsx";
import { CallList, RunLine } from "../../clients/ui/src/session/ToolRuns.tsx";
import { entriesToBlocks } from "../../clients/ui/src/session/transcript.ts";

test("retains received projected ids within grouped calls and text", () => {
    const blocks = entriesToBlocks([
        { kind: "user", id: "user", text: "crow" },
        { kind: "assistant", id: "source#0", text: "ahoy" },
        { kind: "reasoning", id: "source#r1", text: "think" },
        { kind: "tool", id: "source#1", tool: "read", args: { path: "a" } },
        { kind: "tool", id: "other#0", tool: "bash", args: { command: "echo crow" } },
        { kind: "tool", tool: "read", args: { path: "b" } },
    ]);
    expect(blocks.slice(0, 3).map((block) => "entryId" in block ? block.entryId : undefined)).toEqual(["user", "source#0", "source#r1"]);
    const group = blocks[3];
    if (group?.kind !== "tools") throw new Error("expected tool group");
    expect(group.calls.map((call) => call.entryId)).toEqual(["source#1", "other#0", undefined]);
    const rows = renderToStaticMarkup(createElement(CallList, { calls: group.calls }));
    expect(rows).toContain('data-find-entry="source#1"');
    expect(rows).toContain('data-find-entry="other#0"');
    expect(rows.match(/data-find-entry=/g)).toHaveLength(2);
    const collapsed = renderToStaticMarkup(createElement(RunLine, { calls: group.calls }));
    expect(collapsed).not.toContain("data-find-entry");
    expect(collapsed).not.toContain("echo crow");
});

test("markdown exposes only a supplied entry id", () => {
    expect(renderToStaticMarkup(createElement(Markdown, { text: "crow", entryId: "source#2" }))).toContain('data-find-entry="source#2"');
    expect(renderToStaticMarkup(createElement(Markdown, { text: "crow" }))).not.toContain("data-find-entry");
});

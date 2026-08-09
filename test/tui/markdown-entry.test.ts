import { expect, test } from "bun:test";
import { MarkdownRenderable, SyntaxStyle } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiMarkdownEntry } from "../../clients/tui/markdown-entry.ts";

test("background completions render finished Markdown", async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const syntaxStyle = SyntaxStyle.fromStyles({});
    const node = createTuiMarkdownEntry(
        setup.renderer,
        "background-completion",
        {
            kind: "notification",
            text: "Async subagent child-1:\n\n## Summary\n\n- **Tests pass.**",
        },
        syntaxStyle,
        "#ffffff",
        0,
    );
    expect(node).toBeDefined();
    try {
        expect(node).toBeInstanceOf(MarkdownRenderable);
        expect(node!.content).toContain("## Summary");
        expect(node!.getChildren().length).toBeGreaterThan(0);
        expect(node!.streaming).toBe(false);
    } finally {
        node?.destroy();
        syntaxStyle.destroy();
        setup.renderer.destroy();
    }
});

test("assistant Markdown remains streaming until turn completion", async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const syntaxStyle = SyntaxStyle.fromStyles({});
    const node = createTuiMarkdownEntry(
        setup.renderer,
        "assistant",
        { kind: "assistant", text: "Still writing" },
        syntaxStyle,
        "#ffffff",
        0,
    );

    try {
        expect(node?.streaming).toBe(true);
    } finally {
        node?.destroy();
        syntaxStyle.destroy();
        setup.renderer.destroy();
    }
});

test("a final answer can begin with a pane-width section rule", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const syntaxStyle = SyntaxStyle.fromStyles({});
    const node = createTuiMarkdownEntry(
        setup.renderer,
        "separated-assistant",
        { kind: "assistant", text: "Final answer" },
        syntaxStyle,
        "#ffffff",
        0,
        true,
    );
    setup.renderer.root.add(node!);

    try {
        await setup.flush();
        await Bun.sleep(50);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Final answer");
        expect(frame).toContain("─".repeat(40));
    } finally {
        node?.destroy();
        syntaxStyle.destroy();
        setup.renderer.destroy();
    }
});

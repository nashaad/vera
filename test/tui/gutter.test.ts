import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiGutterEntry } from "../../clients/tui/gutter.ts";

async function frameFor(ruled: boolean): Promise<string> {
    const setup = await createTestRenderer({ width: 30, height: 6 });
    const content = new TextRenderable(setup.renderer, {
        id: "content",
        content: "Final answer",
        flexGrow: 1,
    });
    const node = createTuiGutterEntry(
        setup.renderer,
        "answer",
        { kind: "assistant", text: "Final answer" },
        content,
        0,
        ruled,
    );
    setup.renderer.root.add(node);
    try {
        await setup.flush();
        return setup.captureCharFrame();
    } finally {
        node.destroy();
        setup.renderer.destroy();
    }
}

test("a rule takes its own row and leaves the marker beside the answer", async () => {
    const lines = (await frameFor(true)).split("\n");
    const rule = lines.findIndex((line) => line.includes("──────────"));
    const answer = lines.findIndex((line) => line.includes("Final answer"));

    expect(rule).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThan(rule);
    expect(lines[rule]).not.toContain("●");
    expect(lines[answer]).toContain("●");
});

test("an unruled block draws no rule", async () => {
    expect(await frameFor(false)).not.toContain("──────────");
});

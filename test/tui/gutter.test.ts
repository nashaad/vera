import { expect, test } from "bun:test";
import {
    parseColor,
    TextAttributes,
    TextRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiGutterEntry } from "../../clients/tui/gutter.ts";
import {
    renderTuiEntry,
    TUI_ELEMENT,
    TUI_MUTED,
} from "../../clients/tui/state.ts";
import { resolveTuiDiagnostic } from "../../clients/tui/diagnostic-severity.ts";

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
    expect(answer - rule).toBe(2);
    expect(rule).toBe(1);
    expect(lines[rule]).not.toContain("•");
    expect(lines[answer]).toContain("•");
});

test("separator spacing is independently configurable on both sides", async () => {
    const setup = await createTestRenderer({ width: 30, height: 8 });
    const content = new TextRenderable(setup.renderer, {
        id: "content",
        content: "Final answer",
    });
    const node = createTuiGutterEntry(
        setup.renderer,
        "answer",
        { kind: "assistant", text: "Final answer" },
        content,
        4,
        true,
        { separatorSpacingBefore: 1, separatorSpacingAfter: 2 },
    );
    setup.renderer.root.add(node);

    try {
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const rule = lines.findIndex((line) => line.includes("──────────"));
        const answer = lines.findIndex((line) => line.includes("Final answer"));
        expect(rule).toBe(1);
        expect(answer - rule).toBe(3);
    } finally {
        setup.renderer.destroy();
    }
});

test("an unruled block draws no rule", async () => {
    expect(await frameFor(false)).not.toContain("──────────");
});

test("the separator can be hidden while keeping its spacing", async () => {
    const setup = await createTestRenderer({ width: 30, height: 8 });
    const content = new TextRenderable(setup.renderer, {
        id: "content",
        content: "Final answer",
    });
    const node = createTuiGutterEntry(
        setup.renderer,
        "answer",
        { kind: "assistant", text: "Final answer" },
        content,
        0,
        true,
        {
            separatorVisible: false,
            separatorSpacingBefore: 1,
            separatorSpacingAfter: 2,
        },
    );
    setup.renderer.root.add(node);

    try {
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const answer = lines.findIndex((line) => line.includes("Final answer"));
        expect(node.findDescendantById("answer-rule")).toBeUndefined();
        expect(answer).toBe(3);
    } finally {
        setup.renderer.destroy();
    }
});

test("the separator is a quiet element-colored hairline", async () => {
    const setup = await createTestRenderer({ width: 30, height: 6 });
    const content = new TextRenderable(setup.renderer, {
        id: "content",
        content: "Final answer",
    });
    const node = createTuiGutterEntry(
        setup.renderer,
        "answer",
        { kind: "assistant", text: "Final answer" },
        content,
        0,
        true,
    );
    setup.renderer.root.add(node);

    try {
        const rule = node.findDescendantById("answer-rule");
        expect(rule).toBeInstanceOf(TextRenderable);
        expect(rule instanceof TextRenderable
            ? rule.fg.equals(parseColor(TUI_ELEMENT))
            : false).toBe(true);
    } finally {
        setup.renderer.destroy();
    }
});

test("the assistant marker is a muted weighted bullet", async () => {
    const setup = await createTestRenderer({ width: 30, height: 6 });
    const content = new TextRenderable(setup.renderer, {
        id: "content",
        content: "Final answer",
    });
    const node = createTuiGutterEntry(
        setup.renderer,
        "answer",
        { kind: "assistant", text: "Final answer" },
        content,
        0,
    );
    setup.renderer.root.add(node);

    try {
        const marker = node.findDescendantById("answer-marker");
        expect(marker).toBeInstanceOf(TextRenderable);
        expect(marker instanceof TextRenderable ? marker.plainText : undefined)
            .toBe("•");
        expect(marker instanceof TextRenderable
            ? marker.fg.equals(parseColor(TUI_MUTED))
            : false).toBe(true);
        expect(marker instanceof TextRenderable ? marker.attributes : undefined)
            .toBe(TextAttributes.BOLD);
    } finally {
        setup.renderer.destroy();
    }
});

test("thought markers use the same compact bullet as assistant rows", async () => {
    const setup = await createTestRenderer({ width: 30, height: 6 });
    const content = new TextRenderable(setup.renderer, {
        id: "content",
        content: "Churned for 1.8s",
    });
    const node = createTuiGutterEntry(
        setup.renderer,
        "thought",
        { kind: "thought", text: "Churned for 1.8s" },
        content,
        0,
    );
    setup.renderer.root.add(node);

    try {
        const marker = node.findDescendantById("thought-marker");
        expect(marker).toBeInstanceOf(TextRenderable);
        expect(marker instanceof TextRenderable ? marker.plainText : undefined)
            .toBe("•");
        expect(marker instanceof TextRenderable ? marker.attributes : undefined)
            .toBe(TextAttributes.BOLD);
    } finally {
        setup.renderer.destroy();
    }
});

test("a runtime failure uses the indented activity gutter", async () => {
    const setup = await createTestRenderer({ width: 70, height: 4 });
    const entry = {
        kind: "notice" as const,
        text: "",
        diagnostic: resolveTuiDiagnostic(
            "resident_agent_stopped",
            "Resident agent stopped unexpectedly",
        ),
    };
    const content = new TextRenderable(setup.renderer, {
        id: "content",
        content: renderTuiEntry(entry),
    });
    const node = createTuiGutterEntry(
        setup.renderer,
        "failure",
        entry,
        content,
        0,
    );
    setup.renderer.root.add(node);

    try {
        await setup.flush();
        const marker = node.findDescendantById("failure-marker");
        expect(marker).toBeInstanceOf(TextRenderable);
        expect(marker instanceof TextRenderable ? marker.plainText : undefined)
            .toBe(" ");
        expect(setup.captureCharFrame()).toMatch(
            /^ {2}× stopped  Resident agent stopped unexpectedly/m,
        );
    } finally {
        setup.renderer.destroy();
    }
});

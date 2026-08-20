import { expect, test } from "bun:test";
import { MarkdownRenderable, SyntaxStyle } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiMarkdownEntry } from "../../clients/tui/markdown-entry.ts";
import { activateTuiLink } from "../../clients/tui/markdown-links.ts";

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

test("mouse activation opens a supported local Markdown link", async () => {
    const setup = await createTestRenderer({ width: 80, height: 8 });
    const syntaxStyle = SyntaxStyle.fromStyles({});
    const opened: string[] = [];
    const node = createTuiMarkdownEntry(
        setup.renderer,
        "local-link",
        {
            kind: "notification",
            text: "See [report](file:///tmp/report.html) now.",
        },
        syntaxStyle,
        "#ffffff",
        0,
        (url) => {
            opened.push(url);
        },
    );
    setup.renderer.root.add(node!);

    try {
        await setup.flush();
        await Bun.sleep(50);
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const row = lines.findIndex((line) => line.includes("report"));
        const column = lines[row]!.indexOf("report");
        expect(row).toBeGreaterThanOrEqual(0);
        expect(column).toBeGreaterThanOrEqual(0);
        expect(lines[row]).toContain("See report");
        expect(lines[row]).toContain("now.");

        await setup.mockMouse.click(column, row);

        expect(opened).toEqual(["file:///tmp/report.html"]);
    } finally {
        node?.destroy();
        syntaxStyle.destroy();
        setup.renderer.destroy();
    }
});

test("mouse activation follows formatted and entity-decoded link labels", async () => {
    const setup = await createTestRenderer({ width: 100, height: 12 });
    const syntaxStyle = SyntaxStyle.fromStyles({});
    const opened: string[] = [];
    const node = createTuiMarkdownEntry(
        setup.renderer,
        "formatted-links",
        {
            kind: "notification",
            text: "[**bold**](file:///tmp/bold) and [a &amp; b](file:///tmp/entity)",
        },
        syntaxStyle,
        "#ffffff",
        0,
        (url) => {
            opened.push(url);
        },
    );
    setup.renderer.root.add(node!);

    try {
        await setup.flush();
        await Bun.sleep(100);
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const row = lines.findIndex((line) => line.includes("bold") && line.includes("a & b"));
        expect(row).toBeGreaterThanOrEqual(0);

        const line = lines[row]!;
        await setup.mockMouse.click(
            Bun.stringWidth(line.slice(0, line.indexOf("bold"))),
            row,
        );
        await setup.mockMouse.click(
            Bun.stringWidth(line.slice(0, line.indexOf("a & b"))),
            row,
        );

        expect(opened).toEqual([
            "file:///tmp/bold",
            "file:///tmp/entity",
        ]);
    } finally {
        node?.destroy();
        syntaxStyle.destroy();
        setup.renderer.destroy();
    }
});

test("mouse activation uses display columns for wide Unicode labels", async () => {
    const setup = await createTestRenderer({ width: 100, height: 8 });
    const syntaxStyle = SyntaxStyle.fromStyles({});
    const opened: string[] = [];
    const node = createTuiMarkdownEntry(
        setup.renderer,
        "wide-link",
        {
            kind: "notification",
            text: "界 [wide](file:///tmp/wide) now.",
        },
        syntaxStyle,
        "#ffffff",
        0,
        (url) => {
            opened.push(url);
        },
    );
    setup.renderer.root.add(node!);

    try {
        await setup.flush();
        await Bun.sleep(100);
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const row = lines.findIndex((line) => line.includes("wide"));
        const line = lines[row]!;
        const labelColumn = Bun.stringWidth(line.slice(0, line.indexOf("wide")));

        await setup.mockMouse.click(labelColumn - 1, row);
        expect(opened).toEqual([]);
        await setup.mockMouse.click(labelColumn, row);
        expect(opened).toEqual(["file:///tmp/wide"]);
    } finally {
        node?.destroy();
        syntaxStyle.destroy();
        setup.renderer.destroy();
    }
});

test("mouse activation opens links rendered inside Markdown tables", async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 });
    const syntaxStyle = SyntaxStyle.fromStyles({});
    const opened: string[] = [];
    const node = createTuiMarkdownEntry(
        setup.renderer,
        "table-link",
        {
            kind: "notification",
            text: "| Name | Kind |\n| --- | --- |\n| [report](file:///tmp/report) | file |",
        },
        syntaxStyle,
        "#ffffff",
        0,
        (url) => {
            opened.push(url);
        },
    );
    setup.renderer.root.add(node!);

    try {
        await setup.flush();
        await Bun.sleep(100);
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const row = lines.findIndex((line) => line.includes("report"));
        const line = lines[row]!;
        await setup.mockMouse.click(
            Bun.stringWidth(line.slice(0, line.indexOf("report"))),
            row,
        );

        expect(opened).toEqual(["file:///tmp/report"]);
    } finally {
        node?.destroy();
        syntaxStyle.destroy();
        setup.renderer.destroy();
    }
});

test("link activation rejects non-local schemes", () => {
    const opened: string[] = [];

    expect(activateTuiLink("javascript:alert(1)", (url) => {
        opened.push(url);
    }))
        .toBe(false);
    expect(activateTuiLink("file://remote.example/report.html", (url) => {
        opened.push(url);
    }))
        .toBe(false);
    expect(activateTuiLink("https://example.com/report.html", (url) => {
        opened.push(url);
    }))
        .toBe(true);
    expect(opened).toEqual(["https://example.com/report.html"]);
});

test("an answer that follows no work carries no section rule", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const syntaxStyle = SyntaxStyle.fromStyles({});
    const node = createTuiMarkdownEntry(
        setup.renderer,
        "plain-assistant",
        { kind: "assistant", text: "Final answer" },
        syntaxStyle,
        "#ffffff",
        0,
    );
    setup.renderer.root.add(node!);

    try {
        await setup.flush();
        await Bun.sleep(50);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Final answer");
        expect(frame).not.toContain("─".repeat(10));
    } finally {
        node?.destroy();
        syntaxStyle.destroy();
        setup.renderer.destroy();
    }
});

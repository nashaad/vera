import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { installTuiTextLinkHandler } from "../../clients/tui/markdown-links.ts";

const PAGE = "http://127.0.0.1:53854/x/vera.artifacts/artifacts?session=crow-1&artifact=raid";

async function clickNotice(
    content: string,
    width: number,
    pick: (lines: readonly string[]) => { row: number; column: number },
): Promise<string[]> {
    const setup = await createTestRenderer({ width, height: 8 });
    const opened: string[] = [];
    const text = new TextRenderable(setup.renderer, {
        id: "notice",
        content,
        width: "100%",
        wrapMode: "word",
        selectable: true,
    });
    installTuiTextLinkHandler(text, (url) => {
        opened.push(url);
    });
    setup.renderer.root.add(text);
    try {
        await setup.flush();
        const { row, column } = pick(setup.captureCharFrame().split("\n"));
        expect(row).toBeGreaterThanOrEqual(0);
        expect(column).toBeGreaterThanOrEqual(0);
        await setup.mockMouse.click(column, row);
        return opened;
    } finally {
        text.destroy();
        setup.renderer.destroy();
    }
}

test("clicking the address in a notice opens it", async () => {
    const opened = await clickNotice(`Artifact page: ${PAGE}`, 120, (lines) => {
        const row = lines.findIndex((line) => line.includes("vera.artifacts"));
        return { row, column: lines[row]!.indexOf("vera.artifacts") };
    });
    expect(opened).toEqual([PAGE]);
});

test("clicking the label beside the address opens nothing", async () => {
    const opened = await clickNotice(`Artifact page: ${PAGE}`, 120, (lines) => {
        const row = lines.findIndex((line) => line.includes("Artifact page"));
        return { row, column: lines[row]!.indexOf("page") };
    });
    expect(opened).toEqual([]);
});

test("a wrapped address opens from its second line, without the closing period", async () => {
    const opened = await clickNotice(`The crow left a map at ${PAGE}.`, 40, (lines) => {
        const row = lines.findIndex((line) => line.includes("raid"));
        return { row, column: lines[row]!.indexOf("raid") };
    });
    expect(opened).toEqual([PAGE]);
});

test("an unsupported scheme in a notice does not open", async () => {
    const opened = await clickNotice("Hoist the flag at ftp://crow.test/flag", 80, (lines) => {
        const row = lines.findIndex((line) => line.includes("crow.test"));
        return { row, column: lines[row]!.indexOf("crow.test") };
    });
    expect(opened).toEqual([]);
});

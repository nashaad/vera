import { expect, spyOn, test } from "bun:test";
import { RGBA, StyledText, TextBuffer, TextRenderable, fg } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { setTextContent } from "../../clients/tui/text-content.ts";

test("empty text clears once without passing empty chunks to the native buffer", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const node = new TextRenderable(setup.renderer, { content: "ready" });
    setup.renderer.root.add(node);
    const write = spyOn(TextBuffer.prototype, "setStyledText");
    try {
        setTextContent(node, "");
        for (let index = 0; index < 1_000; index += 1) {
            setTextContent(node, "");
            setTextContent(node, new StyledText([fg("#ffffff")(""), fg("#000000")("")]));
        }
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0]![0].chunks).toEqual([]);
        expect(node.plainText).toBe("");
        await setup.renderOnce();
        expect(setup.captureCharFrame()).not.toContain("ready");
        setTextContent(node, "ready again");
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("ready again");
    } finally {
        write.mockRestore();
        setup.renderer.destroy();
    }
});

test("unchanged text and equivalent colors do not rewrite native text", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const node = new TextRenderable(setup.renderer, { content: "ready" });
    const write = spyOn(TextBuffer.prototype, "setStyledText");
    try {
        setTextContent(node, "ready");
        expect(write).not.toHaveBeenCalled();
        setTextContent(node, new StyledText([fg(RGBA.fromHex("#ffffff"))("ready")]));
        setTextContent(node, new StyledText([fg(RGBA.fromHex("#ffffff"))("ready")]));
        expect(write).toHaveBeenCalledTimes(1);
        setTextContent(node, new StyledText([fg("#00ff00")("ready")]));
        expect(write).toHaveBeenCalledTimes(2);
        expect(node.chunks[0]!.fg!.equals(RGBA.fromHex("#00ff00"))).toBe(true);
    } finally {
        write.mockRestore();
        node.destroy();
        setup.renderer.destroy();
    }
});

test("attributes, backgrounds, links, and blank lines remain meaningful changes", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const node = new TextRenderable(setup.renderer, { content: "ready" });
    const write = spyOn(TextBuffer.prototype, "setStyledText");
    try {
        const chunk = { __isChunk: true as const, text: "ready" };
        setTextContent(node, new StyledText([{ ...chunk, attributes: 1 }]));
        setTextContent(node, new StyledText([{ ...chunk, attributes: 1, bg: RGBA.fromHex("#000000") }]));
        setTextContent(node, new StyledText([{ ...chunk, link: { url: "https://example.com/one" } }]));
        setTextContent(node, new StyledText([{ ...chunk, link: { url: "https://example.com/two" } }]));
        expect(write).toHaveBeenCalledTimes(4);
        setTextContent(node, "\n");
        expect(node.plainText).toBe("\n");
    } finally {
        write.mockRestore();
        node.destroy();
        setup.renderer.destroy();
    }
});

test("repeated empty labels keep native memory bounded", async () => {
    const child = Bun.spawn([
        process.execPath,
        new URL("../support/tui-text-memory-child.ts", import.meta.url).pathname,
    ], { stdout: "pipe", stderr: "pipe" });
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        const { growth } = JSON.parse(stdout) as { growth: number };
        expect(growth).toBeLessThan(16 * 1024 * 1024);
    } finally {
        if (child.exitCode === null) child.kill();
    }
}, 10_000);

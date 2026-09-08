import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { setTextContent } from "../../clients/tui/text-content.ts";

const setup = await createTestRenderer({ width: 40, height: 8 });
const node = new TextRenderable(setup.renderer, { content: "ready" });
setup.renderer.root.add(node);
try {
    for (let index = 0; index < 250_000; index += 1) setTextContent(node, "");
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    for (let index = 0; index < 250_000; index += 1) setTextContent(node, "");
    Bun.gc(true);
    console.log(JSON.stringify({ growth: process.memoryUsage().rss - before }));
} finally {
    setup.renderer.destroy();
}

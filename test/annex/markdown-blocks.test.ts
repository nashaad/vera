import { expect, test } from "bun:test";

import { markdownBlocks } from "../../src/annex/markdown-blocks.ts";

test("each top-level block and each list item becomes its own block", () => {
    const blocks = markdownBlocks("# Raid\n\nSail at dawn.\n\n3. Find the map\n4. Dig\n");
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
        ["heading", "# Raid"],
        ["paragraph", "Sail at dawn."],
        ["list_item", "3. Find the map"],
        ["list_item", "4. Dig"],
    ]);
    expect(blocks[3]?.html).toContain("<ol start=\"4\">");
});

test("raw HTML is escaped and unsafe link schemes are dropped", () => {
    const [block] = markdownBlocks(
        "Caw <script>alert(1)</script> [x](javascript:alert(1)) [y](https://crow.example) ![z](https://crow.example/a.png)",
    );
    expect(block?.html).toContain("&lt;script&gt;");
    expect(block?.html).not.toContain("<script");
    expect(block?.html).not.toContain("javascript:");
    expect(block?.html).toContain("<a href=\"https://crow.example\"");
});

test("https images, audio and video render as media; other sources stay as alt text", () => {
    const html = (markdown: string): string => markdownBlocks(markdown)[0]?.html ?? "";
    expect(html("![map](https://crow.example/map.png)")).toContain("<img src=\"https://crow.example/map.png\" alt=\"map\"");
    expect(html("![shanty](https://crow.example/shanty.MP3?v=2)")).toContain("<audio controls preload=\"metadata\" src=\"https://crow.example/shanty.MP3?v=2\"");
    expect(html("![raid](https://crow.example/raid.webm)")).toContain("<video controls");
    expect(html("![map](http://crow.example/map.png)")).not.toContain("<img");
    expect(html("![x](javascript:alert(1))")).not.toContain("javascript:");
    expect(html("![\"onerror=x](https://crow.example/a\"b.png)")).not.toContain("\"onerror");
});

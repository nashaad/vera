import { expect, test } from "bun:test";

import { renderAssistantMarkdown } from "../../clients/desktop/src/markdown.ts";

test("desktop Markdown renders ordinary assistant formatting", () => {
    const html = renderAssistantMarkdown([
        "## Result",
        "",
        "Use **bold**, `code`, and:",
        "",
        "- one",
        "- two",
    ].join("\n"));

    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
});

test("desktop Markdown does not activate raw HTML or unsafe links", () => {
    const html = renderAssistantMarkdown(
        '<script>alert("no")</script> [click](javascript:alert(1))',
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("href=");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("click");
});

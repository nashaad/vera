import { expect, test } from "bun:test";

import { htmlToMarkdown } from "../../src/tools/html-to-markdown.ts";

test("htmlToMarkdown keeps title and skips script and style", () => {
    const result = htmlToMarkdown(`
        <html>
          <head>
            <title>Example &amp; docs</title>
            <style>hidden</style>
          </head>
          <body>
            <h1>Heading</h1>
            <p>Hello <strong>world</strong>.</p>
            <script>also hidden</script>
          </body>
        </html>
    `);

    expect(result.title).toBe("Example & docs");
    expect(result.markdown).toContain("# Heading");
    expect(result.markdown).toContain("Hello **world**.");
    expect(result.markdown).not.toContain("hidden");
});

test("htmlToMarkdown does not expose text inside malformed hidden elements", () => {
    const result = htmlToMarkdown(
        "<main>Visible</main><script>hidden instructions",
    );
    expect(result.markdown).toContain("Visible");
    expect(result.markdown).not.toContain("hidden instructions");
});

test("htmlToMarkdown resolves relative links against the page URL", () => {
    const result = htmlToMarkdown(
        `<p>See <a href="../other">the other page</a>.</p>`,
        "https://example.com/docs/page",
    );
    expect(result.markdown).toContain(
        "[the other page](https://example.com/other)",
    );
});

test("htmlToMarkdown keeps lists, fenced code, and block quotes", () => {
    const result = htmlToMarkdown(`
        <ul>
          <li>one</li>
          <li>two</li>
        </ul>
        <pre><code class="language-ts">const n = 1;</code></pre>
        <blockquote><p>quoted</p></blockquote>
    `);

    expect(result.markdown).toContain("- one");
    expect(result.markdown).toContain("- two");
    expect(result.markdown).toContain("```ts\nconst n = 1;\n```");
    expect(result.markdown).toContain("> quoted");
});

test("htmlToMarkdown turns tables into markdown tables", () => {
    const result = htmlToMarkdown(`
        <table>
          <tr><th>Name</th><th>Count</th></tr>
          <tr><td>Ada</td><td>2</td></tr>
        </table>
    `);

    expect(result.markdown).toContain("| Name | Count |");
    expect(result.markdown).toContain("| --- | --- |");
    expect(result.markdown).toContain("| Ada | 2 |");
});

test("htmlToMarkdown drops data image payloads and keeps alt text", () => {
    const result = htmlToMarkdown(
        `<p><img src="data:image/png;base64,AAAA" alt="chart"><img src="/pic.png" alt="photo"></p>`,
        "https://example.com/page",
    );
    expect(result.markdown).toContain("chart");
    expect(result.markdown).not.toContain("base64");
    expect(result.markdown).toContain(
        "![photo](https://example.com/pic.png)",
    );
});

test("htmlToMarkdown ignores javascript links", () => {
    const result = htmlToMarkdown(
        `<a href="javascript:alert(1)">Click</a>`,
    );
    expect(result.markdown).toContain("Click");
    expect(result.markdown).not.toContain("javascript:");
    expect(result.markdown).not.toContain("](");
});

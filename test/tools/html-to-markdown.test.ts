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

test("@core bounded markdown matches normalized prefixes and exact boundaries", () => {
    const fixtures = [
        "<title>Crow</title><p> one <b>two</b> three </p><p>four 😀 five</p>",
        "<p>early text</p><title>Late crow</title><p>last</p>",
        "<blockquote><p>A  B</p><p>C</p></blockquote><ul><li>one</li><li>two</li></ul>",
        "<pre>  first  \n\n\n second \t\n  </pre><p>last</p>",
        '<table><tr><th>Ship</th><th><a href="/map|route">Map</a></th></tr><tr><td>A</td><td> B | C </td><td>extra</td></tr></table>',
        '<p>\0e\0 42\0c0\0 <img alt="a\0e\0b" src="/img"></p>',
        '<p><a href="relative">one <strong>two</strong></a> <em>end</em></p>',
    ];
    for (const html of fixtures) {
        const base = "https://example.org/crow/";
        const full = htmlToMarkdown(html, base);
        for (let maxLength = 0; maxLength <= full.markdown.length + 1; maxLength++) {
            let end = Math.min(maxLength, full.markdown.length);
            if (end > 0 && end < full.markdown.length
                && /[\uD800-\uDBFF]/.test(full.markdown[end - 1]!) && /[\uDC00-\uDFFF]/.test(full.markdown[end]!)) end--;
            const bounded = htmlToMarkdown(html, base, { maxLength });
            expect(bounded.title).toBe(full.title);
            expect(bounded.markdown).toBe(full.markdown.slice(0, end));
            expect(bounded.truncated).toBe(full.markdown.length > maxLength);
        }
    }
});

test("@core bounded markdown stops expanded relative links at its output limit", () => {
    const base = `https://example.org/${"a".repeat(4096)}/`;
    const html = '<p><a href="crow">Crow</a></p>'.repeat(2800);
    const OriginalURL = globalThis.URL;
    let resolutions = 0;
    class CountingURL extends OriginalURL {
        constructor(url: string | URL, baseUrl?: string | URL) {
            resolutions++;
            super(url, baseUrl);
        }
    }
    try {
        globalThis.URL = CountingURL as typeof URL;
        const result = htmlToMarkdown(html, base, { maxLength: 10_000_000 });
        expect(result.markdown).toHaveLength(10_000_000);
        expect(result.markdown.startsWith(`[Crow](${base}crow)`)).toBe(true);
        expect(result.truncated).toBe(true);
        expect(resolutions).toBeLessThan(2800);
    } finally {
        globalThis.URL = OriginalURL;
    }
}, 20_000);

test("@core bounded table output stops before quadratic padding accumulates", () => {
    const header = "<th>H</th>".repeat(3000);
    const rows = "<tr><td>X</td></tr>".repeat(3000);
    const result = htmlToMarkdown(`<table><tr>${header}</tr>${rows}</table>`, undefined, { maxLength: 100_000 });
    expect(result.markdown).toHaveLength(100_000);
    expect(result.markdown.startsWith("| H | H | H")).toBe(true);
    expect(result.truncated).toBe(true);
}, 20_000);

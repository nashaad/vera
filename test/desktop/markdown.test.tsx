import { describe, expect, test } from "bun:test";
import { marked } from "marked";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PageLinksProvider } from "../../clients/ui/src/pagepane/PageLinks.tsx";
import type { AnnexPagesAnswer } from "../../clients/ui/src/protocol/bridge.ts";
import type { CodeCardProps } from "../../clients/ui/src/session/CodeCard.tsx";
import { CodeCard } from "../../clients/ui/src/session/CodeCard.tsx";
import { Markdown } from "../../clients/ui/src/session/Markdown.tsx";
import { renderBlock } from "../../clients/ui/src/session/MarkdownBlocks.tsx";
import { lexMarkdown, MARKDOWN_OPTIONS, type MarkdownLexState } from "../../clients/ui/src/session/MarkdownLexer.ts";
import { WorkbenchContext, type WorkbenchApi } from "../../clients/ui/src/workbench/context.tsx";

const ANNEX: AnnexPagesAnswer = {
    ok: true,
    url: "http://127.0.0.1:8372/",
    pages: [{ label: "Usage", path: "/usage" }],
};

function render(text: string, fade = false, annex: AnnexPagesAnswer | undefined = undefined): string {
    const content = createElement(Markdown, { text, fade });
    return renderToStaticMarkup(createElement(WorkbenchContext.Provider, { value: {} as WorkbenchApi },
        createElement(PageLinksProvider, { annex, children: content })));
}

function renderTokens(state: MarkdownLexState, fade = true): string {
    const blocks = state.tokens.filter((token) => token.type !== "space" && token.type !== "def");
    const content = createElement("div", { className: "assistant-text" }, blocks.map((token, index) => (
        renderBlock(token, String(index), fade && index === blocks.length - 1)
    )));
    return renderToStaticMarkup(createElement(WorkbenchContext.Provider, { value: {} as WorkbenchApi },
        createElement(PageLinksProvider, { annex: ANNEX, children: content })));
}

function block(text: string, fade = true): ReactNode {
    const tokens = marked.lexer(text, { gfm: true, breaks: true }).filter((token) => token.type !== "space");
    if (tokens[0] === undefined) throw new Error("Expected a Markdown block.");
    return renderBlock(tokens[0], "0", fade);
}

interface ElementProps {
    readonly children?: ReactNode;
    readonly className?: string;
}

function elements(node: ReactNode): Array<ReturnType<typeof createElement>> {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!isValidElement<ElementProps>(node)) return [];
    return [node, ...elements(node.props.children)];
}

function wordKeys(text: string): Array<{ text: ReactNode; key: string | null }> {
    return elements(block(text)).flatMap((element) => {
        const props = element.props as ElementProps;
        return props.className === "word-in" ? [{ text: props.children, key: element.key }] : [];
    });
}

describe("desktop reply Markdown", () => {
    test("@core a paragraph followed immediately by a list renders as separate blocks", () => {
        expect(render("Here is what changed:\n- first\n- second"))
            .toBe('<div class="assistant-text"><p>Here is what changed:</p><ul><li>first</li><li>second</li></ul></div>');
    });

    test("nested bullets and a sibling remain in the correct lists", () => {
        expect(render("- parent\n  - child\n- sibling"))
            .toContain("<ul><li>parent<ul><li>child</li></ul></li><li>sibling</li></ul>");
    });

    test("numbered items preserve continuation lines and start numbers", () => {
        expect(render("3. A long item\n   that wraps\n4. Next"))
            .toContain('<ol start="3"><li>A long item<br/>that wraps</li><li>Next</li></ol>');
    });

    test("a numbered list can contain a nested bullet list", () => {
        expect(render("1. Step\n   - detail\n2. Step two"))
            .toContain('<ol start="1"><li>Step<ul><li>detail</li></ul></li><li>Step two</li></ol>');
    });

    test("loose list items stay together and retain their paragraphs", () => {
        expect(render("- one\n\n- two\n\n- three"))
            .toContain("<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>");
    });

    test("tight and loose task items have disabled checkboxes", () => {
        for (const text of ["- [x] done\n- [ ] next", "- [x] done\n\n- [ ] next"]) {
            const html = render(text);
            expect(html.match(/type="checkbox"/g)).toHaveLength(2);
            expect(html.match(/disabled=""/g)).toHaveLength(2);
            expect(html.match(/checked=""/g)).toHaveLength(1);
            expect(html.match(/class="markdown-task-item"/g)).toHaveLength(2);
            expect(html).not.toContain("[x]");
            expect(html).not.toContain("[ ]");
        }
    });

    test("tables have a scrolling wrapper and aligned header and body cells", () => {
        const html = render("| left | middle | right |\n| :--- | :---: | ---: |\n| crow | **nest** | 2 |");
        expect(html).toContain('<div class="markdown-table-scroll"><table>');
        expect(html).toContain('<th style="text-align:left">left</th>');
        expect(html).toContain('<th style="text-align:center">middle</th>');
        expect(html).toContain('<td style="text-align:center"><strong>nest</strong></td>');
        expect(html).toContain('<td style="text-align:right">2</td>');
    });

    test("blockquotes, rules, and paragraph line breaks render as blocks", () => {
        expect(render("> quote\n> next\n\n---\n\nLine one\nLine two"))
            .toContain("<blockquote><p>quote<br/>next</p></blockquote><hr/><p>Line one<br/>Line two</p>");
    });

    test("heading levels shift by two and stop at six", () => {
        expect(render("# One\n\n## Two\n\n###### Six"))
            .toContain("<h3>One</h3><h4>Two</h4><h6>Six</h6>");
    });

    test("strong, emphasis, strike, code spans, and escapes render", () => {
        expect(render("**a * b** __bold__ _italic_ ~~strike~~ `crow` \\*literal\\*"))
            .toContain("<strong>a * b</strong> <strong>bold</strong> <em>italic</em> <del>strike</del> <code>crow</code> *literal*");
    });

    test("a fenced block inside a list item keeps its language and body", () => {
        const html = render("- parent\n  ```ts title=nest.ts\n  const crow = 1;\n  ```\n- sibling");
        expect(html).toContain('<li>parent<div class="code-card">');
        expect(html).toContain('<span class="code-lang">ts title=nest.ts</span>');
        expect(html).toContain('<pre class="code-body">const crow = 1;</pre>');
        expect(html).toContain("</div></li><li>sibling</li>");
    });

    test("indented code is ready and appears in a code card", () => {
        const code = elements(block("    crow\n    nest")).find((element) => element.type === CodeCard);
        expect(code?.props as CodeCardProps).toMatchObject({ lang: "", body: "crow\nnest", ready: true });
        expect(render("    crow\n    nest")).toContain('<pre class="code-body">crow\nnest</pre>');
    });

    test("an open fence stays unready while streaming and preserves the trailing newline", () => {
        const open = elements(block("```ts\nconst crow = 1;\n")).find((element) => element.type === CodeCard);
        const closed = elements(block("```ts\nconst crow = 1;\n```\n")).find((element) => element.type === CodeCard);
        const finished = elements(block("```ts\nconst crow = 1;\n", false)).find((element) => element.type === CodeCard);
        expect(open?.props as CodeCardProps).toMatchObject({ lang: "ts", body: "const crow = 1;\n", ready: false });
        expect(closed?.props as CodeCardProps).toMatchObject({ lang: "ts", body: "const crow = 1;", ready: true });
        expect(finished?.props as CodeCardProps).toMatchObject({ ready: true });
    });

    test("nested and longer fences only become ready at a matching closing fence", () => {
        const open = elements(block("- crow\n  ````ts\n  nest\n  ```")).find((element) => element.type === CodeCard);
        const closed = elements(block("- crow\n  ````ts\n  nest\n  `````")).find((element) => element.type === CodeCard);
        expect((open?.props as CodeCardProps).ready).toBe(false);
        expect((closed?.props as CodeCardProps).ready).toBe(true);
        const tilde = elements(block("~~~ts\ncrow\n~~~")).find((element) => element.type === CodeCard);
        expect((tilde?.props as CodeCardProps).ready).toBe(true);
    });

    test("@core raw HTML is escaped as text in inline and block positions", () => {
        const inline = render('Hello <img src="https://example.com/a" onerror="run()"> crow');
        expect(inline).toContain('&lt;img src=&quot;https://example.com/a&quot; onerror=&quot;run()&quot;&gt;');
        expect(inline).not.toContain("<img");
        const html = render('<script>alert("crow")</script>');
        expect(html).toContain('&lt;script&gt;alert(&quot;crow&quot;)&lt;/script&gt;');
        expect(html).not.toContain("<script>");
    });

    test("bare annex addresses open their page and leave punctuation outside", () => {
        const html = render("Open http://127.0.0.1:8372/usage, please.", false, ANNEX);
        expect(html).toContain('data-page-link="/usage">http://127.0.0.1:8372/usage</a>, please.');
        expect(render("Open http://127.0.0.1:8372/usage.")).not.toContain("<a ");
    });

    test("explicit annex links open the page without nesting links", () => {
        const url = "http://127.0.0.1:8372/usage?period=day#total";
        const html = render(`[${url}](${url})`, false, ANNEX);
        expect(html).toContain(`data-page-link="/usage">${url}</a>`);
        expect(html.match(/<a /g)).toHaveLength(1);
    });

    test("explicit non-annex links stay inert and do not become page links", () => {
        const html = render("[crow](https://example.com/nest)", false, ANNEX);
        expect(html).toContain('<a href="https://example.com/nest" title="https://example.com/nest">crow</a>');
        expect(html).not.toContain("data-page-link");
    });

    test("images are inert alt-text links and never become images or annex page links", () => {
        const text = "![crow nest](http://127.0.0.1:8372/usage)";
        const html = render(text, false, ANNEX);
        expect(html).toContain('>crow nest</a>');
        expect(html).not.toContain("<img");
        expect(html).not.toContain("data-page-link");
        expect(html).toContain('role="link" aria-disabled="true"');
        expect(html).not.toContain("href=");
    });

    test("only the last top-level block fades, even with trailing blank lines", () => {
        const html = render("Old **crow**\n\nNew **bright** nest\n\n", true);
        expect(html).toContain("<p>Old <strong>crow</strong></p>");
        expect(html).toContain('<p><span class="word-in">New</span> <strong>bright</strong> <span class="word-in">nest</span></p>');
        expect(render("Old\n\nNew", false)).not.toContain("word-in");
    });

    test("existing word keys remain stable as the live text grows", () => {
        const before = wordKeys("a growing crow");
        const after = wordKeys("a growing crows nest");
        expect(before.map((word) => word.key)).toEqual(after.slice(0, 3).map((word) => word.key));
        expect(after.map((word) => word.text)).toEqual(["a", "growing", "crows", "nest"]);
    });
});

const STREAM_FIXTURES = [
    "Here is what changed:\n- first\n- second",
    "- parent\n  - child\n- sibling",
    "3. A long item\n   that wraps\n4. Next",
    "1. Step\n   - detail\n2. Step two",
    "- one\n\n- two\n\n- three",
    "- [x] done\n- [ ] next",
    "- [x] done\n\n- [ ] next",
    "| left | middle | right |\n| :--- | :---: | ---: |\n| crow | **nest** | 2 |",
    "> quote\n> next\n\n---\n\nLine one\nLine two",
    "# One\n\n## Two\n\n###### Six",
    "**a * b** __bold__ _italic_ ~~strike~~ `crow` \\*literal\\*",
    "- parent\n  ```ts title=nest.ts\n  const crow = 1;\n  ```\n- sibling",
    "    crow\n    nest",
    "```ts\nconst crow = 1;\n",
    "```ts\nconst crow = 1;\n```\n",
    "- crow\n  ````ts\n  nest\n  ```",
    "- crow\n  ````ts\n  nest\n  `````",
    "~~~ts\ncrow\n~~~",
    'Hello <img src="https://example.com/a" onerror="run()"> crow',
    '<script>alert("crow")</script>',
    "Open http://127.0.0.1:8372/usage, please.",
    "Open http://127.0.0.1:8372/usage.",
    "[http://127.0.0.1:8372/usage?period=day#total](http://127.0.0.1:8372/usage?period=day#total)",
    "[crow](https://example.com/nest)",
    "![crow nest](http://127.0.0.1:8372/usage)",
    "Old **crow**\n\nNew **bright** nest\n\n",
    "Old\n\nNew",
    "a growing crow",
    "a growing crows nest",
    "[crow]\n\n[crow]: https://example.com/nest",
    "[crow]\n\n> [crow]: https://example.com/nest",
    "[crow]\n\n- [crow]: https://example.com/nest",
    "[a\\]b]\n\n[a\\]b]: https://example.com/nest",
    "[pirate\ncrow]\n\n[pirate\ncrow]: https://example.com/nest",
    "+ nest\n| a | b |\na\n  crow\n**",
    "</script>\ntwo words\na\n- crow",
    "[x]\n\t\n  - nest",
    "First\r\n\r\nSecond\r\n- crow",
    "| a | b |\n| --- | --- |\n**bold**\n---1",
];

function normalizeTokens(tokens: MarkdownLexState["tokens"]): string {
    return JSON.stringify(tokens.filter((token) => token.type !== "space"), (key, value) => key === "raw" ? undefined : value);
}

function stream(text: string, randomChunks: boolean, compareEvery: number): void {
    let state: MarkdownLexState | undefined;
    let offset = 0;
    let seed = 0x72c5;
    let step = 0;
    while (offset < text.length) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        offset = Math.min(text.length, offset + (randomChunks ? 1 + seed % 13 : 1));
        const prefix = text.slice(0, offset);
        state = lexMarkdown(prefix, state);
        if (++step % compareEvery === 0 || offset === text.length) {
            expect(renderTokens(state)).toBe(render(prefix, true, ANNEX));
        }
    }
}

function longReply(): string {
    const section = (index: number): string => `## Crow report ${index}\n\nThe pirate crow mapped the **quiet harbor** and found _three nests_.\nEach new line stays visible and the crew checks the route.\n\n- Parent lookout ${index}\n  - Watch the harbor and signal the ship\n  - Keep the crew together\n- [x] Mark the safe channel\n\n| Nest | Eggs | Status |\n| :--- | ---: | :---: |\n| Crow | ${index} | **ready** |\n\n> The crow remembers the next heading.\n\n\`\`\`ts\nconst nest = ${index};\nconsole.log(nest);\n\`\`\`\n\n`;
    return Array.from({ length: 24 }, (_, index) => section(index + 1)).join("").slice(0, 10_240);
}

describe("incremental reply Markdown", () => {
    for (const [name, parts, realistic] of [
        ["realistic", [
            "Here is what changed:", "The fix keeps the cache.", "- first item with `code`",
            "- second item", "  - nested detail", "1. Step one", "   continues here", "2. Step two",
            "> A quoted note.", "---", "## Summary", "### Details", "| File | Change |",
            "| --- | --- |", "| a.ts | **edit** |", "```ts\nconst x = 1;\n```",
            "```bash\nbun test\n```", "- [x] done", "- [ ] next",
            "Plain sentence with [a link](http://example.com).", "",
        ], true],
        ["adversarial", [
            "para one", "word", "\n", "\n\n", "- item", "  - sub", "1. step", "   cont",
            "> quote", ">", "---", "# Head", "## H2", "| a | b |", "| --- | --- |",
            "| 1 | 2 |", "```ts", "```", "~~~", "    code", "\t", "<div>", "</div>",
            "**bold**", "- [ ] task", "Setext", "===", "2) paren", "\\",
        ], false],
    ] as const) {
        test(`seeded ${name} streams match full lexer tokens at every chunk`, () => {
            for (const initialSeed of [1, 2, 3, 4, 5]) {
                let seed = initialSeed;
                const random = (limit: number): number => {
                    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                    return seed % limit;
                };
                for (let document = 0; document < 30; document++) {
                    let text = "";
                    const count = 3 + random(25);
                    for (let part = 0; part < count; part++) {
                        text += parts[random(parts.length)] + "\n" + (realistic && random(3) === 0 ? "\n" : "");
                    }
                    let state: MarkdownLexState | undefined;
                    let offset = 0;
                    while (offset < text.length) {
                        offset = Math.min(text.length, offset + 1 + random(8));
                        const prefix = text.slice(0, offset);
                        state = lexMarkdown(prefix, state);
                        const actual = normalizeTokens(state.tokens);
                        const expected = normalizeTokens(marked.lexer(prefix, MARKDOWN_OPTIONS));
                        if (actual !== expected) {
                            throw new Error(`Seed ${initialSeed}, document ${document}, offset ${offset}, prefix ${JSON.stringify(prefix)}\nactual: ${actual}\nexpected: ${expected}`);
                        }
                    }
                }
            }
        }, 30_000);
    }

    for (const [index, text] of STREAM_FIXTURES.entries()) {
        test(`fixture ${index + 1} matches full lexing during character and chunk updates`, () => {
            stream(text, false, 1);
            stream(text, true, 1);
        });
    }

    test("a long mixed reply matches full lexing during character and chunk updates", () => {
        const text = longReply();
        expect(text.length).toBeGreaterThan(10_000);
        stream(text, false, 400);
        stream(text, true, 50);
    }, 30_000);

    test("@core settled blocks retain identity and replaced text falls back to full lexing", () => {
        const before = lexMarkdown("First\n\nSecond");
        const grown = lexMarkdown("First\n\nSecond nest", before);
        expect(grown.tokens[0]).toBe(before.tokens[0]);
        expect(grown.tokens[2]).not.toBe(before.tokens[2]);
        expect(lexMarkdown(grown.text, grown)).toBe(grown);
        const replaced = lexMarkdown("First\n\nNew crow", grown);
        expect(replaced.tokens[0]).not.toBe(grown.tokens[0]);
        expect(renderTokens(replaced)).toBe(render(replaced.text, true, ANNEX));
    });

    test("a mismatched kept prefix falls back to full lexing", () => {
        const before = lexMarkdown("First\n\nSecond");
        const invalid = { text: "Other\n\nSecond", tokens: before.tokens };
        const grown = lexMarkdown("Other\n\nSecond nest", invalid);
        expect(grown.tokens[0]).not.toBe(before.tokens[0]);
        expect(renderTokens(grown)).toBe(render(grown.text, true, ANNEX));
    });

    test("@core nested reference definitions invalidate earlier blocks", () => {
        for (const definition of ["[crow]: /nest", "> [crow]: /nest", "- [crow]: /nest"]) {
            const before = lexMarkdown("[crow]\n\n" + definition.slice(0, definition.indexOf(":")));
            const after = lexMarkdown("[crow]\n\n" + definition, before);
            expect(after.tokens[0]).not.toBe(before.tokens[0]);
            expect(renderTokens(after)).toBe(render(after.text, true, ANNEX));
            expect(renderTokens(after)).toContain('<a href="/nest"');
        }
    });

    test("a partial rule can become a continuing table row", () => {
        const before = lexMarkdown("| a | b |\n| --- | --- |\n**bold**\n---");
        const after = lexMarkdown(before.text + "1", before);
        expect(after.tokens[0]).not.toBe(before.tokens[0]);
        expect(normalizeTokens(after.tokens)).toBe(normalizeTokens(marked.lexer(after.text, MARKDOWN_OPTIONS)));
    });

    test("inline HTML state and normalized line endings relex earlier blocks", () => {
        for (const text of ["crow <script>\n\nnest\n\n=", "crow <a href=x>\n\nnest\n\nhttp://example.com", "crow\r\n\r\nnest"]) {
            const before = lexMarkdown(text);
            const after = lexMarkdown(text + " more", before);
            expect(after.tokens[0]).not.toBe(before.tokens[0]);
            expect(normalizeTokens(after.tokens)).toBe(normalizeTokens(marked.lexer(after.text, MARKDOWN_OPTIONS)));
        }
    });
});

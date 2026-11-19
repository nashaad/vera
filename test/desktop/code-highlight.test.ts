import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HighlightCache } from "../../clients/ui/src/session/highlight/cache.ts";
import { canHighlight, highlightCode, MAX_CHARS, MAX_LINES, peekHighlight } from "../../clients/ui/src/session/highlight/engine.ts";
import { languageFor } from "../../clients/ui/src/session/highlight/languages.ts";
import { KIND_NAMES, parseHighlighted, type HighlightedCode } from "../../clients/ui/src/session/highlight/tokens.ts";
import { isClosedFence, Markdown } from "../../clients/ui/src/session/Markdown.tsx";

const root = join(import.meta.dir, "..", "..");
const CROW = "const crow: number = 1; // nest\nfunction land(a: string) { return `hi ${a}`; }";

function kindsOf(code: HighlightedCode): Set<string> {
    return new Set(Array.from(code.kinds, (kind) => KIND_NAMES[kind] ?? "plain"));
}

function render(text: string, fade = false): string {
    return renderToStaticMarkup(createElement(Markdown, { text, fade }));
}

function fence(lang: string, code: string, closed = true): string {
    return `\`\`\`${lang}\n${code}${closed ? "\n```" : ""}`;
}

test("@core a block is plain text until its closing fence arrives, then it is colored", async () => {
    await highlightCode("ts", CROW);
    expect(render(fence("ts", CROW, false), true)).not.toContain("tok-");
    expect(render(fence("ts", CROW.slice(0, 20), false), true)).not.toContain("tok-");
    const closed = render(fence("ts", CROW), true);
    expect(closed).toContain("tok-keyword");
    expect(closed).toContain("tok-comment");
    expect(closed).toContain("tok-number");
});

test("@core a finished reply colors a block whose fence was never closed", async () => {
    await highlightCode("ts", CROW);
    expect(render(fence("ts", CROW, false), false)).toContain("tok-keyword");
});

test("@core an unknown language stays plain text, and so does a block with no language", async () => {
    expect(await highlightCode("nest", CROW)).toBeNull();
    expect(await highlightCode("", CROW)).toBeNull();
    expect(await highlightCode("text", CROW)).toBeNull();
    for (const lang of ["nest", "", "text"]) expect(render(fence(lang, CROW))).not.toContain("tok-");
});

test("the language label and the code text are unchanged by coloring", async () => {
    await highlightCode("ts", CROW);
    const html = render(fence("ts", CROW));
    expect(html).toContain("<span class=\"code-lang\">ts</span>");
    const pre = /<pre class="code-body">(.*?)<\/pre>/s.exec(html)?.[1] ?? "";
    const text = pre.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    expect(text).toBe(CROW);
});

test("a fence is closed when a later line starts with it", () => {
    expect(isClosedFence("```ts\nconst a = 1;\n```")).toBe(true);
    expect(isClosedFence("```ts\nconst a = 1;\n```  ")).toBe(true);
    expect(isClosedFence("```ts\nconst a = 1;")).toBe(false);
    expect(isClosedFence("```ts\nconst a = 1;\n``")).toBe(false);
    expect(isClosedFence("```ts")).toBe(false);
    expect(isClosedFence("```")).toBe(false);
});

test("@core a block is colored once: the same text gives the same result for any spelling of the language", async () => {
    const first = await highlightCode("ts", CROW);
    expect(first).not.toBeNull();
    expect(await highlightCode("ts", CROW)).toBe(first);
    expect(await highlightCode("TypeScript", CROW)).toBe(first);
    expect(await highlightCode("ts title=nest.ts", CROW)).toBe(first);
    expect(peekHighlight("ts", CROW)).toBe(first!);
});

test("blocks asked for at the same time share one pass", async () => {
    const code = "let nest = 1;\nlet eggs = 2;";
    const [a, b] = await Promise.all([highlightCode("js", code), highlightCode("js", code)]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
});

test("a block with nothing cached is not colored by peeking", () => {
    expect(peekHighlight("ts", "const never = 'seen before';")).toBeUndefined();
});

test("@core blocks over the line or size limit stay plain and are not kept", async () => {
    const tall = Array.from({ length: MAX_LINES + 1 }, (_, index) => `const v${index} = ${index};`).join("\n");
    const wide = `const w = "${"x".repeat(MAX_CHARS)}";`;
    expect(canHighlight("ts", tall)).toBeUndefined();
    expect(canHighlight("ts", wide)).toBeUndefined();
    expect(await highlightCode("ts", tall)).toBeNull();
    expect(await highlightCode("ts", wide)).toBeNull();
    expect(peekHighlight("ts", tall)).toBeUndefined();
    const atLimit = Array.from({ length: MAX_LINES }, (_, index) => `const v${index} = 1;`).join("\n");
    expect(canHighlight("ts", atLimit)).toBeDefined();
});

test("language names resolve from fence text", () => {
    expect(languageFor("ts")?.name).toBe("typescript");
    expect(languageFor(" Python ")?.name).toBe("python");
    expect(languageFor("language-rust")?.name).toBe("rust");
    expect(languageFor("sh")?.name).toBe("bash");
    expect(languageFor("yml")?.name).toBe("yaml");
    expect(languageFor("tsx {1,3}")?.name).toBe("typescript");
    expect(languageFor("")).toBeUndefined();
    expect(languageFor("klingon")).toBeUndefined();
});

test("@core colored runs keep every character of the source, in many languages", async () => {
    const samples: Readonly<Record<string, string>> = {
        python: "def land(n):\n    return f\"{n} & <crow>\"  # nest\n",
        bash: "for f in *.ts; do echo \"$f\" >> out.txt; done # all\n",
        json: "{\"crow\": [1, true, null], \"nest\": \"a<b\"}",
        css: ".crow > a:hover { color: #fff; margin: 0 auto; }",
        html: "<div class=\"nest\" id='a'>caw &amp; <b>fly</b></div>",
        diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
        yaml: "crow:\n  - nest: \"a\"\n    eggs: 3 # note\n",
        go: "func main() {\n\tfmt.Println(\"hi\")\n}\n",
        rust: "fn main() { let x: &str = \"hi\"; println!(\"{}\", x); }",
        sql: "SELECT name, COUNT(*) FROM nests WHERE eggs > 2 GROUP BY name;",
        markdown: "# Crow\n\n- **bold** and `code` and <b>html</b>\n",
        toml: "[nest]\nname = \"crow\"\neggs = 3\n",
        dockerfile: "FROM oven/bun:1\nRUN echo hi && ls\n",
    };
    for (const [lang, code] of Object.entries(samples)) {
        const result = await highlightCode(lang, code);
        expect(result, lang).not.toBeNull();
        expect(result!.texts.join(""), lang).toBe(code);
        expect(result!.kinds.length, lang).toBe(result!.texts.length);
        expect(kindsOf(result!).size, lang).toBeGreaterThan(1);
    }
});

test("a code token gets the kind of its innermost styled span", async () => {
    const code = "class Nest extends Bird { fly(a: string): number { return 42; } }\nconst x = new Nest(); // done";
    const result = (await highlightCode("ts", code))!;
    const kindOf = (text: string): string => {
        const index = result.texts.findIndex((run) => run.includes(text));
        return index === -1 ? "missing" : (KIND_NAMES[result.kinds[index] ?? 0] ?? "plain");
    };
    expect(kindOf("class")).toBe("keyword");
    expect(kindOf("Nest")).toBe("type");
    expect(kindOf("fly")).toBe("function");
    expect(kindOf("42")).toBe("number");
    expect(kindOf("// done")).toBe("comment");
});

test("diff lines are colored as added and removed", async () => {
    const result = (await highlightCode("diff", "-old line\n+new line\n context"))!;
    expect(kindsOf(result).has("added")).toBe(true);
    expect(kindsOf(result).has("removed")).toBe(true);
});

test("@core a grammar that embeds another loads it: JSX and tagged templates color without an error", async () => {
    const jsx = (await highlightCode("tsx", "const a = <div className=\"x\">hi</div>;\nconst q = gql`{ crow }`;"))!;
    expect(jsx).not.toBeNull();
    expect(kindsOf(jsx).has("tag")).toBe(true);
    const html = (await highlightCode("html", "<script>const a = 1;</script><style>a { color: red; }</style>"))!;
    expect(kindsOf(html).has("keyword")).toBe(true);
});

test("highlight markup decodes entities and merges neighbors of one kind", () => {
    const parsed = parseHighlighted("a &lt; b <span class=\"hljs-string\">&quot;x&quot;</span><span class=\"hljs-string\"> &amp; y</span>");
    expect(parsed.texts).toEqual(["a < b ", "\"x\" & y"]);
    expect(Array.from(parsed.kinds)).toEqual([0, 3]);
});

test("a span with no mapped class keeps the kind of its parent, and a plain one resets it", () => {
    const parsed = parseHighlighted(
        "<span class=\"hljs-string\">a<span class=\"language-xml\">b</span><span class=\"hljs-subst\">${c}</span>d</span>",
    );
    expect(parsed.texts).toEqual(["ab", "${c}", "d"]);
    expect(Array.from(parsed.kinds)).toEqual([3, 0, 3]);
});

test("@core the cache drops the least recently used entry past its entry or size cap", () => {
    const value = (label: string): HighlightedCode => ({ texts: [label], kinds: Uint8Array.of(0) });
    const cache = new HighlightCache(2, 100);
    cache.set("a", value("a"), 10);
    cache.set("b", value("b"), 10);
    expect(cache.get("a")?.texts[0]).toBe("a");
    cache.set("c", value("c"), 10);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.size).toBe(2);
    cache.set("d", value("d"), 95);
    expect(cache.size).toBe(1);
    expect(cache.cost).toBe(95);
    expect(cache.get("d")).toBeDefined();
    cache.set("huge", value("h"), 101);
    expect(cache.get("huge")).toBeUndefined();
    cache.set("d", value("d2"), 5);
    expect(cache.cost).toBe(5);
    expect(cache.get("d")?.texts[0]).toBe("d2");
});

test("@core grammars are never imported at startup: only type imports and dynamic imports name the highlighter", () => {
    const folder = join(root, "clients", "ui", "src", "session");
    const files = [join(folder, "CodeCard.tsx"), join(folder, "Markdown.tsx")];
    for (const name of readdirSync(join(folder, "highlight"))) files.push(join(folder, "highlight", name));
    for (const file of files) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
            if (!/from "highlight\.js/.test(line)) continue;
            expect(line.startsWith("import type "), `${file}: ${line}`).toBe(true);
        }
    }
});

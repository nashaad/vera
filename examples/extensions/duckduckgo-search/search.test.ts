import {
    expect,
    test,
} from "bun:test";
import { readFile } from "node:fs/promises";

import { activate, duckDuckGo } from "./index.ts";
import {
    parseDuckDuckGoLite,
    searchDuckDuckGo,
} from "./search.ts";

const signal = new AbortController().signal;

test("manifest and entrypoint register one DuckDuckGo provider", async () => {
    const manifest = JSON.parse(
        await readFile(new URL("./vera.extension.json", import.meta.url), "utf8"),
    );
    const registered: unknown[] = [];
    const vera = { search: { registerProvider: (provider: unknown) => { registered.push(provider); } } };

    activate(vera);

    expect(manifest).toMatchObject({
        entrypoint: "./index.ts",
        capabilities: ["search.providers.register"],
    });
    expect(registered).toEqual([duckDuckGo]);
    expect(duckDuckGo).toMatchObject({ id: "duckduckgo", label: "DuckDuckGo", requiresKey: false });
});

test("DuckDuckGo search keeps one IP-shaped session and parses results", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetcher = async (
        input: string | URL | Request,
        init?: RequestInit,
    ): Promise<Response> => {
        requests.push({ url: String(input), init });
        if (requests.length === 1) {
            return new Response("", { status: 200 });
        }
        return new Response(`
            <td>
              <a href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdag" class="result-link">
                DAG &amp; graphs
              </a>
            </td>
            <td class="result-snippet">A directed &lt;acyclic&gt; graph.</td>
        `, { status: 200 });
    };

    const results = await searchDuckDuckGo("dag", 5, signal, fetcher);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.init?.method).toBeUndefined();
    expect(requests[1]?.init?.method).toBe("POST");
    expect(String(requests[1]?.init?.body)).toContain("q=dag");
    expect(results).toEqual([{
        title: "DAG & graphs",
        url: "https://example.com/dag",
        snippet: "A directed <acyclic> graph.",
    }]);
});

test("DuckDuckGo parser filters ads and respects the result limit", () => {
    const html = `
        <a class="result-link" href="https://duckduckgo.com/y.js?ad=1">Ad</a>
        <td class="result-snippet">Ad text</td>
        <a class="result-link" href="https://example.com/one">One</a>
        <td class="result-snippet">First</td>
        <a class="result-link" href="https://example.com/two">Two</a>
        <td class="result-snippet">Second</td>
    `;

    expect(parseDuckDuckGoLite(html, 2)).toEqual([{
        title: "One",
        url: "https://example.com/one",
        snippet: "First",
    }]);
});

test("DuckDuckGo reports an honest blocked-or-changed-page failure", async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
        calls += 1;
        return new Response(calls === 1 ? "" : "<html>captcha</html>");
    };

    await expect(searchDuckDuckGo("dag", 5, signal, fetcher)).rejects.toThrow(
        "no parseable results",
    );
});

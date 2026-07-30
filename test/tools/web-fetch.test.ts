import { expect, test } from "bun:test";

import { extractPermissionActions } from "../../src/engine/permissions.ts";
import {
    fetchReadablePage,
    webFetchTool,
} from "../../src/tools/web-fetch.ts";

const signal = new AbortController().signal;
const publicAddress = async () => [{
    address: "93.184.216.34",
    family: 4 as const,
}];

test("web_fetch is a parallel built-in with network permission metadata", () => {
    expect(webFetchTool).toMatchObject({
        parallel: true,
        permissionOperation: "web.fetch",
        permissionInputs: [{ field: "url", kind: "url", verb: "read" }],
        definition: { name: "web_fetch" },
    });
    expect(extractPermissionActions({
        toolCall: {
            id: "fetch-1",
            name: "web_fetch",
            input: { url: "https://example.com/page" },
        },
        workspace: "/workspace",
        homeDirectory: "/home/test",
    })).toMatchObject([
        { operation: "web.fetch" },
        {
            verb: "read",
            path: "https://example.com/page",
            scope: "outside_workspace",
        },
    ]);
});

test("web_fetch returns readable text from a bounded HTML response", async () => {
    const output = await fetchReadablePage(
        "https://example.com/page",
        signal,
        async () => new Response(`
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
        `, { headers: { "content-type": "text/html" } }),
        publicAddress,
    );

    expect(output).toContain("URL: https://example.com/page");
    expect(output).toContain("Title: Example & docs");
    expect(output).toContain("Heading\n\nHello world.");
    expect(output).not.toContain("hidden");
});

test("web_fetch does not expose text inside malformed hidden elements", async () => {
    const output = await fetchReadablePage(
        "https://example.com/malformed",
        signal,
        async () => new Response(
            "<main>Visible</main><script>hidden instructions",
            { headers: { "content-type": "text/html" } },
        ),
        publicAddress,
    );

    expect(output).toContain("Visible");
    expect(output).not.toContain("hidden instructions");
});

test("web_fetch rejects private addresses before making a request", async () => {
    let requested = false;
    await expect(fetchReadablePage(
        "http://internal.example/secrets",
        signal,
        async () => {
            requested = true;
            return new Response("wrong");
        },
        async () => [{ address: "127.0.0.1", family: 4 }],
    )).rejects.toThrow("private-network");
    expect(requested).toBe(false);
});

test("web_fetch revalidates a redirect target", async () => {
    let requests = 0;
    await expect(fetchReadablePage(
        "https://example.com/start",
        signal,
        async () => {
            requests += 1;
            return new Response(null, {
                status: 302,
                headers: { location: "http://localhost/admin" },
            });
        },
        publicAddress,
    )).rejects.toThrow("private-network");
    expect(requests).toBe(1);
});

test("web_fetch rejects oversized and binary responses", async () => {
    await expect(fetchReadablePage(
        "https://example.com/large",
        signal,
        async () => new Response("small", {
            headers: { "content-length": String(1024 * 1024 + 1) },
        }),
        publicAddress,
    )).rejects.toThrow("exceeds");

    await expect(fetchReadablePage(
        "https://example.com/image",
        signal,
        async () => new Response("image", {
            headers: { "content-type": "image/png" },
        }),
        publicAddress,
    )).rejects.toThrow("content type image/png");
});

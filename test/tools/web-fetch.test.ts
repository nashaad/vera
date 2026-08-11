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

/** A minimal uncompressed PDF with one text object, built here so the suite
 * stays free of binary fixtures. */
function minimalPdf(text: string): Uint8Array {
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
            + " /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (const [index, object] of objects.entries()) {
        offsets.push(body.length);
        body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
        + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
        + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
        + `startxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(body);
}

function pdfResponse(bytes: Uint8Array): Response {
    return new Response(bytes, {
        headers: { "content-type": "application/pdf" },
    });
}

test("web_fetch reads the text out of a PDF", async () => {
    const output = await fetchReadablePage(
        "https://example.com/report.pdf",
        signal,
        async () => pdfResponse(minimalPdf("Summary statistics for natural gas")),
        publicAddress,
    );
    expect(output).toContain("URL: https://example.com/report.pdf");
    expect(output).toContain("Summary statistics for natural gas");
});

test("a PDF content type with parameters is still a PDF", async () => {
    const output = await fetchReadablePage(
        "https://example.com/report.pdf",
        signal,
        async () =>
            new Response(minimalPdf("charset parameter"), {
                headers: { "content-type": "application/pdf; charset=binary" },
            }),
        publicAddress,
    );
    expect(output).toContain("charset parameter");
});

test("a PDF with no selectable text says so instead of returning nothing", async () => {
    await expect(fetchReadablePage(
        "https://example.com/scan.pdf",
        signal,
        async () => pdfResponse(minimalPdf("")),
        publicAddress,
    )).rejects.toThrow("no selectable text");
});

test("bytes that are not a PDF are reported, not parsed", async () => {
    await expect(fetchReadablePage(
        "https://example.com/broken.pdf",
        signal,
        async () => pdfResponse(new TextEncoder().encode("not a pdf at all")),
        publicAddress,
    )).rejects.toThrow("could not read that PDF");
});

test("a PDF gets a larger budget than text, and is still bounded", async () => {
    // Over the 1 MiB text cap, under the 10 MiB PDF cap.
    await expect(fetchReadablePage(
        "https://example.com/big.pdf",
        signal,
        async () =>
            new Response(minimalPdf("under the pdf cap"), {
                headers: {
                    "content-type": "application/pdf",
                    "content-length": String(2 * 1024 * 1024),
                },
            }),
        publicAddress,
    )).resolves.toContain("under the pdf cap");

    await expect(fetchReadablePage(
        "https://example.com/huge.pdf",
        signal,
        async () =>
            new Response(minimalPdf("over the cap"), {
                headers: {
                    "content-type": "application/pdf",
                    "content-length": String(10 * 1024 * 1024 + 1),
                },
            }),
        publicAddress,
    )).rejects.toThrow("exceeds");
});

test("a private-network PDF is still rejected before any parsing", async () => {
    await expect(fetchReadablePage(
        "https://internal.example.com/report.pdf",
        signal,
        async () => pdfResponse(minimalPdf("secret")),
        async () => [{ address: "10.0.0.5", family: 4 as const }],
    )).rejects.toThrow("local and private-network");
});

test("a content type web_fetch cannot read points at web_download", async () => {
    await expect(fetchReadablePage(
        "https://example.com/archive.zip",
        signal,
        async () => new Response("bytes", {
            headers: { "content-type": "application/zip" },
        }),
        publicAddress,
    )).rejects.toThrow(/web_download to save this URL/);
});

test("reading a PDF says no file was saved and names the tool that saves one", async () => {
    const output = await fetchReadablePage(
        "https://example.com/report.pdf",
        signal,
        async () => pdfResponse(minimalPdf("Consumption by state")),
        publicAddress,
    );
    expect(output).toContain("No file was saved");
    expect(output).toContain("web_download");
});

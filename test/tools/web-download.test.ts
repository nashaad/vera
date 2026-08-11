import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadPublicFile } from "../../src/tools/web-fetch.ts";
import { webDownloadTool } from "../../src/tools/web-download.ts";

const signal = new AbortController().signal;
const publicAddress = async () => [{
    address: "93.184.216.34",
    family: 4 as const,
}];

const directory = () => mkdtemp(join(tmpdir(), "vera-download-"));

test("web_download declares its own permission operation", () => {
    expect(webDownloadTool).toMatchObject({
        permissionOperation: "web.download",
        definition: { name: "web_download" },
    });
});

test("a download is written to the chosen directory", async () => {
    const into = await directory();
    const { path, bytes } = await downloadPublicFile(
        "https://example.com/report.pdf",
        into,
        signal,
        async () => new Response("file body", {
            headers: { "content-type": "application/pdf" },
        }),
        publicAddress,
    );
    expect(path).toBe(join(into, "report.pdf"));
    expect(bytes).toBe(9);
    expect(await readFile(path, "utf8")).toBe("file body");
});

test("a binary content type is saved rather than refused", async () => {
    const into = await directory();
    const { path } = await downloadPublicFile(
        "https://example.com/logo.png",
        into,
        signal,
        async () => new Response("png bytes", {
            headers: { "content-type": "image/png" },
        }),
        publicAddress,
    );
    expect(path).toBe(join(into, "logo.png"));
});

test("a second download of the same name keeps both files", async () => {
    const into = await directory();
    const get = () => downloadPublicFile(
        "https://example.com/report.pdf",
        into,
        signal,
        async () => new Response("body", {
            headers: { "content-type": "application/pdf" },
        }),
        publicAddress,
    );
    expect((await get()).path).toBe(join(into, "report.pdf"));
    expect((await get()).path).toBe(join(into, "report (1).pdf"));
});

test("the server cannot name a file outside the directory", async () => {
    const into = await directory();
    const canary = join(into, "..", "vera-escape-canary");
    await writeFile(canary, "untouched");
    const { path } = await downloadPublicFile(
        "https://example.com/whatever",
        into,
        signal,
        async () => new Response("body", {
            headers: {
                "content-type": "application/octet-stream",
                "content-disposition":
                    'attachment; filename="../vera-escape-canary"',
            },
        }),
        publicAddress,
    );
    expect(path).toBe(join(into, "vera-escape-canary"));
    expect(await readFile(canary, "utf8")).toBe("untouched");
});

test("a nameless URL still produces a file", async () => {
    const into = await directory();
    const { path } = await downloadPublicFile(
        "https://example.com/",
        into,
        signal,
        async () => new Response("body"),
        publicAddress,
    );
    expect(path).toBe(join(into, "download"));
    expect(await readdir(into)).toEqual(["download"]);
});

test("a private-network download is rejected before anything is written", async () => {
    const into = await directory();
    await expect(downloadPublicFile(
        "https://internal.example.com/secret.pdf",
        into,
        signal,
        async () => new Response("secret"),
        async () => [{ address: "10.0.0.5", family: 4 as const }],
    )).rejects.toThrow("local and private-network");
    expect(await readdir(into)).toEqual([]);
});

test("an oversized download is refused on its declared length", async () => {
    const into = await directory();
    await expect(downloadPublicFile(
        "https://example.com/huge.iso",
        into,
        signal,
        async () => new Response("body", {
            headers: { "content-length": String(200 * 1024 * 1024 + 1) },
        }),
        publicAddress,
    )).rejects.toThrow("exceeds");
    expect(await readdir(into)).toEqual([]);
});

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packWebAssets } from "../../scripts/pack-web.ts";
import { startAnnexServer } from "../../src/annex/server.ts";

const temporaryDirectories: string[] = [];
const servers: { close(): Promise<void> }[] = [];

afterAll(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function tempDir(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function crowExtension(): string {
    const directory = tempDir("vera-annex-ext-");
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id: "acme.crow",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "extension.ts",
        capabilities: [],
        contributes: {
            pages: [{ id: "loot", label: "Loot", server: "server.ts", browser: "page.ts" }],
        },
    }));
    writeFileSync(join(directory, "extension.ts"), "export function activate() {}\n");
    writeFileSync(join(directory, "server.ts"), `
export function activatePage(page) {
    page.route("hoard", (request) => Response.json({
        method: request.method,
        blocks: page.markdownBlocks("# Gold\\n\\n- doubloons"),
    }));
    page.route("relay", async () => {
        try {
            return Response.json({ value: await page.host.request("count", { gold: 3 }) });
        } catch (error) {
            return Response.json({ error: error.message });
        }
    });
}
`);
    writeFileSync(join(directory, "page.ts"), `
const greeting: string = "caw";
export function mount(root: HTMLElement): void { root.textContent = greeting; }
`);
    return directory;
}

async function startWithCrow(hostSocketPath?: string): Promise<string> {
    const webRoot = tempDir("vera-annex-packed-");
    await packWebAssets(webRoot, { force: true });
    const server = await startAnnexServer({
        sessionDirectory: tempDir("vera-annex-sessions-"),
        webRoot,
        extensionDirectories: [crowExtension()],
        ...(hostSocketPath === undefined ? {} : { hostSocketPath }),
    });
    servers.push(server);
    return server.url;
}

test("an extension page is listed, served in the annex shell, and its browser module is transpiled", async () => {
    const url = await startWithCrow();

    const pages = await (await fetch(`${url}api/pages`)).json();
    expect(pages).toEqual({
        pages: [{ extensionId: "acme.crow", pageId: "loot", label: "Loot", href: "/x/acme.crow/loot" }],
    });

    const shell = await fetch(`${url}x/acme.crow/loot`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("<div id=\"root\">");

    const script = await (await fetch(`${url}x/acme.crow/loot/page.js`)).text();
    expect(script).toContain("export function mount");
    expect(script).not.toContain(": string");

    expect((await fetch(`${url}x/acme.crow/other`)).status).toBe(404);
});

test("page routes answer reads from anywhere and writes only from the page's origin", async () => {
    const url = await startWithCrow();
    const route = `${url}x/acme.crow/loot/api/hoard`;

    const read = await (await fetch(route)).json() as { blocks: { kind: string }[] };
    expect(read.blocks.map((block) => block.kind)).toEqual(["heading", "list_item"]);

    const crossSite = await fetch(route, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);
    const noOrigin = await fetch(route, { method: "POST" });
    expect(noOrigin.status).toBe(403);
    const sameOrigin = await fetch(route, { method: "POST", headers: { origin: new URL(url).origin } });
    expect(await sameOrigin.json()).toMatchObject({ method: "POST" });
});

test("a page server reaches its own extension's host handlers, and fails plainly without a host", async () => {
    const socketPath = join(mkdtempSync(join("/private/tmp", "vera-annex-host-")), "host.sock");
    temporaryDirectories.push(join(socketPath, ".."));
    const requests: unknown[] = [];
    const host: Server = createServer((socket) => {
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            const request = JSON.parse(chunk.trim().split("\n")[0] ?? "{}") as Record<string, unknown>;
            requests.push(request);
            socket.end(`${JSON.stringify({ type: "extension_response", value: { counted: 3 } })}\n`);
        });
    });
    await new Promise<void>((resolve) => host.listen(socketPath, resolve));
    try {
        const linked = await startWithCrow(socketPath);
        const answer = await (await fetch(`${linked}x/acme.crow/loot/api/relay`)).json();
        expect(answer).toEqual({ value: { counted: 3 } });
        expect(requests).toEqual([{
            type: "extension_request",
            extensionId: "acme.crow",
            name: "count",
            payload: { gold: 3 },
        }]);

        const alone = await startWithCrow();
        expect(await (await fetch(`${alone}x/acme.crow/loot/api/relay`)).json())
            .toEqual({ error: "This annex has no host to ask" });
    } finally {
        await new Promise<void>((resolve) => host.close(() => resolve()));
    }
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { annexAddress, annexBase, parseExtensionPages, readAnnexPages } from "../../clients/desktop/src/annex-requests.ts";
import { ANNEX_BUILT_IN_PAGES } from "../../src/annex/built-in-pages.ts";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";

const BUILT_IN_PATHS = ANNEX_BUILT_IN_PAGES.map((page) => page.href);

describe("the annex address the desktop window frames", () => {
    test("@core only plain http on a loopback host with a port is accepted", () => {
        expect(annexBase("http://127.0.0.1:8372")).toBe("http://127.0.0.1:8372/");
        expect(annexBase("http://localhost:9000/usage")).toBe("http://localhost:9000/");
        expect(annexBase("https://127.0.0.1:8372/")).toBeUndefined();
        expect(annexBase("http://127.0.0.1/")).toBeUndefined();
        expect(annexBase("http://example.com:8372/")).toBeUndefined();
        expect(annexBase("http://vera.localhost:8372/")).toBeUndefined();
        expect(annexBase("not a url")).toBeUndefined();
    });

    test("@core a page path stays on the annex", () => {
        const base = "http://127.0.0.1:8372/";
        expect(annexAddress(base, "/usage")).toBe("http://127.0.0.1:8372/usage");
        expect(annexAddress(base, "/x/budget/ledger?from=2026")).toBe("http://127.0.0.1:8372/x/budget/ledger?from=2026");
        expect(annexAddress(base, "//example.com/usage")).toBeUndefined();
        expect(annexAddress(base, "/\\example.com/usage")).toBeUndefined();
        expect(annexAddress(base, "usage")).toBeUndefined();
        expect(annexAddress(base, `/${"a".repeat(2_000)}`)).toBeUndefined();
        expect(annexAddress(base, 42)).toBeUndefined();
    });
});

describe("the extension page list", () => {
    test("@core each entry needs a label, an extension and a page path under /x/", () => {
        expect(parseExtensionPages([{ label: "Ledger", href: "/x/budget/ledger", extensionId: "vera.budget" }]))
            .toEqual([{ label: "Ledger", path: "/x/budget/ledger", extensionId: "vera.budget" }]);
        expect(parseExtensionPages([{ label: "Ledger", href: "/usage", extensionId: "vera.budget" }])).toBeUndefined();
        expect(parseExtensionPages([{ label: "Ledger", href: "/x/budget/ledger/more", extensionId: "vera.budget" }])).toBeUndefined();
        expect(parseExtensionPages([{ label: "Ledger", href: "http://example.com/x/a/b", extensionId: "vera.budget" }])).toBeUndefined();
        expect(parseExtensionPages([{ href: "/x/budget/ledger", extensionId: "vera.budget" }])).toBeUndefined();
        expect(parseExtensionPages({ pages: [] })).toBeUndefined();
    });

    test("long labels are cut and an oversized list is refused", () => {
        const [page] = parseExtensionPages([{ label: "L".repeat(500), href: "/x/a/b", extensionId: "a" }]) ?? [];
        expect(page?.label.length).toBe(200);
        const many = Array.from({ length: 201 }, (_, index) => ({ label: `P${index}`, href: `/x/a/p${index}`, extensionId: "a" }));
        expect(parseExtensionPages(many)).toBeUndefined();
    });
});

async function withHost(annexUrl: string, run: (socketPath: string) => Promise<void>): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "vera-annex-pages-"));
    const socketPath = join(directory, "host.sock");
    const server: Server = createServer((socket: Socket) => {
        socket.setEncoding("utf8");
        socket.on("data", () => socket.end(`${JSON.stringify({ type: "annex_url", url: annexUrl })}\n`));
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        await run(socketPath);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
    }
}

socketAndLoopbackTest("@core the window lists the built-in pages and those the annex reports", async () => {
    const annex = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => new URL(request.url).pathname === "/api/pages"
            ? Response.json({ pages: [{ label: "Ledger", href: "/x/budget/ledger", extensionId: "vera.budget" }] })
            : new Response("missing", { status: 404 }),
    });
    try {
        await withHost(`http://127.0.0.1:${annex.port}`, async (socketPath) => {
            const result = await readAnnexPages(socketPath);
            if (!result.ok) throw new Error(result.reason);
            expect(result.url).toBe(`http://127.0.0.1:${annex.port}/`);
            expect(result.pages.map((page) => page.path)).toEqual([...BUILT_IN_PATHS, "/x/budget/ledger"]);
            expect(result.extensionsFailure).toBeUndefined();
        });
    } finally {
        await annex.stop(true);
    }
});

socketAndLoopbackTest("a failed extension list still opens the built-in pages and says why", async () => {
    const annex = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("down", { status: 503 }) });
    try {
        await withHost(`http://127.0.0.1:${annex.port}/`, async (socketPath) => {
            const result = await readAnnexPages(socketPath);
            if (!result.ok) throw new Error(result.reason);
            expect(result.pages.map((page) => page.path)).toEqual(BUILT_IN_PATHS);
            expect(result.extensionsFailure).toBe("The annex answered 503 for its page list.");
        });
    } finally {
        await annex.stop(true);
    }
});

socketAndLoopbackTest("@core an annex the host names off the loopback host is refused", async () => {
    await withHost("http://example.com:8372/", async (socketPath) => {
        const result = await readAnnexPages(socketPath);
        expect(result).toEqual({ ok: false, reason: "The host named an annex at http://example.com:8372/, which this window does not open." });
    });
});

test("no host socket means no pages", async () => {
    expect(await readAnnexPages(undefined)).toEqual({ ok: false, reason: "The host is not running." });
});

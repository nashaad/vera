import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packWebAssets } from "../../scripts/pack-web.ts";
import { annexPathsFromHome } from "../../src/annex/home.ts";
import { exactRoute } from "../../src/annex/routes.ts";
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

async function packedAssets(): Promise<string> {
    const directory = tempDir("vera-annex-packed-");
    await packWebAssets(directory, { force: true });
    return directory;
}

test("a second annex route is served without importing the host", async () => {
    const server = await startAnnexServer({
        sessionDirectory: tempDir("vera-annex-extra-"),
        webRoot: await packedAssets(),
        extraRoutes: [
            exactRoute("/probe", () => new Response("annex-probe")),
        ],
    });
    servers.push(server);
    const response = await fetch(`${server.url}probe`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("annex-probe");
});

test("vera-annex starts by hand against a Vera home", async () => {
    const home = tempDir("vera-annex-home-");
    const assets = await packedAssets();
    const entry = fileURLToPath(
        new URL("../../src/annex/main.ts", import.meta.url),
    );
    const child = Bun.spawn(
        ["bun", entry, "--home", home, "--port", "0", "--assets", assets],
        {
            argv0: "vera-annex",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let url: string | undefined;
    try {
        while (url === undefined) {
            const { value, done } = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, { stream: true });
            const line = buffered.split("\n")[0]?.trim();
            if (line !== undefined && line.startsWith("http://127.0.0.1:")) {
                url = line.endsWith("/") ? line : `${line}/`;
            }
        }
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        const page = await fetch(new URL("usage", url).href);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Vera · Usage");
        const paths = annexPathsFromHome(home);
        expect(paths.sessionDirectory).toContain(home);
    } finally {
        child.kill("SIGTERM");
        await child.exited;
    }
});

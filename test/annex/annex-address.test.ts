import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packWebAssets } from "../../scripts/pack-web.ts";
import { exactRoute } from "../../src/annex/routes.ts";
import { startAnnexServer, type AnnexServer } from "../../src/annex/server.ts";
import {
    annexPortPath,
    DEFAULT_ANNEX_PORT,
    readSavedAnnexPort,
    wantedAnnexPort,
} from "../../src/host/annex-port.ts";
import { startAnnexProcess, type AnnexProcess } from "../../src/host/annex-process.ts";

const temporaryDirectories: string[] = [];
const closers: (() => Promise<void> | void)[] = [];

afterAll(async () => {
    for (const close of closers.splice(0).reverse()) {
        await close();
    }
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function tempDir(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

let packed: string | undefined;
async function packedAssets(): Promise<string> {
    if (packed === undefined) {
        packed = tempDir("vera-annex-address-packed-");
        await packWebAssets(packed, { force: true });
    }
    return packed;
}

async function treasureServer(): Promise<AnnexServer> {
    const server = await startAnnexServer({
        sessionDirectory: tempDir("vera-annex-address-sessions-"),
        webRoot: await packedAssets(),
        extraRoutes: [
            exactRoute("/treasure", ({ request }) => new Response(`${request.method} doubloons`)),
        ],
    });
    closers.push(() => server.close());
    return server;
}

function holdPort(): { readonly port: number; release(): void } {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("crow") });
    const port = holder.port ?? 0;
    let released = false;
    const release = (): void => {
        if (released) return;
        released = true;
        holder.stop(true);
    };
    closers.push(release);
    return { port, release };
}

async function startAnnexFor(home: string, defaultHome?: string): Promise<AnnexProcess> {
    const annex = await startAnnexProcess({
        home,
        assets: await packedAssets(),
        command: [process.execPath, join(import.meta.dir, "../../src/annex/main.ts")],
        ...(defaultHome === undefined ? {} : { defaultHome }),
    });
    closers.push(() => annex.close());
    return annex;
}

function homeWithSavedPort(port: number): string {
    const home = tempDir("vera-annex-address-home-");
    mkdirSync(join(home, "runtime"), { recursive: true });
    writeFileSync(annexPortPath(home), JSON.stringify({ port }));
    return home;
}

test("the annex answers on 127.0.0.1, localhost and vera.localhost", async () => {
    const server = await treasureServer();
    for (const name of ["127.0.0.1", "localhost", "vera.localhost"]) {
        const response = await fetch(`${server.url}treasure`, {
            headers: { host: `${name}:${server.port}` },
        });
        expect(response.status).toBe(200);
    }
});

test("a request naming another host is refused", async () => {
    const server = await treasureServer();
    const response = await fetch(`${server.url}treasure`, {
        headers: { host: `black-flag.example:${server.port}` },
    });
    expect(response.status).toBe(421);
});

test("a POST from another site is refused and one from the annex is served", async () => {
    const server = await treasureServer();
    const post = (origin: string | undefined) => fetch(`${server.url}treasure`, {
        method: "POST",
        headers: origin === undefined ? {} : { origin },
        body: "{}",
    });
    expect((await post("http://black-flag.example")).status).toBe(403);
    expect((await post("null")).status).toBe(403);
    expect((await post(`http://localhost:${server.port + 1}`)).status).toBe(403);
    expect((await post(`http://vera.localhost:${server.port}`)).status).toBe(200);
    expect((await post(`http://127.0.0.1:${server.port}`)).status).toBe(200);
    expect((await post(undefined)).status).toBe(200);
});

test("a busy port fails unless any port will do", async () => {
    const held = holdPort();
    const options = {
        sessionDirectory: tempDir("vera-annex-address-busy-"),
        webRoot: await packedAssets(),
        port: held.port,
    };
    await expect(startAnnexServer(options)).rejects.toThrow();
    const server = await startAnnexServer({ ...options, anyPortIfBusy: true });
    closers.push(() => server.close());
    expect(server.port).not.toBe(held.port);
    expect(server.port).toBeGreaterThan(0);
});

test("a home keeps its annex port across restarts", async () => {
    const free = holdPort();
    free.release();
    const home = homeWithSavedPort(free.port);

    const first = await startAnnexFor(home);
    expect(first.port).toBe(free.port);
    expect(first.url).toBe(`http://127.0.0.1:${free.port}/`);
    expect(first.busyPort).toBeUndefined();
    await first.close();

    const second = await startAnnexFor(home);
    expect(second.port).toBe(free.port);
    expect(readSavedAnnexPort(home)).toBe(free.port);
}, 30_000);

test("a taken port is stood in for one run and asked for again next start", async () => {
    const held = holdPort();
    const home = homeWithSavedPort(held.port);

    const standIn = await startAnnexFor(home);
    expect(standIn.port).not.toBe(held.port);
    expect(standIn.busyPort).toBe(held.port);
    expect(readSavedAnnexPort(home)).toBe(held.port);
    await standIn.close();

    held.release();
    const back = await startAnnexFor(home);
    expect(back.port).toBe(held.port);
    expect(back.busyPort).toBeUndefined();
}, 30_000);

test("a new home other than the default saves a free port, never 8372", async () => {
    const home = tempDir("vera-annex-address-new-");
    const annex = await startAnnexFor(home);
    expect(annex.port).not.toBe(DEFAULT_ANNEX_PORT);
    expect(annex.busyPort).toBeUndefined();
    expect(JSON.parse(readFileSync(annexPortPath(home), "utf8"))).toEqual({ port: annex.port });
}, 30_000);

test("a home other than the default gives up a saved 8372", async () => {
    const home = homeWithSavedPort(DEFAULT_ANNEX_PORT);
    const annex = await startAnnexFor(home);
    expect(annex.port).not.toBe(DEFAULT_ANNEX_PORT);
    expect(annex.busyPort).toBeUndefined();
    expect(readSavedAnnexPort(home)).toBe(annex.port);
}, 30_000);

test("only the default home asks for 8372", () => {
    const home = tempDir("vera-annex-address-want-");
    const other = tempDir("vera-annex-address-other-");
    expect(wantedAnnexPort(home, home)).toEqual({ port: DEFAULT_ANNEX_PORT, saved: false });
    expect(wantedAnnexPort(other, home)).toEqual({ port: undefined, saved: false });

    const pinned = homeWithSavedPort(9_001);
    expect(wantedAnnexPort(pinned, pinned)).toEqual({ port: 9_001, saved: true });
    const squatter = homeWithSavedPort(DEFAULT_ANNEX_PORT);
    expect(wantedAnnexPort(squatter, home)).toEqual({ port: undefined, saved: false });
});

test("the default home saves nothing while 8372 is busy", async () => {
    holdDefaultPort();
    const home = tempDir("vera-annex-address-default-");
    const annex = await startAnnexFor(home, home);
    expect(annex.port).not.toBe(DEFAULT_ANNEX_PORT);
    expect(annex.busyPort).toBe(DEFAULT_ANNEX_PORT);
    expect(existsSync(annexPortPath(home))).toBe(false);
}, 30_000);

// 8372 is often already held by a running Vera; either way it is busy.
function holdDefaultPort(): void {
    try {
        const holder = Bun.serve({
            hostname: "127.0.0.1",
            port: DEFAULT_ANNEX_PORT,
            fetch: () => new Response("crow"),
        });
        closers.push(() => holder.stop(true));
    } catch {
    }
}

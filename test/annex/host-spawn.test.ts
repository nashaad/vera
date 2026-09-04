import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packWebAssets } from "../../scripts/pack-web.ts";
import { readAnnexUrlThroughHost } from "../../src/annex/host-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
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
    const directory = tempDir("vera-annex-spawn-packed-");
    await packWebAssets(directory, { force: true });
    return directory;
}

async function startHost() {
    const root = tempDir("vera-annex-spawn-");
    return await startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        },
        createAdapter: () => new FauxAdapter([]),
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
        webRoot: await packedAssets(),
    });
}

function processArgs(pid: number): string {
    const ran = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="], {
        stdout: "pipe",
        stderr: "pipe",
    });
    return ran.stdout.toString();
}

function processComm(pid: number): string {
    const ran = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="], {
        stdout: "pipe",
        stderr: "pipe",
    });
    return ran.stdout.toString().trim();
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

test("ps shows vera-annex as a separate process from the host", async () => {
    const host = await startHost();
    try {
        const pid = host.annexPid;
        expect(pid).toBeGreaterThan(0);
        expect(pid).not.toBe(process.pid);
        const args = processArgs(pid as number);
        expect(args).toContain("/src/annex/main.ts");
        expect(processComm(pid as number)).toBe("vera-annex");
        expect(host.health.annex).toBe("ok");
    } finally {
        await host.close();
    }
});

test("killing the annex leaves the host up and /usage says it is down", async () => {
    const host = await startHost();
    try {
        const pid = host.annexPid as number;
        const before = await host.registry.list();
        process.kill(pid, "SIGKILL");
        const started = Date.now();
        while (host.health.annex === "ok" && Date.now() - started < 3_000) {
            await Bun.sleep(50);
        }
        expect(host.health.annex).toBe("failed");
        const result = await readAnnexUrlThroughHost(host.server.socketPath);
        expect("unavailable" in result).toBe(true);
        if (!("unavailable" in result)) {
            throw new Error("expected annex unavailable");
        }
        expect(result.unavailable).toContain("Restart the host to bring the annex back");
        expect(await host.registry.list()).toEqual(before);
        expect(processAlive(process.pid)).toBe(true);
    } finally {
        await host.close();
    }
});

test("host exit leaves no orphan annex", async () => {
    const host = await startHost();
    const pid = host.annexPid as number;
    expect(processAlive(pid)).toBe(true);
    await host.close();
    const started = Date.now();
    while (processAlive(pid) && Date.now() - started < 3_000) {
        await Bun.sleep(50);
    }
    expect(processAlive(pid)).toBe(false);
});

test("an annex outlives no host, even one that never got to clean up", async () => {
    const assets = await packedAssets();
    const home = tempDir("vera-annex-orphan-");
    const owner = tempDir("vera-annex-owner-");
    const script = join(owner, "owner.ts");
    // A host killed with SIGKILL never reaches stopAnnexChild, so the only
    // thing left to end the annex is the stdin pipe closing with its parent.
    await Bun.write(
        script,
        `import { startAnnexProcess } from ${
            JSON.stringify(join(import.meta.dir, "../../src/host/annex-process.ts"))
        };
const annex = await startAnnexProcess({
    home: ${JSON.stringify(home)},
    assets: ${JSON.stringify(assets)},
    command: [${JSON.stringify(process.execPath)}, ${
            JSON.stringify(join(import.meta.dir, "../../src/annex/main.ts"))
        }],
});
process.stdout.write(String(annex.pid) + "\\n");
await new Promise(() => {});
`,
    );

    const parent = Bun.spawn([process.execPath, script], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const reader = parent.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        seen += decoder.decode(chunk.value);
    }
    const annexPid = Number(seen.trim());
    expect(Number.isInteger(annexPid)).toBe(true);
    expect(processAlive(annexPid)).toBe(true);

    parent.kill("SIGKILL");
    await parent.exited;

    const started = Date.now();
    while (processAlive(annexPid) && Date.now() - started < 5_000) {
        await Bun.sleep(50);
    }
    expect(processAlive(annexPid)).toBe(false);
}, 30_000);

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SUPERVISED_HOST_ENV } from "../../src/host/supervision.ts";

const hostEntry = fileURLToPath(
    new URL("../../clients/host/main.ts", import.meta.url),
);

const directories: string[] = [];
const servers: Server[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) {
        child.kill("SIGKILL");
        await child.exited;
    }
    for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

interface DamagedHome {
    readonly home: string;
    readonly lockPath: string;
}

// A home whose lockfile is garbage and whose socket answers nothing.
async function damagedHome(): Promise<DamagedHome> {
    const home = mkdtempSync(join(tmpdir(), "vera-host-damaged-"));
    directories.push(home);
    const runtime = join(home, "runtime");
    mkdirSync(runtime, { recursive: true });
    const lockPath = join(runtime, "host.json");
    writeFileSync(lockPath, "garbage");
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(runtime, "host.sock"), () => resolve());
    });
    return { home, lockPath };
}

function startHost(home: string, supervised: boolean): {
    readonly child: Bun.Subprocess<"ignore", "ignore", "pipe">;
    readonly stderr: () => string;
} {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== SUPERVISED_HOST_ENV) env[key] = value;
    }
    env.VERA_HOME = home;
    if (supervised) env[SUPERVISED_HOST_ENV] = "1";
    const child = Bun.spawn([process.execPath, hostEntry], {
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
    });
    children.push(child);
    let text = "";
    void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of child.stderr) {
            text += decoder.decode(chunk, { stream: true });
        }
    })();
    return { child, stderr: () => text };
}

async function until(condition: () => boolean, limitMs: number): Promise<boolean> {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return condition();
}

test("a host started outside launchd prints the lockfile message and exits 1", async () => {
    const { home, lockPath } = await damagedHome();
    const { child, stderr } = startHost(home, false);

    const code = await Promise.race([
        child.exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 30_000)),
    ]);

    expect(code).toBe(1);
    expect(stderr()).toContain(lockPath);
    expect(stderr()).toContain("cannot tell whether a Vera host is running");
    expect(stderr()).not.toMatch(/^\s+at /m);
    expect(stderr()).not.toContain("HostLockUnreadableError");
}, 40_000);

test("a supervised host keeps waiting on a damaged lockfile", async () => {
    const { home, lockPath } = await damagedHome();
    const { child, stderr } = startHost(home, true);

    const reported = await until(() => stderr().includes(lockPath), 30_000);
    expect(reported).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(child.exitCode).toBeNull();
    expect(stderr().split(lockPath).length - 1).toBe(1);
    expect(stderr()).not.toMatch(/^\s+at /m);
}, 40_000);

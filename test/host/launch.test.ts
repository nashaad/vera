import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    hostEntrypointMismatchNotice,
    residentHostEntrypoint,
} from "../../clients/host/launch.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";

interface DetachedHostResult {
    readonly starterPid: number;
    readonly host: HostLockRecord;
    readonly agentId: string;
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "the first client starts a detached host that survives and accepts attach",
    async () => {
        const home = await mkdtemp(join(tmpdir(), "vera-detached-host-"));
        const veraDirectory = join(home, ".vera");
        let hostPid: number | undefined;
        await mkdir(veraDirectory, { recursive: true });
        await writeFile(join(veraDirectory, "config.json"), `${JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        })}\n`);

        try {
            const child = Bun.spawn([
                process.execPath,
                "test/support/detached-host-child.ts",
            ], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HOME: home,
                    OPENROUTER_API_KEY: "test-only-key",
                },
                stdout: "pipe",
                stderr: "pipe",
            });
            const [exitCode, output, errorOutput] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            expect(exitCode, errorOutput).toBe(0);
            const result = JSON.parse(output) as DetachedHostResult;
            hostPid = result.host.pid;
            expect(result.host.pid).not.toBe(result.starterPid);
            expect(processIsAlive(result.host.pid)).toBe(true);

            const client = await attachAgent({
                socketPath: result.host.socket_path,
                agentId: result.agentId,
            });
            expect((await client.receive()).type).toBe("history");
            await client.detach();

            const lock = JSON.parse(
                await readFile(join(veraDirectory, "host.json"), "utf8"),
            ) as HostLockRecord;
            expect(lock).toEqual(result.host);
            expect(lock.entrypoint?.endsWith("clients/host/main.ts"))
                .toBe(true);
        } finally {
            if (hostPid !== undefined && processIsAlive(hostPid)) {
                process.kill(hostPid, "SIGTERM");
                await waitForProcessExit(hostPid);
            }
            await rm(home, { recursive: true, force: true });
        }
    },
    10_000,
);

function lockRecord(entrypoint?: string): HostLockRecord {
    return {
        schema_version: 2,
        pid: 101,
        started_at: "2026-08-06T12:00:00.000Z",
        socket_path: "/tmp/vera-test.sock",
        ...(entrypoint === undefined ? {} : { entrypoint }),
    };
}

test("a host stamped from another checkout produces the mismatch warning", () => {
    const notice = hostEntrypointMismatchNotice(
        lockRecord("/checkouts/other/clients/host/main.ts"),
    );

    expect(notice).toContain("/checkouts/other/clients/host/main.ts");
    expect(notice).toContain(residentHostEntrypoint());
});

test("a host stamped with this checkout's entrypoint produces no warning", () => {
    expect(hostEntrypointMismatchNotice(lockRecord(residentHostEntrypoint())))
        .toBeUndefined();
});

test("a record without an entrypoint produces no warning", () => {
    expect(hostEntrypointMismatchNotice(lockRecord())).toBeUndefined();
});

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!processIsAlive(pid)) {
            return;
        }
        await Bun.sleep(10);
    }
    throw new Error(`Detached host ${pid} did not exit`);
}

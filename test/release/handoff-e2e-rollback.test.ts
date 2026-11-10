import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launcherRelaunch } from "../../clients/tui/restart-notice.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { activateRelease } from "../../src/release/activate.ts";
import { takeRelaunchRecord, writeRelaunchRecord } from "../../src/release/relaunch.ts";
import { rollbackLocalInstall } from "../../src/release/rollback.ts";
import { defaultEnsureHost } from "../../src/release/upgrade.ts";
import { cloneRelease, createFixture, currentBuild, processAlive, readHostLock, stopHostProcess, waitUntil } from "../support/handoff-e2e.ts";

for (const supported of [true, false]) {
    test(supported ? "rollback hands an open session and draft to the retained build" : "rollback to an unsupported build keeps the old stop behavior", async () => {
        const previousHome = process.env.VERA_HOME;
        const env = await createFixture();
        process.env.VERA_HOME = env.home;
        let oldClient: Awaited<ReturnType<typeof attachReconnectingAgent>> | undefined;
        let newClient: Awaited<ReturnType<typeof attachReconnectingAgent>> | undefined;
        let rollback: ReturnType<typeof rollbackLocalInstall> | undefined;
        let cli: { readonly exitCode: number | null; kill(): void; readonly exited: Promise<number> } | undefined;
        let cliResult: Promise<readonly [number, string, string]> | undefined;
        try {
            const path = join(env.build1Root, "manifest.json");
            const manifest = JSON.parse(readFileSync(path, "utf8"));
            manifest.product_version = "0.1.0-alpha.0";
            if (!supported) {
                delete manifest.relaunch_record_version;
            }
            writeFileSync(path, JSON.stringify(manifest));
            const currentId = "vera-e2e-rollback-current";
            const currentRoot = cloneRelease(env.build1Root, env.prefix, currentId);
            activateRelease(currentRoot, env.prefix);
            await defaultEnsureHost(currentRoot, { operation: "install" });
            await waitUntil(() => readHostLock(env.home)?.build_id === currentId, 15_000, "current host");
            const oldPid = readHostLock(env.home)!.pid;
            const socketPath = join(env.home, "runtime", "host.sock");
            const agent = await createAgentThroughHost(socketPath, env.workspace, "auto");
            oldClient = await attachReconnectingAgent({ socketPath: () => socketPath, agentId: agent.id, buildId: currentId });
            const events: string[] = [];
            let exitCode: number | undefined;
            const relaunch = launcherRelaunch("123", {
                writeRecord: (key, record) => writeRelaunchRecord(key, record, env.home),
                markTerminalRestored: () => {},
                exit: (code) => { exitCode = code; },
            })!;
            oldClient.onStopWait((event) => {
                events.push(event.type);
                if (event.type === "host_restarting") {
                    void relaunch({ sessionId: agent.id, draft: { text: "unfinished crow", attachmentIds: [] } });
                }
            });
            oldClient.send({ type: "prompt", content: "hello crow" });
            await waitUntil(() => env.stub.requests() > 0, 20_000, "held turn");
            if (supported) {
                const { VERA_INSTALL_PREFIX: _prefix, ...baseEnv } = process.env;
                const child = Bun.spawn([join(env.prefix, "bin", "vera"), "rollback"], {
                    env: { ...baseEnv, HOME: env.workspace, VERA_HOME: env.home },
                    stdout: "pipe",
                    stderr: "pipe",
                });
                cli = child;
                cliResult = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            } else {
                rollback = rollbackLocalInstall(env.prefix);
                rollback.catch(() => undefined);
            }
            await Bun.sleep(500);
            if (supported) expect(currentBuild(env.prefix)).toBe(currentId);
            env.stub.release();
            if (cliResult !== undefined) {
                const [code, stdout, stderr] = await cliResult;
                expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: `Activated ${env.build1}\n` });
            } else {
                expect((await rollback)?.kind).toBe("rolled_back");
            }
            await waitUntil(() => !processAlive(oldPid), 10_000, "old host exit");
            expect(currentBuild(env.prefix)).toBe(env.build1);
            expect(readHostLock(env.home)?.build_id).toBe(env.build1);
            if (supported) {
                await waitUntil(() => exitCode === 85, 10_000, "relaunch notice");
                const record = takeRelaunchRecord("123", Date.now(), env.home);
                expect(record).toMatchObject({ sessionId: agent.id, draft: { text: "unfinished crow", attachmentIds: [] } });
                oldClient.close();
                newClient = await attachReconnectingAgent({ socketPath: () => socketPath, agentId: record!.sessionId!, buildId: env.build1 });
                newClient.send({ type: "prompt", content: "another crow" });
                await waitUntil(() => env.stub.requests() >= 2, 20_000, "continued session turn");
            } else {
                expect(events).not.toContain("host_restarting");
                expect(exitCode).toBeUndefined();
                await expect(attachReconnectingAgent({ socketPath: () => socketPath, agentId: agent.id, buildId: currentId }))
                    .rejects.toThrow("Quit and reopen Vera.");
            }
        } finally {
            env.stub.release();
            oldClient?.close();
            newClient?.close();
            if (cli !== undefined && cli.exitCode === null) {
                cli.kill();
                await cli.exited;
            }
            await rollback?.catch(() => undefined);
            await stopHostProcess(env.home);
            env.cleanup();
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
        }
    }, 120_000);
}

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { installRelease } from "../../src/release/install.ts";
import { defaultEnsureHost } from "../../src/release/upgrade.ts";
import {
    cloneRelease,
    createFixture,
    currentBuild,
    type HandoffFixture,
    processAlive,
    readHostLock,
    stopHostProcess,
    waitUntil,
} from "../support/handoff-e2e.ts";

let fixture: HandoffFixture | undefined;
let previousHome: string | undefined;

afterEach(async () => {
    if (fixture !== undefined) {
        await stopHostProcess(fixture.home).catch(() => undefined);
        fixture.cleanup();
        fixture = undefined;
    }
    if (previousHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousHome;
});

test("an install whose new host does not start restores the previous build", async () => {
    fixture = await createFixture();
    const env = fixture;
    previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = env.home;
    const broken = "vera-e2e-broken";

    await defaultEnsureHost(env.build1Root, { operation: "install" });
    await waitUntil(() => readHostLock(env.home)?.build_id === env.build1, 15_000, "build 1 lock");
    const oldPid = readHostLock(env.home)!.pid;

    const socketPath = join(env.home, "runtime", "host.sock");
    const agent = await createAgentThroughHost(socketPath, env.workspace, "auto");
    const client = await attachReconnectingAgent({
        socketPath: () => socketPath,
        agentId: agent.id,
        buildId: env.build1,
    });
    client.send({ type: "prompt", content: "hello crow" });
    await waitUntil(() => env.stub.requests() > 0, 20_000, "the held turn");

    const brokenRoot = cloneRelease(env.build1Root, env.prefix, broken, { brokenHost: true });
    const manifest = JSON.parse(readFileSync(join(brokenRoot, "manifest.json"), "utf8"));
    const reports: string[] = [];
    const install = installRelease({
        prefix: env.prefix,
        pack: async () => ({ releaseRoot: brokenRoot, manifest }),
        report: (line) => reports.push(line),
    });

    await Bun.sleep(2_000);
    expect(currentBuild(env.prefix)).toBe(env.build1);

    env.stub.release();
    const outcome = await install;
    client.close();

    expect(outcome.kind).toBe("restored");
    expect(outcome).toMatchObject({ buildId: broken, runningBuildId: env.build1 });
    expect(String((outcome as { message?: unknown }).message)).toContain("restored");
    expect(currentBuild(env.prefix)).toBe(env.build1);
    // The old host restores the build itself and exits after the restored host publishes.
    await waitUntil(() => !processAlive(oldPid), 10_000, "the old host to exit");
    const lock = readHostLock(env.home);
    expect(lock?.build_id).toBe(env.build1);
    expect(lock?.pid).not.toBe(oldPid);
    expect(processAlive(lock!.pid)).toBe(true);
}, 120_000);

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { importSessionThroughHost } from "../../src/host/session-import-client.ts";
import { installRelease } from "../../src/release/install.ts";
import { activateRelease } from "../../src/release/activate.ts";
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

test("an install waits for the running turn, then moves current and the host", async () => {
    fixture = await createFixture();
    const env = fixture;
    previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = env.home;
    const build2 = "vera-e2e-update";
    const extension = join(env.workspace, "extension");
    const marker = join(env.workspace, "extension-activated");
    mkdirSync(extension);
    writeFileSync(join(extension, "vera.extension.json"), JSON.stringify({
        id: "test.bundled", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: ["hooks.session_start"],
    }));
    writeFileSync(join(extension, "extension.ts"),
        `import { writeFileSync } from "node:fs"; export function activate() { writeFileSync(${JSON.stringify(marker)}, "active"); }`);
    const configPath = join(env.home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.extensions = [{ path: extension, enabled: true, config: {} }];
    writeFileSync(configPath, JSON.stringify(config));

    await defaultEnsureHost(env.build1Root, { operation: "install" });
    await waitUntil(() => readHostLock(env.home)?.build_id === env.build1, 15_000, "build 1 lock");
    const oldPid = readHostLock(env.home)!.pid;

    const socketPath = join(env.home, "runtime", "host.sock");
    const agent = await createAgentThroughHost(socketPath, env.workspace, "auto");
    await waitUntil(() => existsSync(marker), 10_000, "disk extension activation");
    const importPath = join(env.workspace, "unknown.jsonl");
    writeFileSync(importPath, '{"hello":"crow"}\n');
    expect(await importSessionThroughHost(socketPath, importPath)).toEqual({ status: "rejected", reason: "unrecognized" });
    const client = await attachReconnectingAgent({
        socketPath: () => socketPath,
        agentId: agent.id,
        buildId: env.build1,
    });
    client.send({ type: "prompt", content: "hello crow" });
    await waitUntil(() => env.stub.requests() > 0, 20_000, "the held turn");

    const build2Root = cloneRelease(env.build1Root, env.prefix, build2);
    const manifest = JSON.parse(readFileSync(join(build2Root, "manifest.json"), "utf8"));
    const reports: string[] = [];
    const install = installRelease({
        prefix: env.prefix,
        pack: async () => ({ releaseRoot: build2Root, manifest }),
        report: (line) => reports.push(line),
    });

    await Bun.sleep(2_000);
    expect(reports.some((line) => line.startsWith("Waiting for running turns"))).toBe(true);
    expect(currentBuild(env.prefix)).toBe(env.build1);
    expect(processAlive(oldPid)).toBe(true);

    env.stub.release();
    const outcome = await install;
    client.close();

    expect(outcome).toEqual({ kind: "updated", buildId: build2 });
    expect(currentBuild(env.prefix)).toBe(build2);
    // The old host exits just after it hands the lock over, so the install can return first.
    await waitUntil(() => !processAlive(oldPid), 10_000, "the old host to exit");
    const lock = readHostLock(env.home);
    expect(lock?.build_id).toBe(build2);
    expect(processAlive(lock!.pid)).toBe(true);
}, 120_000);

test("handoff moves from a source release to a bundle and back", async () => {
    fixture = await createFixture();
    const env = fixture;
    previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = env.home;
    const sourceId = "vera-e2e-source";
    const sourceRoot = cloneRelease(env.build1Root, env.prefix, sourceId);
    const entries: ReadonlyArray<readonly [string, string]> = [
        ["bundle/clients/cli/main.js", "clients/cli/main.ts"],
        ["bundle/clients/host/main.js", "clients/host/main.ts"],
        ["bundle/clients/host/session-worker.js", "clients/host/session-worker.ts"],
        ["bundle/src/host/worker/entry.js", "src/host/worker/entry.ts"],
        ["bundle/src/annex/main.js", "src/annex/main.ts"],
        ["bundle/src/host/worker-supervisor.js", "src/host/worker-supervisor.ts"],
    ];
    for (const name of ["vera", "host", "session-worker", "worker", "vera-annex", "vera-supervisor"]) {
        const path = join(sourceRoot, name);
        let wrapper = readFileSync(path, "utf8");
        for (const [bundled, source] of entries) wrapper = wrapper.replaceAll(bundled, source);
        writeFileSync(path, wrapper);
    }
    rmSync(join(sourceRoot, "bundle"), { recursive: true, force: true });
    activateRelease(sourceRoot, env.prefix);
    await defaultEnsureHost(sourceRoot, { operation: "install" });
    await waitUntil(() => readHostLock(env.home)?.build_id === sourceId, 15_000, "source host lock");
    const sourcePid = readHostLock(env.home)!.pid;
    await createAgentThroughHost(join(env.home, "runtime", "host.sock"), env.workspace, "auto");
    const hostLog = join(env.home, "runtime", "logs", "host.jsonl");
    await waitUntil(() => existsSync(hostLog) && readFileSync(hostLog, "utf8").includes("host_startup_complete"), 10_000, "source host startup");
    const bundledId = "vera-e2e-bundled";
    const bundledRoot = cloneRelease(env.build1Root, env.prefix, bundledId);
    const bundledManifest = JSON.parse(readFileSync(join(bundledRoot, "manifest.json"), "utf8"));
    const forward = await installRelease({
        prefix: env.prefix,
        pack: async () => ({ releaseRoot: bundledRoot, manifest: bundledManifest }),
        report: () => {},
    });
    expect(forward).toMatchObject({ kind: "updated" });
    await waitUntil(() => !processAlive(sourcePid), 10_000, "source host exit");
    expect(readHostLock(env.home)?.build_id).toBe(bundledId);
    const bundledPid = readHostLock(env.home)!.pid;
    const sourceManifest = JSON.parse(readFileSync(join(sourceRoot, "manifest.json"), "utf8"));
    const backward = await installRelease({
        prefix: env.prefix,
        pack: async () => ({ releaseRoot: sourceRoot, manifest: sourceManifest }),
        report: () => {},
    });
    expect(backward).toMatchObject({ kind: "updated" });
    await waitUntil(() => !processAlive(bundledPid), 10_000, "bundled host exit");
    expect(readHostLock(env.home)?.build_id).toBe(sourceId);
}, 120_000);

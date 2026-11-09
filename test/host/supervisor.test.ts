import { expect, test } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { controlSocketPath, startSessionWorkerSupervisor, WorkerGenerations } from "../../src/host/pool/supervisor.ts";

test("worker generations increase independently for each worker id", () => {
    const generations = new WorkerGenerations();
    expect(generations.next("w0")).toBe(1);
    expect(generations.next("w1")).toBe(1);
    expect(generations.next("w0")).toBe(2);
    expect(generations.next("w1")).toBe(2);
});

socketTest("a worker that exits before ready is reaped", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs4-supervisor-");
    await mkdir(join(home, "runtime"));
    let pid: number | undefined;
    try {
        await expect(startSessionWorkerSupervisor({
            home,
            socket: join(home, "runtime", "w0.sock"),
            generation: 1,
            bootstrap: {
                options: { home, config: { schema_version: 1, provider: "openrouter", model: "stub", approval_mode: "auto" } },
                hostSocket: join(home, "runtime", "host.sock"),
                lockPath: join(home, "runtime", "host.json"), buildId: "test", capabilities: [],
                extensionCatalog: { extensionOrder: [], toolCatalog: [], commandCatalog: [] },
            },
            handler: async () => undefined,
            onEvent: () => {},
            onConnected: () => {},
            onSpawn: (value) => { pid = value; },
            spawnSpec: { command: process.execPath, args: ["-e", "process.exit(7)"] },
        })).rejects.toThrow("exited before ready");
        expect(pid).toBeDefined();
        expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

test("control socket paths enforce the macOS byte limit", () => {
    const prefix = "/private/tmp/";
    const suffix = "/runtime/control.sock";
    const home = prefix + "a".repeat(103 - Buffer.byteLength(prefix + suffix));
    expect(Buffer.byteLength(controlSocketPath(home))).toBe(103);
    expect(() => controlSocketPath(`${home}a`)).toThrow("103-byte limit");
});

import { expect, test } from "bun:test";
import { join } from "node:path";

import { evictHome } from "../../scripts/dev-tui.ts";

test("a stale home-process listing cannot signal an unrelated process", async () => {
    const unrelated = Bun.spawn(["/bin/sleep", "60"], {
        env: {},
        stdout: "ignore",
        stderr: "ignore",
    });
    const messages: string[] = [];
    try {
        const result = await evictHome(process.env.VERA_HOME!, {
            write: (message) => messages.push(message),
        }, {
            processesUsingHome: () => [{ pid: unrelated.pid, startedAt: "previous process" }],
            sigtermGraceMs: 0,
            sigkillGraceMs: 0,
        });
        expect(result).toBe(1);
        expect(messages.join("")).toContain(`Could not verify PID ${unrelated.pid}`);
        expect(unrelated.exitCode).toBeNull();
        process.kill(unrelated.pid, 0);
    } finally {
        unrelated.kill("SIGTERM");
        await unrelated.exited;
    }
});

test("eviction checks the same start time again before SIGKILL", async () => {
    const child = Bun.spawn([process.execPath, "-e", [
        "process.on('SIGTERM', () => {});",
        "console.log('ready');",
        "setInterval(() => {}, 1000);",
    ].join(" ")], { env: {}, stdout: "pipe", stderr: "ignore" });
    try {
        await child.stdout.getReader().read();
        let checks = 0;
        const messages: string[] = [];
        const result = await evictHome(process.env.VERA_HOME!, {
            write: (message) => messages.push(message),
        }, {
            processesUsingHome: () => [{ pid: child.pid, startedAt: "original process" }],
            processStartTime: () => checks++ === 0 ? "original process" : "replacement process",
            sigtermGraceMs: 0,
            sigkillGraceMs: 0,
        });
        expect(result).toBe(1);
        expect(checks).toBe(2);
        expect(messages.join("")).toContain(`Could not verify PID ${child.pid}`);
        expect(child.exitCode).toBeNull();
        process.kill(child.pid, 0);
    } finally {
        child.kill("SIGKILL");
        await child.exited;
    }
});

test("eviction stops a process whose home and start time were verified", async () => {
    const home = join(process.env.VERA_TEST_TEMP_BASE!, `evict-${process.pid}`);
    const child = Bun.spawn([process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000);"], {
        env: { VERA_HOME: home },
        stdout: "pipe",
        stderr: "ignore",
    });
    try {
        await child.stdout.getReader().read();
        expect(await evictHome(home, { write: () => {} })).toBe(0);
        const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
        expect(exited).toBe(true);
    } finally {
        child.kill("SIGKILL");
        await child.exited;
    }
});

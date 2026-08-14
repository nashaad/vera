import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";

import type { OwnedSidecarContribution } from "../../src/extensions/contribution-set.ts";
import {
    startSidecarRuntime,
    SupervisedSidecar,
    type SidecarStatus,
} from "../../src/host/sidecar-runtime.ts";

const FAST_TIMING = {
    baseBackoffMs: 20,
    maxBackoffMs: 40,
    healthyRunMs: 60_000,
    failureWindowMs: 60_000,
    failuresBeforeQuarantine: 3,
    stopGraceMs: 500,
};

function contribution(
    directory: string,
    command: readonly string[],
    overrides: Partial<OwnedSidecarContribution["definition"]> = {},
): OwnedSidecarContribution {
    return {
        id: "acme.tools/worker",
        localId: "worker",
        extensionId: "acme.tools",
        extensionDirectory: directory,
        definition: {
            id: "worker",
            command,
            env: {},
            restart: true,
            ...overrides,
        },
    };
}

async function scratch(): Promise<string> {
    return realpath(await mkdtemp(join(tmpdir(), "vera-sidecar-")));
}

async function until(
    predicate: () => boolean,
    timeoutMs = 5_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("condition did not hold in time");
        }
        await Bun.sleep(10);
    }
}

test("a sidecar starts with the extension cwd, env, and VERA_SOCKET", async () => {
    const root = await scratch();
    try {
        const task = new SupervisedSidecar({
            sidecar: contribution(root, [
                "sh",
                "-c",
                'echo "$PWD|$VERA_SOCKET|$SIDE_FLAVOR"; sleep 60',
            ], { env: { SIDE_FLAVOR: "mint" } }),
            socketPath: join(root, "host.sock"),
            logPath: join(root, "logs", "worker.log"),
            timing: FAST_TIMING,
        });
        task.start();
        await until(() => task.status().state === "running");
        await until(() => {
            try {
                return Bun.file(join(root, "logs", "worker.log")).size > 0;
            } catch {
                return false;
            }
        });
        const logged = await readFile(join(root, "logs", "worker.log"), "utf8");
        expect(logged.trim()).toBe(
            `${root}|${join(root, "host.sock")}|mint`,
        );
        expect(task.status().pid).not.toBeNull();
        await task.stop();
        expect(task.status().state).toBe("stopped");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a crashing sidecar restarts, then quarantines at the threshold", async () => {
    const root = await scratch();
    try {
        const states: SidecarStatus[] = [];
        const task = new SupervisedSidecar({
            sidecar: contribution(root, ["sh", "-c", "exit 3"]),
            socketPath: join(root, "host.sock"),
            logPath: join(root, "worker.log"),
            timing: FAST_TIMING,
            onStateChange: (status) => states.push(status),
        });
        task.start();
        await until(() => task.status().state === "quarantined");
        expect(states.some((status) => status.state === "backoff")).toBe(true);
        expect(task.status().failures).toBe(
            FAST_TIMING.failuresBeforeQuarantine,
        );
        expect(task.status().lastError).toContain("exited with code 3");
        await task.stop();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("stop terminates a running child and is not recorded as a crash", async () => {
    const root = await scratch();
    try {
        const pidFile = join(root, "pid");
        const task = new SupervisedSidecar({
            sidecar: contribution(root, [
                "sh",
                "-c",
                `echo $$ > ${pidFile}; sleep 60`,
            ]),
            socketPath: join(root, "host.sock"),
            logPath: join(root, "worker.log"),
            timing: FAST_TIMING,
        });
        task.start();
        await until(() => task.status().state === "running");
        await until(() => Bun.file(pidFile).size > 0);
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        await task.stop();
        expect(task.status().state).toBe("stopped");
        expect(task.status().lastError).toBeNull();
        expect(() => process.kill(pid, 0)).toThrow();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a stubborn child is SIGKILLed after the grace period", async () => {
    const root = await scratch();
    try {
        const pidFile = join(root, "pid");
        const task = new SupervisedSidecar({
            sidecar: contribution(root, [
                "sh",
                "-c",
                `trap "" TERM; echo $$ > ${pidFile}; while true; do sleep 1; done`,
            ]),
            socketPath: join(root, "host.sock"),
            logPath: join(root, "worker.log"),
            timing: { ...FAST_TIMING, stopGraceMs: 100 },
        });
        task.start();
        await until(() => Bun.file(pidFile).size > 0);
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        await task.stop();
        expect(task.status().state).toBe("stopped");
        await until(() => {
            try {
                process.kill(pid, 0);
                return false;
            } catch {
                return true;
            }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("restart:false runs once and stays stopped after a clean exit", async () => {
    const root = await scratch();
    try {
        const marker = join(root, "ran");
        const task = new SupervisedSidecar({
            sidecar: contribution(
                root,
                ["sh", "-c", `echo once >> ${marker}`],
                { restart: false },
            ),
            socketPath: join(root, "host.sock"),
            logPath: join(root, "worker.log"),
            timing: FAST_TIMING,
        });
        task.start();
        await until(() => task.status().state === "stopped");
        await Bun.sleep(100);
        expect((await readFile(marker, "utf8")).trim()).toBe("once");
        await task.stop();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("restart:false quarantines on a failing exit instead of looping", async () => {
    const root = await scratch();
    try {
        const task = new SupervisedSidecar({
            sidecar: contribution(root, ["sh", "-c", "exit 7"], {
                restart: false,
            }),
            socketPath: join(root, "host.sock"),
            logPath: join(root, "worker.log"),
            timing: FAST_TIMING,
        });
        task.start();
        await until(() => task.status().state === "quarantined");
        expect(task.status().lastError).toContain("exited with code 7");
        await task.stop();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an unspawnable command counts as a failure, not a crash of the host", async () => {
    const root = await scratch();
    try {
        const task = new SupervisedSidecar({
            sidecar: contribution(root, ["/does/not/exist"]),
            socketPath: join(root, "host.sock"),
            logPath: join(root, "worker.log"),
            timing: FAST_TIMING,
        });
        task.start();
        await until(() => task.status().state === "quarantined");
        expect(task.status().lastError).toContain("sidecar");
        await task.stop();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the runtime names each log after the canonical sidecar id", async () => {
    const root = await scratch();
    try {
        const runtime = startSidecarRuntime({
            sidecars: [contribution(root, ["sh", "-c", "echo hi; sleep 60"])],
            socketPath: join(root, "host.sock"),
            logDirectory: join(root, "logs"),
            timing: FAST_TIMING,
        });
        try {
            await until(() =>
                runtime.statuses().some((status) => status.state === "running")
            );
            const [status] = runtime.statuses();
            expect(status?.logPath).toBe(join(root, "logs", "acme.tools.worker.log"));
        } finally {
            await runtime.close();
        }
        expect(runtime.statuses().every((status) => status.state === "stopped"))
            .toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

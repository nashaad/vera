import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HOST = fileURLToPath(new URL("./fixtures/worker-lifeline-host.ts", import.meta.url));

type Mode = "before" | "idle" | "foreground" | "background" | "adapter-pending"
    | "provider-pending" | "extension-pending" | "extension-release" | "extension-dispose-hang" | "cleanup-hang";
type Disconnect = "close" | "kill";

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        const state = spawnSync("ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" });
        return state.status !== 0 || !state.stdout.trim().startsWith("Z");
    } catch {
        return false;
    }
}

async function waitUntilGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (alive(pid) && Date.now() < until) await Bun.sleep(20);
    return !alive(pid);
}

function readPid(path: string): number | undefined {
    if (!existsSync(path)) return undefined;
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

interface ProcessIdentity {
    pid: number;
    parent: number;
    group: number;
    started: string;
}

function identity(pid: number): ProcessIdentity | undefined {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "pgid=", "-o", "lstart="], {
        encoding: "utf8",
    });
    const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match === null) return undefined;
    return { pid, parent: Number(match[1]), group: Number(match[2]), started: match[3]! };
}

function trackProcess(pid: number, group = pid): ProcessIdentity {
    const found = identity(pid);
    if (found === undefined || found.group !== group) throw new Error(`Cannot verify process ${pid} in group ${group}`);
    return found;
}

function killGroup(owned: ProcessIdentity | undefined): void {
    if (owned === undefined) return;
    const current = identity(owned.pid);
    if (current === undefined || current.group !== owned.group || current.started !== owned.started) return;
    try {
        process.kill(-owned.group, "SIGKILL");
    } catch {
        if (alive(owned.pid)) process.kill(owned.pid, "SIGKILL");
    }
}

function killProcess(owned: ProcessIdentity | undefined): void {
    if (owned === undefined) return;
    const current = identity(owned.pid);
    if (current === undefined || current.group !== owned.group || current.started !== owned.started) return;
    if (alive(owned.pid)) process.kill(owned.pid, "SIGKILL");
}

interface HostStatus {
    worker?: number;
    tool?: number;
    toolChild?: number;
    ready?: boolean;
}

function hostReady(host: ChildProcess, onStatus: (status: HostStatus) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const lines = createInterface({ input: host.stdout! });
        const timer = setTimeout(() => reject(new Error("Host fixture did not become ready")), 5_000);
        lines.on("line", (line) => {
            try {
                const status = JSON.parse(line) as HostStatus;
                onStatus(status);
                if (status.ready === true) {
                    clearTimeout(timer);
                    lines.close();
                    resolve();
                }
            } catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        });
        host.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("Host fixture exited before becoming ready"));
        });
    });
}

async function checkLifeline(
    mode: Mode,
    disconnect: Disconnect,
    expectPriorDisposal = false,
    afterDisconnect?: (home: string, worker: ProcessIdentity) => Promise<void>,
): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "vera-worker-lifeline-"));
    const host = spawn(process.execPath, [HOST, home, mode], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, VERA_HOME: home, HOME: home },
    });
    let worker: ProcessIdentity | undefined;
    let tool: ProcessIdentity | undefined;
    let toolChild: ProcessIdentity | undefined;
    try {
        await hostReady(host, (status) => {
            if (status.worker !== undefined) worker = trackProcess(status.worker);
            if (status.tool !== undefined) tool = trackProcess(status.tool);
            if (status.toolChild !== undefined) {
                if (tool === undefined) throw new Error("Tool group was not reported");
                toolChild = trackProcess(status.toolChild, tool.group);
            }
        });
        expect(worker).toBeDefined();
        expect(alive(worker!.pid)).toBe(true);
        if (expectPriorDisposal) expect(existsSync(join(home, "prior-extension-active"))).toBe(true);
        if (mode === "foreground" || mode === "background" || mode === "cleanup-hang") {
            expect(tool).toBeDefined();
            expect(toolChild).toBeDefined();
            expect(alive(tool!.pid)).toBe(true);
            expect(alive(toolChild!.pid)).toBe(true);
        }
        if (disconnect === "kill") host.kill("SIGKILL");
        else host.stdin!.write("close\n");
        await afterDisconnect?.(home, worker!);
        const [workerGone, toolGone, toolChildGone] = await Promise.all([
            waitUntilGone(worker!.pid),
            tool === undefined ? Promise.resolve(true) : waitUntilGone(tool.pid),
            toolChild === undefined ? Promise.resolve(true) : waitUntilGone(toolChild.pid),
        ]);
        expect({ workerGone, toolGone, toolChildGone }).toEqual({
            workerGone: true, toolGone: true, toolChildGone: true,
        });
        if (mode === "cleanup-hang") expect(existsSync(join(home, "dispose-started"))).toBe(true);
        if (expectPriorDisposal) expect(existsSync(join(home, "prior-extension-disposed"))).toBe(true);
        if (mode === "extension-release") {
            expect(existsSync(join(home, "pending-extension-settled"))).toBe(true);
            expect(existsSync(join(home, "pending-extension-disposed"))).toBe(true);
        }
        if (mode === "extension-dispose-hang") {
            expect(existsSync(join(home, "hanging-disposer-started"))).toBe(true);
            expect(existsSync(join(home, "other-disposer-started"))).toBe(true);
        }
    } finally {
        if (worker === undefined) {
            const pid = readPid(join(home, "worker.pid"));
            const found = pid === undefined ? undefined : identity(pid);
            if (found !== undefined && found.parent === host.pid && found.group === found.pid) worker = found;
        }
        if (tool === undefined && worker !== undefined) {
            const pid = readPid(join(home, "tool.pid"));
            const found = pid === undefined ? undefined : identity(pid);
            if (found !== undefined && found.parent === worker.pid && found.group === found.pid) tool = found;
        }
        if (toolChild === undefined && tool !== undefined) {
            const pid = readPid(join(home, "tool-child.pid"));
            const found = pid === undefined ? undefined : identity(pid);
            if (found !== undefined && found.parent === tool.pid && found.group === tool.group) toolChild = found;
        }
        killGroup(tool);
        killProcess(toolChild);
        killGroup(worker);
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
        const gone = await Promise.all([
            worker === undefined ? Promise.resolve(true) : waitUntilGone(worker.pid),
            tool === undefined ? Promise.resolve(true) : waitUntilGone(tool.pid),
            toolChild === undefined ? Promise.resolve(true) : waitUntilGone(toolChild.pid),
            host.pid === undefined ? Promise.resolve(true) : waitUntilGone(host.pid),
        ]);
        if (gone.some((stopped) => !stopped)) throw new Error(`Fixture processes did not stop: ${gone}`);
        rmSync(home, { recursive: true, force: true });
    }
}

test("@core host loss disposes active extensions while another is starting", async () => {
    await checkLifeline("extension-pending", "close", true);
}, 9_000);

for (const disconnect of ["close", "kill"] as const) {
    test(`@core pending extension is disposed after activation settles on host ${disconnect}`, async () => {
        await checkLifeline("extension-release", disconnect, false, async (home, worker) => {
            expect(existsSync(join(home, "pending-extension-active"))).toBe(true);
            expect(existsSync(join(home, "pending-extension-disposed"))).toBe(false);
            await Bun.sleep(100);
            expect(alive(worker.pid)).toBe(true);
            expect(existsSync(join(home, "pending-extension-disposed"))).toBe(false);
            writeFileSync(join(home, "release-activation"), "release");
        });
    }, 9_000);
}

test("@core host loss starts every active disposer despite a hanging disposer", async () => {
    await checkLifeline("extension-dispose-hang", "close");
}, 9_000);

for (const mode of [
    "before", "idle", "foreground", "background", "adapter-pending",
    "provider-pending", "extension-pending", "extension-dispose-hang", "cleanup-hang",
] as const) {
    for (const disconnect of ["close", "kill"] as const) {
        test(`@core worker exits after host ${disconnect} with ${mode} work`, async () => {
            await checkLifeline(mode, disconnect);
        }, 9_000);
    }
}

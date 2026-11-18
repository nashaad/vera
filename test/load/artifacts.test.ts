import { expect, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOwned, RunArtifacts } from "../../dev/load/artifacts.ts";
import { REPO } from "../../dev/load/common.ts";
import { processStart, type ProcessIdentity } from "../../dev/load/identity.ts";
import { RunLock } from "../../dev/load/lock.ts";
import { ProcessOwner } from "../../dev/load/processes.ts";
import { runScenario } from "../../dev/load/run.ts";

const scenario = { sessions: 100, clients: 1, duration: 1, extensions: "none" as const, seed: 19, small: true };

interface RunLocation {
    readonly run: string;
    readonly alias: string;
}

async function trial(): Promise<string> {
    const base = join(tmpdir(), "vera-dev");
    await mkdir(base, { recursive: true });
    return mkdtemp(join(base, "gc-"));
}

async function deadIdentity(): Promise<ProcessIdentity> {
    const child = Bun.spawn(["/bin/sleep", "0.2"], { stdout: "ignore", stderr: "ignore" });
    const started = processStart(child.pid);
    await child.exited;
    if (started === undefined) throw new Error("Test process exited before identification");
    return { pid: child.pid, started };
}

async function pretendRunnerExited(root: string, artifacts: RunLocation): Promise<void> {
    const runner = await deadIdentity();
    const lockPath = join(root, "run.lock", "owner.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    await writeFile(lockPath, JSON.stringify({ ...lock, runner }));
    const markerPath = join(artifacts.run, ".load-owner.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, JSON.stringify({ ...marker, pid: runner.pid }));
}

test("@core caller owns run data while the home alias keeps sockets short", async () => {
    const root = await trial();
    const nested = join(root, "a-very-long-caller-directory-name", "another-long-component");
    await mkdir(nested, { recursive: true });
    const artifacts = await RunArtifacts.create(nested);
    try {
        expect(artifacts.run.startsWith(`${nested}/`)).toBe(true);
        expect(Buffer.byteLength(join(artifacts.run, "home", "runtime", "host.sock"))).toBeGreaterThan(103);
        expect(Buffer.byteLength(join(artifacts.home, "runtime", "host.sock"))).toBeLessThan(104);
        for (const name of ["home", "workspace", "user", "profile-release"]) {
            await mkdir(join(artifacts.run, name), { recursive: true });
            await writeFile(join(artifacts.run, name, "scratch"), "data");
        }
        await writeFile(join(artifacts.run, "result.json"), "report");
        await writeFile(join(artifacts.run, "host.cpuprofile"), "profile");
        await artifacts.finish();
        for (const name of ["home", "workspace", "user", "profile-release"]) {
            expect(existsSync(join(artifacts.run, name))).toBe(false);
        }
        expect(existsSync(artifacts.alias)).toBe(false);
        expect(await readFile(join(artifacts.run, "result.json"), "utf8")).toBe("report");
        expect(await readFile(join(artifacts.run, "host.cpuprofile"), "utf8")).toBe("profile");
        await rm(nested, { recursive: true });
        expect(existsSync(artifacts.run)).toBe(false);
    } finally {
        await rm(artifacts.alias, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});

test("@core retention bounds completed owned reports and protects current, active, foreign and symlink entries", async () => {
    const root = await trial();
    const parent = join(root, "reports");
    await mkdir(parent);
    const make = async (state: string, created: number, bytes: number): Promise<string> => {
        const path = await mkdtemp(join(parent, "run-"));
        await writeFile(join(path, ".load-owner.json"), JSON.stringify({ kind: "run", version: 1, state, created, pid: process.pid }));
        await writeFile(join(path, "data"), "x".repeat(bytes));
        return path;
    };
    try {
        const old = await make("complete", 1, 20);
        const newer = await make("complete", 2, 20);
        const current = await make("complete", 3, 1000);
        const active = await make("active", 0, 20);
        const foreign = await mkdtemp(join(parent, "run-"));
        const target = join(root, "foreign-target");
        await mkdir(target);
        await writeFile(join(target, "keep"), "untouched");
        const link = join(parent, "run-Ab12Cd");
        await symlink(target, link);
        await pruneOwned(parent, "run", { count: 2, bytes: 10_000 }, current);
        expect(existsSync(old)).toBe(false);
        expect(existsSync(newer)).toBe(true);
        await pruneOwned(parent, "run", { count: 8, bytes: 100 }, current);
        expect(existsSync(newer)).toBe(false);
        for (const path of [current, active, foreign, link, join(target, "keep")]) expect(existsSync(path)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("@core active runner and unmarked locks are never reclaimed", async () => {
    const root = await trial();
    try {
        const lock = await RunLock.acquire(root);
        await expect(RunLock.acquire(root)).rejects.toThrow("is active");
        await lock.release();
        await mkdir(join(root, "run.lock"));
        await expect(RunLock.acquire(root)).rejects.toThrow("Cannot verify load lock ownership");
        expect(existsSync(join(root, "run.lock"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
});

for (const phase of ["setup", "stopped"] as const) test(`@core recovers an abandoned ${phase} run with a proven empty inventory`, async () => {
    const root = await trial();
    const lock = await RunLock.acquire(root);
    const artifacts = await RunArtifacts.create(root);
    try {
        await lock.register(artifacts);
        await mkdir(join(artifacts.run, "workspace"));
        await writeFile(join(artifacts.run, "workspace", "bulk"), "scratch");
        await writeFile(join(artifacts.run, "result.json"), "report");
        await writeFile(join(artifacts.run, "host.cpuprofile"), "profile");
        if (phase === "stopped") await lock.stopped([]);
        await pretendRunnerExited(root, artifacts);
        const next = await RunLock.acquire(root);
        expect(existsSync(join(artifacts.run, "home"))).toBe(false);
        expect(existsSync(join(artifacts.run, "workspace"))).toBe(false);
        expect(existsSync(artifacts.alias)).toBe(false);
        expect(await readFile(join(artifacts.run, "result.json"), "utf8")).toBe("report");
        expect(await readFile(join(artifacts.run, "host.cpuprofile"), "utf8")).toBe("profile");
        await next.release();
    } finally {
        await rm(artifacts.alias, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});

test("@core unproven child inventory and live recorded children block recovery", async () => {
    const root = await trial();
    const lock = await RunLock.acquire(root);
    const artifacts = await RunArtifacts.create(root);
    try {
        await lock.register(artifacts);
        await lock.running();
        await pretendRunnerExited(root, artifacts);
        await expect(RunLock.acquire(root)).rejects.toThrow("Cannot prove the child inventory");
        expect(existsSync(artifacts.home)).toBe(true);
        await lock.stopped([{ pid: process.pid, started: processStart(process.pid) ?? null }]);
        await pretendRunnerExited(root, artifacts);
        await expect(RunLock.acquire(root)).rejects.toThrow("Recorded child PID");
        expect(existsSync(artifacts.home)).toBe(true);
        expect(existsSync(join(root, "run.lock"))).toBe(true);
    } finally {
        await rm(artifacts.alias, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});

test("@core descendant discovery rejects a reused parent identity", async () => {
    const root = await trial();
    const home = join(root, "home");
    const owner = new ProcessOwner(root, home);
    const child = Bun.spawn(["/bin/sleep", "0.2"], { stdout: "ignore", stderr: "ignore" });
    try {
        owner.processes.push({ pid: process.pid, role: "old", home, started: "different start" });
        await owner.discoverDescendants(`${child.pid} ${process.pid} ${REPO}/clients/host/main.ts`);
        expect(owner.processes).toHaveLength(1);
    } finally {
        await child.exited;
        await rm(root, { recursive: true, force: true });
    }
});

test("@core setup failure releases the lock and bounds retained artifacts", async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    const register = spyOn(RunLock.prototype, "register").mockRejectedValue(new Error("registration failed"));
    try {
        await expect(runScenario(scenario, root)).rejects.toThrow("registration failed");
        expect(existsSync(join(root, "run.lock"))).toBe(false);
        const runs = await readdir(join(root, "load-runs"));
        expect(runs).toHaveLength(1);
        expect(existsSync(join(root, "load-runs", runs[0]!, "home"))).toBe(false);
        expect(JSON.parse(await readFile(join(root, "load-runs", runs[0]!, ".load-owner.json"), "utf8")).state).toBe("complete");
    } finally {
        register.mockRestore();
        if (previous === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!; else process.env.VERA_HOME = previous;
        await rm(root, { recursive: true, force: true });
    }
});

test("@core failed measurement and result collection clean scratch while retaining diagnostics", async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    try {
        const result = await runScenario(scenario, root);
        expect(result.errors.some((error) => error.includes("Not enough factory sessions"))).toBe(true);
        expect(existsSync(join(result.run, "home"))).toBe(false);
        expect(existsSync(join(result.run, "result.json"))).toBe(true);
        await writeFile(join(root, "active"), "foreign");
        const conflict = await runScenario({ ...scenario, sessions: 1 }, root);
        expect(conflict.errors.some((error) => error.includes("EEXIST"))).toBe(true);
        expect(await readFile(join(root, "active"), "utf8")).toBe("foreign");
        expect(existsSync(join(conflict.run, "home"))).toBe(false);
        await rm(join(root, "active"));
        let collectedRun = "";
        await expect(runScenario({ ...scenario, seed: 20 }, root, { collect: (run) => {
            collectedRun = run;
            expect(existsSync(join(run, "home"))).toBe(true);
            writeFileSync(join(run, "host.cpuprofile"), "profile");
            throw new Error("collection failed");
        } })).rejects.toThrow("collection failed");
        expect(existsSync(join(collectedRun, "home"))).toBe(false);
        expect(await readFile(join(collectedRun, "host.cpuprofile"), "utf8")).toBe("profile");
        expect(existsSync(join(root, "run.lock"))).toBe(false);
        const factories = await readdir(join(root, "load-factories"));
        expect(factories).toHaveLength(1);
        const factory = JSON.parse(await readFile(join(root, "load-factories", factories[0]!, ".load-owner.json"), "utf8"));
        expect(factory.seed).toBe(20);
    } finally {
        if (previous === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!; else process.env.VERA_HOME = previous;
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

test("@core handled interruption produces a report and cleans owned scratch", async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    const controller = new AbortController();
    const registerOriginal = RunLock.prototype.register;
    const register = spyOn(RunLock.prototype, "register").mockImplementation(async function (this: RunLock, artifacts: RunArtifacts) {
        await registerOriginal.call(this, artifacts);
        controller.abort();
    });
    try {
        const result = await runScenario(scenario, root, { signal: controller.signal });
        expect(result.errors.some((error) => error.includes("Interrupted"))).toBe(true);
        expect(existsSync(join(result.run, "home"))).toBe(false);
        expect(existsSync(join(result.run, "result.json"))).toBe(true);
        expect(existsSync(join(root, "run.lock"))).toBe(false);
    } finally {
        register.mockRestore();
        if (previous === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!; else process.env.VERA_HOME = previous;
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

test("@core cleanup failure retains the stopped lock for a safe retry", async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    const finish = spyOn(RunArtifacts.prototype, "finish").mockRejectedValueOnce(new Error("scratch removal failed"));
    let alias = "";
    try {
        await expect(runScenario(scenario, root)).rejects.toThrow("scratch removal failed");
        const record = JSON.parse(await readFile(join(root, "run.lock", "owner.json"), "utf8"));
        const artifacts: RunLocation = { run: record.run, alias: record.alias };
        alias = artifacts.alias;
        expect(record.phase).toBe("stopped");
        expect(existsSync(join(artifacts.run, "home"))).toBe(true);
        expect(existsSync(alias)).toBe(true);
        expect(existsSync(join(root, "run.lock"))).toBe(true);
        finish.mockRestore();
        await pretendRunnerExited(root, artifacts);
        const next = await RunLock.acquire(root);
        expect(existsSync(join(artifacts.run, "home"))).toBe(false);
        expect(existsSync(alias)).toBe(false);
        expect(existsSync(join(artifacts.run, "result.json"))).toBe(true);
        await next.release();
    } finally {
        finish.mockRestore();
        if (previous === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!; else process.env.VERA_HOME = previous;
        if (alias !== "") await rm(alias, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

test("@core unproven shutdown retains the run, alias and lock", async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    const stop = spyOn(ProcessOwner.prototype, "stop").mockRejectedValue(new Error("unverified"));
    let alias = "";
    try {
        await expect(runScenario(scenario, root)).rejects.toThrow("Retained run, active link, and lock");
        const record = JSON.parse(await readFile(join(root, "run.lock", "owner.json"), "utf8"));
        alias = record.alias;
        expect(existsSync(join(record.run, "home"))).toBe(true);
        expect(existsSync(alias)).toBe(true);
        expect(existsSync(join(root, "run.lock"))).toBe(true);
    } finally {
        stop.mockRestore();
        if (previous === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!; else process.env.VERA_HOME = previous;
        if (alias !== "") await rm(alias, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

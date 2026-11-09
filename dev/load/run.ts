import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { includedExtensionIds } from "../../src/extensions/included.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { inspectHostLockFile } from "../../src/host/lockfile.ts";
import { assertTrialHome, command, LOAD_ROOT, REPO, rows, waitFor } from "./common.ts";
import { buildFactory, cloneFactory, configureHome, FACTORY_VERSION } from "./factory.ts";
import { ProcessOwner, type StopMeasurement } from "./processes.ts";
import { checkFailed, collectResult, footprintDetails, table, type Footprint, type Result, type Scenario } from "./results.ts";
import { processReadings, sampleFootprints } from "./metrics.ts";
import { failedTurnRecords, killActiveWorker, workerLocations, type KillPlan } from "./kill.ts";
import { profileRuntime } from "./profile.ts";
import { parseLoadOptions } from "./options.ts";

export interface RunOptions {
    readonly cpuProfile?: boolean;
}

interface StartingClientBatch {
    readonly name: string;
    readonly size: number;
}

const MAX_STARTING_CLIENT_BATCHES = 4;

export async function runScenario(scenario: Scenario, root = LOAD_ROOT, options: RunOptions = {}): Promise<Result> {
    assertTrialHome();
    await command(["/bin/ps", "-p", String(process.pid), "-o", "pid="]);
    await mkdir(root, { recursive: true });
    const lock = join(root, "run.lock");
    await mkdir(lock).catch(() => { throw new Error(`Runner lock exists: ${lock}`); });
    const run = await mkdtemp(join(tmpdir(), "vera-dev", "hl-"));
    const home = join(run, "home");
    const owner = new ProcessOwner(run, home);
    const errors: string[] = [];
    const active = join(root, "active");
    let start = Date.now();
    let end = start;
    let startedAwake = performance.now();
    let initial: Footprint = { bytes: null, path: "", error: "Host did not start" };
    let final = initial;
    let interrupted = false;
    let host: ReturnType<ProcessOwner["start"]> | undefined;
    let stopped: StopMeasurement | undefined;
    let kill: KillPlan | undefined;
    let failedRecords: number | null = null;
    const interrupt = () => { interrupted = true; };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    const sha = (await command(["git", "-C", REPO, "rev-parse", "HEAD"])).trim();
    try {
        const factory = join(root, `factory-v${FACTORY_VERSION}-${scenario.seed}${scenario.small ? "-small" : ""}`);
        const manifest = await buildFactory({ root: factory, seed: scenario.seed, workspace: join(active, "workspace"), small: scenario.small });
        if (scenario.sessions > manifest.sessions.length) throw new Error("Not enough factory sessions");
        // ProcessOwner creates the home before the copy so cp copies its contents explicitly.
        await rm(home, { recursive: true });
        await cloneFactory(factory, run);
        await rm(active, { force: true });
        await symlink(run, active);
        const provider = owner.start("provider", join(REPO, "dev/load/provider.ts"), { LOAD_SEED: String(scenario.seed) });
        await waitFor(() => { if (provider.exitCode !== null) throw new Error("Provider exited"); return existsSync(join(run, "provider-ready.json")); }, 10_000, "provider start");
        const { port } = await Bun.file(join(run, "provider-ready.json")).json();
        await configureHome(home, port, scenario.extensions, scenario.workers);
        const memorySampling = process.env.LOAD_MEMHEAP === "1";
        const bunOptions = [`--preload=${join(REPO, "dev/load/drift.ts")}`];
        if (memorySampling) bunOptions.push(`--preload=${join(REPO, "dev/load/memheap.ts")}`);
        const memoryPhase = async (phase: string): Promise<void> => {
            if (!memorySampling) return;
            const pids = (await processReadings(host!.pid)).map((process) => process.pid);
            await Bun.write(join(run, "memheap-phase"), phase);
            await waitFor(() => pids.every((pid) => existsSync(join(run, `memheap-${phase}-${pid}.done`))), 120_000, `memory ${phase}`);
        };
        const runtime = options.cpuProfile === true ? await profileRuntime(run) : undefined;
        const hostEnv: Record<string, string> = {
            BUN_OPTIONS: bunOptions.join(" "), ...(memorySampling ? { LOAD_MEMHEAP_SNAPSHOT: process.env.LOAD_MEMHEAP_SNAPSHOT ?? "0" } : {}), ...(scenario.pinWorker === true ? { LOAD_PIN_WORKER: "1" } : {}),
        };
        host = owner.start("host", join(REPO, "clients/host/main.ts"), hostEnv, undefined, [], runtime);
        await waitFor(async () => {
            if (host!.exitCode !== null) throw new Error(`Host exited: ${await Bun.file(join(run, "host.stderr")).text()}`);
            if (interrupted) throw new Error("Interrupted");
            const lock = await inspectHostLockFile(join(home, "runtime", "host.json"));
            const identity = await requestHostIdentity(join(home, "runtime", "host.sock"));
            const workers = scenario.workers ?? Math.max(1, availableParallelism() - 1);
            return lock.state === "valid" && lock.record.pid === host!.pid && identity?.pid === host!.pid
                && (workers === 0 ? lock.record.worker_count === undefined : identity.workers_ready === workers);
        }, 60_000, "host and session processes");
        await memoryPhase("host_ready");
        await sampleFootprints(run, host.pid, "host_ready");
        const ids = manifest.sessions.slice(0, scenario.sessions).map((session) => session.id);
        await Bun.write(join(run, "scenario.json"), JSON.stringify({ ...scenario, factory, factoryBytes: manifest.bytes, factorySessions: manifest.sessions.length, resumed: manifest.sessions.slice(0, scenario.sessions), includedExtensions: scenario.extensions === "none" ? [] : includedExtensionIds() }, null, 2));
        const batches: string[] = [];
        const starting: StartingClientBatch[] = [];
        const waitForBatch = async (target: StartingClientBatch): Promise<void> => {
            await waitFor(() => {
                if (interrupted) throw new Error("Interrupted");
                if (host!.exitCode !== null || provider.exitCode !== null) throw new Error("Host or provider exited during startup");
                const samples = batches.flatMap((batch) => rows<{ type: string; error?: string }>(join(run, `client-${batch}.ndjson`)));
                const failure = samples.find((sample) => sample.type === "error");
                if (failure) throw new Error(failure.error);
                return rows<{ type: string }>(join(run, `client-${target.name}.ndjson`))
                    .filter((sample) => sample.type === "ready").length >= target.size;
            }, 900_000, `history batch ${target.name}`);
        };
        for (let client = 0; client < scenario.clients; client++) {
            for (let offset = 0; offset < ids.length; offset += 10) {
                if (starting.length >= MAX_STARTING_CLIENT_BATCHES) await waitForBatch(starting.shift()!);
                const batch = `${client}-${offset / 10}`;
                const batchIds = ids.slice(offset, offset + 10);
                batches.push(batch);
                owner.start(`client-${batch}`, join(REPO, "dev/load/client.ts"), {
                    LOAD_BATCH: batch, LOAD_PRIMARY: client === 0 ? "1" : "0",
                    LOAD_IDS: JSON.stringify(batchIds), LOAD_SEED: String(scenario.seed),
                    LOAD_PAGING: scenario.paging === true ? "1" : "0",
                    LOAD_RELAY: scenario.relay === true ? "1" : "0",
                });
                starting.push({ name: batch, size: batchIds.length });
            }
        }
        owner.start("probe", join(REPO, "dev/load/probe.ts"), {
            LOAD_HOST_PID: String(host.pid), LOAD_ATTACH_ID: ids[0]!, LOAD_PAGING: scenario.paging === true ? "1" : "0",
            LOAD_RELAY: scenario.relay === true ? "1" : "0",
        });
        await waitFor(() => {
            if (interrupted) throw new Error("Interrupted");
            const samples = batches.flatMap((batch) => rows<{ type: string; error?: string }>(join(run, `client-${batch}.ndjson`)));
            const failure = samples.find((sample) => sample.type === "error");
            if (failure) throw new Error(failure.error);
            return samples.filter((sample) => sample.type === "ready").length === scenario.sessions * scenario.clients;
        }, 900_000, "all histories");
        const locations = scenario.killWorker === true || scenario.pinWorker === true ? await workerLocations(home, ids) : [];
        if (scenario.pinWorker === true) {
            await Bun.write(join(run, "pin-owners.ndjson"), locations.map((location) => JSON.stringify(location)).join("\n") + "\n");
        }
        await memoryPhase("ready");
        const initialSamples = await sampleFootprints(run, host.pid, "ready");
        const initialHost = initialSamples.find((sample) => sample.pid === host!.pid);
        initial = { bytes: initialHost?.bytes ?? null, path: initialHost?.path ?? "", ...(initialHost?.error === undefined ? {} : { error: initialHost.error }) };
        start = Date.now();
        startedAwake = performance.now();
        end = start + scenario.duration * 1000;
        await Bun.write(join(run, "go.json"), JSON.stringify({ start, end }));
        process.stdout.write(`RUN ${scenario.sessions} sessions x ${scenario.clients} clients for ${scenario.duration}s: ${run}\n`);
        if (scenario.killWorker === true) kill = await killActiveWorker(run, home, owner, locations);
        while (Date.now() < end) {
            if (interrupted) { errors.push("Interrupted"); end = Date.now(); break; }
            if (host.exitCode !== null || provider.exitCode !== null) throw new Error("Host or provider exited during measurement");
            await owner.discoverDescendants();
            await Bun.sleep(1000);
        }
        const wallMs = Date.now() - start;
        const awakeMs = performance.now() - startedAwake;
        await Bun.write(join(run, "measurement-timing.json"), JSON.stringify({ wallMs, awakeMs }));
        if (wallMs - awakeMs > 1_000) errors.push(`Measurement interrupted by system sleep or a clock change (${Math.round(wallMs - awakeMs)} ms)`);
        await memoryPhase("end");
        const finalSamples = await sampleFootprints(run, host.pid, "end");
        const finalHost = finalSamples.find((sample) => sample.pid === host!.pid);
        final = { bytes: finalHost?.bytes ?? null, path: finalHost?.path ?? "", ...(finalHost?.error === undefined ? {} : { error: finalHost.error }) };
        if (kill !== undefined) failedRecords = await failedTurnRecords(home, kill);
    } catch (error) {
        errors.push(String(error));
        end = Date.now();
        process.stderr.write(`${error}\n`);
    } finally {
        if (process.env.LOAD_MEMHEAP !== "1" && host !== undefined && host.exitCode === null) {
            try {
                stopped = await owner.stopHost();
                if (stopped.commandExit !== 0) errors.push(`Stop command exit: ${stopped.commandExit}`);
                if (stopped.elapsedMs === null || stopped.remainingPids.length > 0) errors.push("Host processes did not stop within the deadline");
                if (stopped.remainingRecords.length > 0) errors.push(`Session process records remain: ${stopped.remainingRecords.join(", ")}`);
            }
            catch (error) { errors.push(`Stop: ${error}`); }
        }
        try { await owner.stop(); } catch (error) { errors.push(`Cleanup: ${error}`); }
        await rm(active, { force: true });
        await rm(lock, { recursive: true });
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
    }
    const result = collectResult(run, scenario, start, Math.max(end, start + 1), sha, { start: initial, end: final }, errors, stopped, kill, failedRecords);
    await Bun.write(join(run, "result.json"), JSON.stringify(result, null, 2));
    await Bun.write(join(run, "result.md"), `${table([result])}\n${footprintDetails(result)}`);
    process.stdout.write(`${table([result])}\n${footprintDetails(result)}\nRESULT ${join(run, "result.json")}\n`);
    return result;
}

if (import.meta.main) {
    assertTrialHome();
    const options = parseLoadOptions(Bun.argv.slice(2));
    const base = options.scenario;
    const scenarios = options.matrix ? [8, 50, 100].flatMap((sessions) => [1, 3].map((clients) => ({ ...base, sessions, clients }))) : [base];
    const results: Result[] = [];
    for (const scenario of scenarios) {
        const result = await runScenario(scenario, LOAD_ROOT, { cpuProfile: options.cpuProfile });
        results.push(result);
        if (result.errors.length) break;
    }
    const path = join(LOAD_ROOT, `matrix-${Date.now()}.md`);
    await Bun.write(path, table(results));
    process.stdout.write(`TABLE ${path}\n`);
    if (results.some((result) => result.errors.length > 0) || (options.check && results.some(checkFailed))) process.exitCode = 1;
}

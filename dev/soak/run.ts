import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readProcessMemory } from "../../clients/tui/process-memory.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { connectHost } from "../../src/host/connection.ts";
import { HOST_PROTOCOL_VERSION, requestHostIdentity } from "../../src/host/protocol.ts";
import { RELEASE_ARTIFACT_NAMES, RELEASE_LAYOUT_VERSION, VERA_PRODUCT_VERSION, serializeReleaseManifest } from "../../src/release/manifest.ts";
import { releaseSourceEntries, writeCheckoutPackWrappers } from "../../src/release/wrappers.ts";
import { configureHome } from "../load/factory.ts";
import { REPO, waitFor } from "../load/common.ts";
import { startProvider } from "../load/provider.ts";
import { heapMedianBefore, leastSquaresSlope, parseHeapSamples, parseVmmapSummary, type HeapSample } from "./measure.ts";

export interface SoakOptions {
    readonly turns: number;
    // Turns before this count are warm-up; the trend is fitted after them.
    readonly warmup: number;
    // Divides the mock provider's delays. Higher is faster and does not change token counts.
    readonly speed: number;
    // Largest allowed growth of the fitted VM_ALLOCATE dirty trend across the measured turns.
    readonly maxGrowthBytes: number;
    // Largest allowed growth of the fitted post-collection JS heap across the measured turns.
    readonly maxHeapGrowthBytes: number;
}

// The footprint is logged only: it swings with JS collection timing and cannot show a leak alone.
export interface SoakSample {
    readonly turn: number;
    readonly footprintBytes: number;
    readonly vmAllocateDirtyBytes: number | undefined;
    readonly ioAcceleratorDirtyBytes: number | undefined;
    // Median of the last heap samples written before the turn ended.
    readonly heapUsedBytes: number | undefined;
    readonly heapSampleGcMs: number | undefined;
}

export interface SoakResult {
    readonly options: SoakOptions;
    readonly samples: readonly SoakSample[];
    readonly slopeBytesPerTurn: number;
    readonly growthBytes: number;
    readonly heapSlopeBytesPerTurn: number;
    readonly heapGrowthBytes: number;
    readonly pass: boolean;
    readonly root: string;
    readonly durationMs: number;
    readonly errors: readonly string[];
}

// Settle time lets the host finish post-turn bookkeeping before the sample.
const SETTLE_MS = 300;
const TURN_TIMEOUT_MS = 60_000;
const HOST_EXIT_GRACE_MS = 10_000;
const HEAP_PRELOAD = join(REPO, "dev/soak/heap-preload.ts");
const HEAP_FILE = "soak-heap.jsonl";
// Median over this many consecutive heap samples damps single-collection spikes.
const HEAP_SAMPLES_PER_TURN = 3;

export async function runSoak(options: SoakOptions): Promise<SoakResult> {
    // performance.now() excludes system sleep; Date.now() would count a sleeping laptop as run time.
    const started = performance.now();
    const base = join(tmpdir(), "vera-dev");
    mkdirSync(base, { recursive: true });
    const root = await mkdtemp(join(base, "soak-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const release = join(root, "dist", "release");
    mkdirSync(release, { recursive: true });
    const provider = startProvider({ seed: 1, speed: options.speed });
    const samples: SoakSample[] = [];
    const errors: string[] = [];
    let host: ReturnType<typeof Bun.spawn> | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        await configureHome(home, provider.port, "included");
        await Bun.write(join(release, "manifest.json"), serializeReleaseManifest({
            layout_version: RELEASE_LAYOUT_VERSION, product_version: VERA_PRODUCT_VERSION,
            source_revision: "soak", build_id: "soak", protocol_version: HOST_PROTOCOL_VERSION,
            platform: process.platform, arch: process.arch, asset_digest: `sha256:${"00".repeat(32)}`,
            built_at: new Date().toISOString(), artifacts: [...RELEASE_ARTIFACT_NAMES],
        }));
        writeCheckoutPackWrappers(release, process.execPath, releaseSourceEntries(REPO));
        // VERA_DEV_INSTANCE with cwd holding dist/release keeps the annex and worker inside this checkout.
        // The preload runs only in the host process; spawned children use their own argv.
        host = Bun.spawn([process.execPath, "--preload", HEAP_PRELOAD, join(REPO, "clients/host/main.ts")], {
            cwd: root,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", VERA_HOME: home, VERA_DEV_INSTANCE: "1" },
            stdout: Bun.file(join(root, "host.stdout")),
            stderr: Bun.file(join(root, "host.stderr")),
        });
        const hostPid = host.pid;
        const socketPath = join(home, "runtime", "host.sock");
        const heapFile = join(home, HEAP_FILE);
        await waitFor(async () => {
            if (host!.exitCode !== null) throw new Error(`Host exited early, see ${join(root, "host.stderr")}`);
            return await requestHostIdentity(socketPath) !== undefined;
        }, 60_000, "host identity");
        const connection = await connectHost({ socketPath });
        let agentId: string;
        try {
            await connection.send({ type: "create_agent", workspace });
            const created = await connection.receiveWithin(60_000, "create_agent") as { type: string; agent_id?: string };
            if (created.type !== "agent_ready" || created.agent_id === undefined) throw new Error(`create_agent: ${JSON.stringify(created)}`);
            agentId = created.agent_id;
        } finally { connection.close(); }
        client = await attachAgent({ socketPath, agentId, requestedCapabilities: [], signal: AbortSignal.timeout(60_000) });
        samples.push(await sample(hostPid, 0, heapBefore(heapFile, Date.now())));
        for (let turn = 1; turn <= options.turns; turn++) {
            await client.send({ type: "prompt", content: `soak turn ${turn}` });
            for (;;) {
                const update = await client.receive(AbortSignal.timeout(TURN_TIMEOUT_MS));
                if (update.type === "ui_request" || update.type === "agent_failed" || update.type === "prompt_rejected") {
                    throw new Error(`Turn ${turn}: ${JSON.stringify(update).slice(0, 300)}`);
                }
                if (update.type !== "turn_finished") continue;
                if (update.outcome) throw new Error(`Turn ${turn} outcome ${update.outcome}: ${update.error ?? ""}`);
                break;
            }
            const turnEnd = Date.now();
            await Bun.sleep(SETTLE_MS);
            samples.push(await sample(hostPid, turn, heapBefore(heapFile, turnEnd)));
        }
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
    } finally {
        client?.close();
        if (host !== undefined) await stopHost(host);
        provider.stop(true);
    }
    const measured = samples.filter((sample) => sample.turn >= options.warmup);
    const missingVm = measured.some((sample) => sample.vmAllocateDirtyBytes === undefined);
    if (missingVm && errors.length === 0) errors.push("vmmap did not report VM_ALLOCATE; the soak needs macOS vmmap");
    const ok = errors.length === 0;
    const fitted = ok
        ? leastSquaresSlope(measured.map((sample) => [sample.turn, sample.vmAllocateDirtyBytes!]))
        : { slope: Number.NaN, growth: Number.NaN };
    const heapFitted = ok
        ? leastSquaresSlope(measured.map((sample) => [sample.turn, sample.heapUsedBytes!]))
        : { slope: Number.NaN, growth: Number.NaN };
    const pass = ok && fitted.growth <= options.maxGrowthBytes && heapFitted.growth <= options.maxHeapGrowthBytes;
    const result: SoakResult = {
        options, samples, slopeBytesPerTurn: fitted.slope, growthBytes: fitted.growth,
        heapSlopeBytesPerTurn: heapFitted.slope, heapGrowthBytes: heapFitted.growth,
        pass, root, durationMs: performance.now() - started, errors,
    };
    await Bun.write(join(root, "result.json"), JSON.stringify(result, null, 2));
    if (pass) rmSync(root, { recursive: true, force: true });
    return result;
}

function heapBefore(heapFile: string, time: number): HeapSample | undefined {
    let text = "";
    try {
        text = readFileSync(heapFile, "utf8");
    } catch {
        return undefined;
    }
    return heapMedianBefore(parseHeapSamples(text), time, HEAP_SAMPLES_PER_TURN);
}

async function sample(hostPid: number, turn: number, heap: HeapSample | undefined): Promise<SoakSample> {
    if (heap === undefined) throw new Error(`Turn ${turn}: no heap sample written before the turn ended`);
    const footprint = await readProcessMemory([hostPid]);
    const bytes = footprint.get(hostPid);
    if (bytes === undefined) throw new Error(`No footprint for host pid ${hostPid}`);
    const regions = parseVmmapSummary(await vmmapSummary(hostPid));
    return {
        turn,
        footprintBytes: bytes,
        vmAllocateDirtyBytes: regions.get("VM_ALLOCATE"),
        ioAcceleratorDirtyBytes: regions.get("IOAccelerator"),
        heapUsedBytes: heap.heapUsed,
        heapSampleGcMs: heap.gcMs,
    };
}

async function vmmapSummary(pid: number): Promise<string> {
    if (process.platform !== "darwin") return "";
    const child = Bun.spawn(["/usr/bin/vmmap", "-summary", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return output;
}

// Stops only the host this run spawned, by its handle.
async function stopHost(host: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (host.exitCode !== null) return;
    host.kill("SIGTERM");
    const exited = await Promise.race([host.exited.then(() => true), Bun.sleep(HOST_EXIT_GRACE_MS).then(() => false)]);
    if (!exited) {
        host.kill("SIGKILL");
        await host.exited;
    }
}

if (import.meta.main) {
    const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
        turns: { type: "string", default: "120" },
        warmup: { type: "string", default: "20" },
        speed: { type: "string", default: "5" },
        "max-growth-mb": { type: "string", default: "2" },
        "max-heap-growth-mb": { type: "string", default: "4" },
        samples: { type: "boolean", default: false },
    }, strict: true });
    const result = await runSoak({
        turns: Number(values.turns),
        warmup: Number(values.warmup),
        speed: Number(values.speed),
        maxGrowthBytes: Number(values["max-growth-mb"]) * 1024 * 1024,
        maxHeapGrowthBytes: Number(values["max-heap-growth-mb"]) * 1024 * 1024,
    });
    const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB/turn`;
    const window = `${result.options.turns - result.options.warmup} turns`;
    process.stdout.write(`${result.pass ? "PASS" : "FAIL"} VM_ALLOCATE dirty growth ${mb(result.growthBytes)} over ${window} (slope ${kb(result.slopeBytesPerTurn)}); JS heap growth ${mb(result.heapGrowthBytes)} (slope ${kb(result.heapSlopeBytesPerTurn)}), ${(result.durationMs / 1000).toFixed(1)} s\n`);
    if (values.samples) for (const sample of result.samples) process.stdout.write(`turn ${sample.turn} footprint ${mb(sample.footprintBytes)} vm_allocate_dirty ${sample.vmAllocateDirtyBytes === undefined ? "?" : mb(sample.vmAllocateDirtyBytes)} ioaccelerator_dirty ${sample.ioAcceleratorDirtyBytes === undefined ? "?" : mb(sample.ioAcceleratorDirtyBytes)} heap_used ${sample.heapUsedBytes === undefined ? "?" : mb(sample.heapUsedBytes)} heap_sample_gc ${sample.heapSampleGcMs === undefined ? "?" : sample.heapSampleGcMs.toFixed(1)} ms\n`);
    if (result.errors.length > 0) process.stdout.write(`errors: ${result.errors.join("; ")}\nroot kept: ${result.root}\n`);
    if (!result.pass) process.exitCode = 1;
}

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { includedExtensionIds } from "../../src/extensions/included.ts";
import { releaseSourceEntries, writeCheckoutPackWrappers } from "../../src/release/wrappers.ts";
import { RELEASE_LAYOUT_VERSION, VERA_PRODUCT_VERSION, RELEASE_ARTIFACT_NAMES, serializeReleaseManifest } from "../../src/release/manifest.ts";
import { HOST_PROTOCOL_VERSION } from "../../src/host/protocol.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { assertTrialHome, command, LOAD_ROOT, REPO, rows, waitFor } from "./common.ts";
import { buildFactory, cloneFactory, configureHome, FACTORY_VERSION } from "./factory.ts";
import { ProcessOwner } from "./processes.ts";
import { checkFailed, collectResult, table, type Footprint, type Result, type Scenario } from "./results.ts";

async function footprint(pid: number, path: string): Promise<Footprint> {
    try {
        const output = await command(["/usr/bin/footprint", "-p", String(pid)]);
        await Bun.write(path, output);
        const match = output.match(/(?:Physical footprint|Footprint):\s*([\d.]+)\s*([KMGT]?)B/i);
        const multiplier = match ? ({ "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2]!.toUpperCase()] ?? 1) : 1;
        return { path, bytes: match ? Number(match[1]) * multiplier : null, ...(!match ? { error: "Footprint output has no physical-footprint field" } : {}) };
    } catch (error) {
        await Bun.write(path, String(error));
        return { path, bytes: null, error: String(error) };
    }
}

export interface RunOptions {
    readonly cpuProfile?: boolean;
}

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
    let initial: Footprint = { bytes: null, path: "", error: "Host did not start" };
    let final = initial;
    let interrupted = false;
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
        const release = join(run, "dist", "release");
        await mkdir(release, { recursive: true });
        await Bun.write(join(release, "manifest.json"), serializeReleaseManifest({
            layout_version: RELEASE_LAYOUT_VERSION, product_version: VERA_PRODUCT_VERSION,
            source_revision: sha, build_id: `load-${sha.slice(0, 12)}`,
            protocol_version: HOST_PROTOCOL_VERSION, platform: process.platform, arch: process.arch,
            asset_digest: `sha256:${"00".repeat(32)}`, built_at: new Date().toISOString(),
            artifacts: [...RELEASE_ARTIFACT_NAMES],
        }));
        writeCheckoutPackWrappers(release, process.execPath, releaseSourceEntries(REPO));
        const provider = owner.start("provider", join(REPO, "dev/load/provider.ts"), { LOAD_SEED: String(scenario.seed) });
        await waitFor(() => { if (provider.exitCode !== null) throw new Error("Provider exited"); return existsSync(join(run, "provider-ready.json")); }, 10_000, "provider start");
        const { port } = await Bun.file(join(run, "provider-ready.json")).json();
        await configureHome(home, port, scenario.extensions);
        // The host writes its CPU profile into the run directory on a clean exit (SIGTERM).
        const hostEnv: Record<string, string> = { LOAD_DRIFT_FILE: join(run, "drift.ndjson"), ...(options.cpuProfile === true ? { BUN_OPTIONS: "--cpu-prof" } : {}) };
        const host = owner.start("host", join(REPO, "clients/host/main.ts"), hostEnv, join(REPO, "dev/load/drift.ts"));
        await waitFor(async () => {
            if (host.exitCode !== null) throw new Error(`Host exited: ${await Bun.file(join(run, "host.stderr")).text()}`);
            if (interrupted) throw new Error("Interrupted");
            return await requestHostIdentity(join(home, "runtime", "host.sock")) !== undefined;
        }, 60_000, "host identity");
        const ids = manifest.sessions.slice(0, scenario.sessions).map((session) => session.id);
        await Bun.write(join(run, "scenario.json"), JSON.stringify({ ...scenario, factory, factoryBytes: manifest.bytes, factorySessions: manifest.sessions.length, resumed: manifest.sessions.slice(0, scenario.sessions), includedExtensions: scenario.extensions === "none" ? [] : includedExtensionIds() }, null, 2));
        const batches: string[] = [];
        for (let client = 0; client < scenario.clients; client++) {
            for (let offset = 0; offset < ids.length; offset += 10) {
                const batch = `${client}-${offset / 10}`;
                batches.push(batch);
                owner.start(`client-${batch}`, join(REPO, "dev/load/client.ts"), {
                    LOAD_BATCH: batch, LOAD_PRIMARY: client === 0 ? "1" : "0",
                    LOAD_IDS: JSON.stringify(ids.slice(offset, offset + 10)), LOAD_SEED: String(scenario.seed),
                    LOAD_PAGING: scenario.paging === true ? "1" : "0",
                });
            }
        }
        owner.start("probe", join(REPO, "dev/load/probe.ts"), { LOAD_HOST_PID: String(host.pid), LOAD_ATTACH_ID: ids[0]!, LOAD_PAGING: scenario.paging === true ? "1" : "0" });
        await waitFor(() => {
            if (interrupted) throw new Error("Interrupted");
            const samples = batches.flatMap((batch) => rows<{ type: string; error?: string }>(join(run, `client-${batch}.ndjson`)));
            const failure = samples.find((sample) => sample.type === "error");
            if (failure) throw new Error(failure.error);
            return samples.filter((sample) => sample.type === "ready").length === scenario.sessions * scenario.clients;
        }, 900_000, "all histories");
        initial = await footprint(host.pid, join(run, "footprint-start.txt"));
        start = Date.now();
        end = start + scenario.duration * 1000;
        await Bun.write(join(run, "go.json"), JSON.stringify({ start, end }));
        process.stdout.write(`RUN ${scenario.sessions} sessions x ${scenario.clients} clients for ${scenario.duration}s: ${run}\n`);
        while (Date.now() < end) {
            if (interrupted) { errors.push("Interrupted"); end = Date.now(); break; }
            if (host.exitCode !== null || provider.exitCode !== null) throw new Error("Host or provider exited during measurement");
            await owner.discoverDescendants();
            await Bun.sleep(1000);
        }
        final = await footprint(host.pid, join(run, "footprint-end.txt"));
    } catch (error) {
        errors.push(String(error));
        end = Date.now();
        process.stderr.write(`${error}\n`);
    } finally {
        try { await owner.stop(); } catch (error) { errors.push(`Cleanup: ${error}`); }
        await rm(active, { force: true });
        await rm(lock, { recursive: true });
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
    }
    const result = collectResult(run, scenario, start, Math.max(end, start + 1), sha, { start: initial, end: final }, errors);
    await Bun.write(join(run, "result.json"), JSON.stringify(result, null, 2));
    await Bun.write(join(run, "result.md"), table([result]));
    process.stdout.write(`${table([result])}\nRESULT ${join(run, "result.json")}\n`);
    return result;
}

if (import.meta.main) {
    assertTrialHome();
    const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
        sessions: { type: "string", default: "8" }, clients: { type: "string", default: "1" }, duration: { type: "string", default: "120" },
        seed: { type: "string", default: "1" }, extensions: { type: "string", default: "included" },
        matrix: { type: "boolean" }, check: { type: "boolean" }, "small-fixture": { type: "boolean" }, paging: { type: "boolean" }, "cpu-profile": { type: "boolean" },
    }, strict: true });
    const number = (value: string, name: string) => {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
        return parsed;
    };
    if (values.extensions !== "included" && values.extensions !== "none") throw new Error("--extensions must be included or none");
    const base: Scenario = { sessions: number(values.sessions!, "sessions"), clients: number(values.clients!, "clients"), duration: number(values.duration!, "duration"), seed: number(values.seed!, "seed"), extensions: values.extensions, small: values["small-fixture"] ?? false, paging: values.paging ?? false };
    const scenarios = values.matrix ? [8, 50, 100].flatMap((sessions) => [1, 3].map((clients) => ({ ...base, sessions, clients }))) : [base];
    const results: Result[] = [];
    for (const scenario of scenarios) {
        const result = await runScenario(scenario, LOAD_ROOT, { cpuProfile: values["cpu-profile"] ?? false });
        results.push(result);
        if (result.errors.length) break;
    }
    const path = join(LOAD_ROOT, `matrix-${Date.now()}.md`);
    await Bun.write(path, table(results));
    process.stdout.write(`TABLE ${path}\n`);
    if (results.some((result) => result.errors.length > 0) || (values.check && results.some(checkFailed))) process.exitCode = 1;
}

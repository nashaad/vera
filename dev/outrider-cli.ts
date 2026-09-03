/** A stand-in for the `outrider` binary while the real one has no JSON progress and no installer. It speaks the surface `src/providers/outrider.ts` drives: `ps`, `serve`, `check`, `stop`, JSON on stdout and progress lines on stderr. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ENDPOINT = "http://127.0.0.1:11435";

const GATEWAY_PORT = 11435;

/** How long a whole download takes here, so a trial is watchable rather than instant. */
const DOWNLOAD_SECONDS = Number(process.env.OUTRIDER_FAKE_SECONDS ?? "6");

const RUNTIME_BYTES = 128_000_000;

interface Profile {
    readonly bytes: number;
    readonly memoryGb: number;
}

const PROFILES: Record<string, Profile> = {
    "tiny": { bytes: 400_000_000, memoryGb: 4 },
    "granite4.2-3b": { bytes: 2_100_000_000, memoryGb: 8 },
    "qwen35b-mtp": { bytes: 21_000_000_000, memoryGb: 32 },
};

interface State {
    running: boolean;
    profile?: string;
    /** What has already been fetched, so a second serve is instant the way a real cache is. */
    cached: string[];
}

function statePath(): string {
    const root = process.env.OUTRIDER_FAKE_HOME
        ?? join(process.env.TMPDIR ?? "/tmp", "vera-dev", "outrider-fake");
    return join(root, "state.json");
}

function readState(): State {
    try {
        return JSON.parse(readFileSync(statePath(), "utf8")) as State;
    } catch {
        return { running: false, cached: [] };
    }
}

function writeState(state: State): void {
    const path = statePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, undefined, 2)}\n`);
}

function emit(line: Record<string, unknown>): void {
    process.stderr.write(`${JSON.stringify(line)}\n`);
}

function print(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, undefined, 2)}\n`);
}

function fail(message: string): never {
    process.stderr.write(`outrider: ${message}\n`);
    process.exit(1);
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/** A download the length of a real one, reported the way the Go side would report it. */
async function fetchWithProgress(
    name: string,
    bytes: number,
    seconds: number,
): Promise<void> {
    const steps = Math.max(4, Math.round(seconds * 8));
    const rate = bytes / seconds;
    for (let step = 1; step <= steps; step += 1) {
        const downloaded = Math.round((bytes * step) / steps);
        emit({
            name,
            downloaded,
            total: bytes,
            bytes_per_second: rate,
            eta_seconds: Math.round((bytes - downloaded) / rate),
            done: step === steps,
        });
        await sleep((seconds * 1000) / steps);
    }
}

async function listening(): Promise<boolean> {
    try {
        await fetch(`${ENDPOINT}/v1/models`, {
            signal: AbortSignal.timeout(500),
        });
        return true;
    } catch {
        return false;
    }
}

/** The gateway the stand-in brings up is the wire stand-in that already exists. */
function startGateway(id: string): void {
    const proxy = join(import.meta.dir, "outrider-proxy.ts");
    Bun.spawn([
        "bun",
        proxy,
        "--port",
        String(GATEWAY_PORT),
        "--serve-as",
        id,
    ], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
    }).unref();
}

async function serve(id: string): Promise<void> {
    const profile = PROFILES[id];
    if (profile === undefined) fail(`unknown profile ${id}`);
    const state = readState();
    if (!state.cached.includes("llama.cpp")) {
        await fetchWithProgress("llama.cpp b10516", RUNTIME_BYTES, 1.5);
        state.cached.push("llama.cpp");
    }
    if (!state.cached.includes(id)) {
        await fetchWithProgress(id, profile.bytes, DOWNLOAD_SECONDS);
        state.cached.push(id);
    }
    emit({ name: `starting on 127.0.0.1:${GATEWAY_PORT}`, done: false });
    if (!await listening()) {
        startGateway(id);
        for (let attempt = 0; attempt < 40 && !await listening(); attempt += 1) {
            await sleep(250);
        }
    }
    emit({ name: `starting on 127.0.0.1:${GATEWAY_PORT}`, done: true });
    state.running = true;
    state.profile = id;
    writeState(state);
    print({
        kind: "running",
        pid: process.pid,
        preset: id,
        endpoint: ENDPOINT,
        health: true,
        logFile: statePath().replace("state.json", `${id}.log`),
    });
}

async function ps(): Promise<void> {
    const state = readState();
    const up = state.running && await listening();
    print({
        kind: up ? "running" : "stopped",
        endpoint: ENDPOINT,
        ...(up && state.profile !== undefined ? { preset: state.profile } : {}),
        ...(up ? { health: true } : {}),
        logFile: statePath().replace("state.json", "outrider.log"),
    });
}

function check(id: string): void {
    const profile = PROFILES[id];
    if (profile === undefined) fail(`unknown profile ${id}`);
    const memoryGb = Math.round(
        Number(process.env.OUTRIDER_FAKE_MEMORY_GB ?? "64"),
    );
    print({
        profile: id,
        admitted: memoryGb >= profile.memoryGb,
        checks: [{
            name: "memory",
            ok: memoryGb >= profile.memoryGb,
            detail: `needs ${profile.memoryGb} GB, this machine has ${memoryGb} GB`,
        }],
    });
}

function stop(): void {
    const state = readState();
    writeState({ ...state, running: false });
    print({ kind: "stopped", endpoint: ENDPOINT, logFile: statePath() });
}

const [command, argument] = Bun.argv.slice(2);
switch (command) {
    case "serve":
    case "up":
        if (argument === undefined) fail("serve expects one profile id");
        await serve(argument);
        break;
    case "ps":
    case "status":
        await ps();
        break;
    case "check":
        if (argument === undefined) fail("check expects one profile id");
        check(argument);
        break;
    case "stop":
    case "down":
        stop();
        break;
    default:
        fail(`unknown command ${command ?? ""}`);
}

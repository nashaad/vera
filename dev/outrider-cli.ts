/** Optional stand-in when no real `outrider` is on PATH. The real CLI emits the same JSON progress on stderr. */

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
    readonly description: string;
    /** Hidden unless `OUTRIDER_DEV` is set, the way the real catalog hides them. */
    readonly development?: boolean;
}

const PROFILES: Record<string, Profile> = {
    "qwen35b-mtp": {
        bytes: 22_663_387_424,
        memoryGb: 32,
        description: "Qwen3.6 35B-A3B MTP primary local agent",
    },
    "qwen35-2b": {
        bytes: 1_280_835_840,
        memoryGb: 8,
        description: "Qwen3.5 2B Q4_K_M helper at 32K context",
    },
    "tiny": {
        bytes: 563_036_064,
        memoryGb: 4,
        description: "Qwen3.5 0.8B official Q4_0 GGUF for the local smoke proof",
        development: true,
    },
    "granite4.2-3b": {
        bytes: 2_244_012_160,
        memoryGb: 8,
        description: "Granite 4.2 3B Q4_K_M as a non-thinking helper candidate",
        development: true,
    },
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

const GB = 1024 ** 3;

function check(id: string): void {
    const profile = PROFILES[id];
    if (profile === undefined) fail(`unknown profile ${id}`);
    const memoryGb = Math.round(
        Number(process.env.OUTRIDER_FAKE_MEMORY_GB ?? "64"),
    );
    const fits = memoryGb >= profile.memoryGb;
    const state = readState();
    const runtime = state.cached.includes("llama.cpp");
    print({
        profile: id,
        class: fits && runtime ? "ready" : "blocked",
        checks: [
            {
                id: "physical_memory",
                result: fits ? "pass" : "fail",
                measured: `${memoryGb * GB} bytes`,
                required: `validated at ${profile.memoryGb * GB} bytes`,
            },
            {
                id: "runtime_capabilities",
                result: runtime ? "pass" : "warn",
                measured: runtime
                    ? "all profile flags advertised"
                    : "no runtime fetched yet",
                required: "every profile flag advertised by llama-server",
            },
        ],
    });
}

/** The catalog. Vera takes the roster from here, so the stand-in has to answer it. */
function ls(): void {
    const dev = (process.env.OUTRIDER_DEV ?? "") !== "";
    print({
        profiles: Object.entries(PROFILES)
            .filter(([, profile]) => dev || profile.development !== true)
            .map(([id, profile]) => ({
                id,
                runnable: true,
                description: profile.description,
                sizeBytes: profile.bytes,
                context: 32768,
                mtp: false,
            })),
        developmentModels: [],
    });
}

function stop(): void {
    const state = readState();
    writeState({ ...state, running: false });
    print({ kind: "stopped", endpoint: ENDPOINT, logFile: statePath() });
}

const [command, argument] = Bun.argv.slice(2).filter((value) => value !== "--json");
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
    case "ls":
    case "models":
        ls();
        break;
    case "stop":
    case "down":
        stop();
        break;
    default:
        fail(`unknown command ${command ?? ""}`);
}

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { packRunnableRelease } from "../../scripts/pack-release.ts";
import { activateRelease } from "../../src/release/activate.ts";
import { digestPackedAnnex } from "../../src/release/verify.ts";
import { readStampedRelease } from "../../src/release/stamp.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

export interface HandoffFixture {
    readonly prefix: string;
    readonly home: string;
    readonly workspace: string;
    readonly build1: string;
    readonly build1Root: string;
    readonly stub: StubProvider;
    cleanup(): void;
}

export interface StubProvider {
    readonly port: number;
    requests(): number;
    release(): void;
    stop(): void;
}

// Each run gets its own prefix and home under the system temp directory. The socket
// path has to stay under the length limit, so the names are short.
export async function createFixture(options: { readonly pool?: boolean } = {}): Promise<HandoffFixture> {
    const root = mkdtempSync(join(tmpdir(), "vh-"));
    const prefix = join(root, "p");
    const home = join(root, "h");
    const workspace = join(root, "w");
    mkdirSync(join(home, "runtime"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const packed = await packRunnableRelease({ prefix, cwd: REPO_ROOT, sourceRoot: REPO_ROOT });
    const stub = startStubProvider();
    writeFileSync(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "stub",
        model: "stub-model",
        approval_mode: "auto",
        curated_models_url: "",
        ...(options.pool === true ? {} : { host: { workers: 0 } }),
        providers: {
            stub: {
                protocol: "openai-chat",
                base_url: `http://127.0.0.1:${stub.port}/v1`,
                credential: "none",
            },
        },
    }, null, 2));
    activateRelease(packed.releaseRoot, prefix);
    return {
        prefix,
        home,
        workspace,
        build1: packed.manifest.build_id,
        build1Root: packed.releaseRoot,
        stub,
        cleanup() {
            stub.stop();
            rmSync(root, { recursive: true, force: true });
        },
    };
}

// Copies a release under a new build id. The copy keeps the same runnable tree.
export function cloneRelease(fromRoot: string, prefix: string, toId: string, options: { brokenHost?: boolean } = {}): string {
    const to = join(prefix, "share", "vera", "releases", toId);
    const copied = spawnSync("cp", ["-cR", fromRoot, to]);
    if (copied.status !== 0) throw new Error(`cp failed: ${copied.stderr}`);
    const manifestPath = join(to, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.build_id = toId;
    writeFileSync(join(to, "annex", "build-id"), `${toId}\n`);
    manifest.asset_digest = digestPackedAnnex(join(to, "annex"));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (options.brokenHost === true) {
        writeFileSync(join(to, "clients", "host", "main.ts"), "process.exit(3);\n");
    }
    readStampedRelease(to);
    return to;
}

export function currentBuild(prefix: string): string {
    return readlinkSync(join(prefix, "share", "vera", "current")).split("/").pop() ?? "";
}

export function startStubProvider(options: { readonly reasoning?: string } = {}): StubProvider {
    let requestCount = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
                return new Response("not found", { status: 404 });
            }
            requestCount++;
            await gate;
            const body = [
                ...(options.reasoning === undefined ? [] : [
                    `data: ${JSON.stringify({
                        id: "x",
                        object: "chat.completion.chunk",
                        model: "stub-model",
                        choices: [{ index: 0, delta: { reasoning: options.reasoning }, finish_reason: null }],
                    })}`,
                    "",
                ]),
                `data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"pirate crow"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
                "",
                "data: [DONE]",
                "",
            ].join("\n");
            return new Response(body, { headers: { "content-type": "text/event-stream" } });
        },
    });
    const port = server.port;
    if (port === undefined) throw new Error("The stub provider did not bind a port");
    return {
        port,
        requests: () => requestCount,
        release: () => open(),
        stop: () => server.stop(true),
    };
}

export function readHostLock(home: string): { pid: number; build_id: string } | undefined {
    try {
        return JSON.parse(readFileSync(join(home, "runtime", "host.json"), "utf8"));
    } catch {
        return undefined;
    }
}

// A host this process spawned stays a zombie until it is reaped, so a signal probe
// alone would report it alive after it exited.
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
    return state.length > 0 && !state.startsWith("Z");
}

export async function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return;
        await Bun.sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

export async function stopHostProcess(home: string): Promise<void> {
    const lock = readHostLock(home);
    if (lock === undefined || !processAlive(lock.pid)) return;
    process.kill(lock.pid, "SIGTERM");
    await waitUntil(() => !processAlive(lock.pid), 10_000, "host exit");
}

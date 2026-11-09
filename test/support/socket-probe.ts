import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SocketTransport = "unix" | "loopback";

export interface SocketProbe {
    readonly unix: boolean;
    readonly loopback: boolean;
}

export type TransportAttempt = (transport: SocketTransport) => Promise<void>;

const PROBE_TIMEOUT_MS = 3_000;

export async function probeSockets(
    attempt: TransportAttempt = attemptTransport,
    timeoutMs = PROBE_TIMEOUT_MS,
): Promise<SocketProbe> {
    return {
        unix: await passes(() => attempt("unix"), timeoutMs),
        loopback: await passes(() => attempt("loopback"), timeoutMs),
    };
}

export function gateFor(probe: SocketProbe, needs: readonly SocketTransport[]): typeof test {
    return needs.every((transport) => probe[transport]) ? test : test.skip;
}

// Runs at import, once per test process. Registering tests inside a hook would register them before the gate exists.
const probe = await probeSockets();

export const socketTest = gateFor(probe, ["unix"]);
export const loopbackTest = gateFor(probe, ["loopback"]);
export const socketAndLoopbackTest = gateFor(probe, ["unix", "loopback"]);

async function attemptTransport(transport: SocketTransport): Promise<void> {
    if (transport === "unix") {
        await listenAndConnect();
        return;
    }
    await serveAndFetch();
}

async function listenAndConnect(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    const path = join(dir, "s");
    const server = createServer();
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(path, () => resolve());
        });
        await new Promise<void>((resolve, reject) => {
            const client = connect(path);
            client.once("error", reject);
            client.once("connect", () => {
                client.destroy();
                resolve();
            });
        });
    } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
    }
}

async function serveAndFetch(): Promise<void> {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
        const response = await fetch(`http://127.0.0.1:${server.port}/`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if ((await response.text()) !== "ok") {
            throw new Error("loopback probe received an unexpected body");
        }
    } finally {
        server.stop(true);
    }
}

async function passes(attempt: () => Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("socket probe timed out")), timeoutMs);
    });
    try {
        await Promise.race([attempt(), deadline]);
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

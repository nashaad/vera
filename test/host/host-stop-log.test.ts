import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runResidentHostProcess } from "../../clients/host/process-lifecycle.ts";
import { createHostLogger } from "../../src/host/host-log.ts";
import {
    HOST_PROTOCOL_VERSION, requestHostIdentity, requestHostShutdownForReplacement, requestHostShutdownIfIdle, requestHostStop,
} from "../../src/host/protocol.ts";
import { StopWhenIdle, type CompletedHostStop } from "../../src/host/stop-when-idle.ts";
import { hostLifecyclePathIn } from "../../src/profile-paths.ts";
import { socketTest } from "../support/socket-probe.ts";
import { sourceTestHome } from "../support/source-test-home.mjs";

for (const pooled of [false, true]) {
    for (const reason of ["host_stop", "host_stop_force", "shutdown_if_idle", "shutdown_for_replacement"] as const) {
        socketTest(`${pooled ? "pooled" : "single-process"} host records ${reason}`, async () => {
            const root = await mkdtemp(join(tmpdir(), "hsr-"));
            const home = join(root, "h");
            await mkdir(home);
            await writeFile(join(home, "config.json"), JSON.stringify({
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
                host: { workers: pooled ? 1 : 0 },
            }));
            const child = Bun.spawn([process.execPath, "clients/host/main.ts", "--no-discovery"], {
                cwd: process.cwd(),
                env: { ...process.env, HOME: sourceTestHome(join(root, "user")), VERA_HOME: home, VERA_DEV_INSTANCE: "hoststop dev" },
                stdout: "ignore", stderr: "pipe",
            });
            const stderr = new Response(child.stderr).text();
            const socket = join(home, "runtime", "host.sock");
            try {
                const deadline = Date.now() + 25_000;
                let identity = await requestHostIdentity(socket);
                while (Date.now() < deadline) {
                    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Host exited during startup.");
                    identity = await requestHostIdentity(socket);
                    const recorded = await readFile(hostLifecyclePathIn(home), "utf8")
                        .then((data) => {
                            const record = JSON.parse(data) as { pid: number; state: string };
                            return record.pid === child.pid && record.state === "running";
                        }, () => false);
                    if (recorded && identity?.pid === child.pid && (!pooled || identity.workers_ready === 1)) break;
                    await Bun.sleep(25);
                }
                expect(identity?.pid).toBe(child.pid);
                if (identity === undefined) throw new Error("Host did not answer.");
                const requester = { pid: process.pid, client_kind: "tui", command: reason, session_id: "session-a" };
                const requestSocket = pooled ? join(home, "runtime", "w0.sock") : socket;
                const result = reason === "shutdown_if_idle"
                    ? await requestHostShutdownIfIdle(requestSocket, identity, HOST_PROTOCOL_VERSION, requester)
                    : reason === "shutdown_for_replacement"
                        ? await requestHostShutdownForReplacement(requestSocket, identity, HOST_PROTOCOL_VERSION, requester)
                        : await requestHostStop(requestSocket, identity, () => {}, { force: reason === "host_stop_force", requester });
                expect(result?.type).toBe(reason === "host_stop" || reason === "host_stop_force"
                    ? "stopped" : `${reason}_accepted`);
                expect(await child.exited).toBe(0);
                const entries = (await readFile(join(home, "runtime", "logs", "host.jsonl"), "utf8"))
                    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
                expect(entries).toContainEqual(expect.objectContaining({
                    type: "host_stopping", role: "host", pid: child.pid, reason, requester,
                }));
            } finally {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
                await Promise.race([child.exited, Bun.sleep(8_000)]);
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
                await child.exited;
                await stderr;
                await rm(root, { recursive: true, force: true });
            }
        }, 60_000);
    }
}

test("an update handoff records its target build", async () => {
    const home = await mkdtemp(join(tmpdir(), "hsu-"));
    const shutdown = Promise.withResolvers<void>();
    let cause: CompletedHostStop | undefined;
    const logPath = join(home, "runtime", "logs", "host.jsonl");
    try {
        const running = runResidentHostProcess({
            shutdownRequested: shutdown.promise,
            shutdownCause: () => cause ?? { reason: "shutdown_requested" },
            close: async () => {},
        }, {
            log: createHostLogger({ path: logPath }),
            waitForSignal: () => ({ promise: new Promise<void>(() => {}), dispose: () => {} }),
            exit: () => {},
        });
        const stop = new StopWhenIdle({
            waitingOn: () => [],
            onStopped: (value) => { cause = value; shutdown.resolve(); },
        });
        const requester = { pid: process.pid, client_kind: "cli", command: "update handoff" };
        expect(stop.request(() => {}, "vera-next", { requester }).accepted).toBe(true);
        await running;
        const entry = JSON.parse((await readFile(logPath, "utf8")).trim()) as Record<string, unknown>;
        expect(entry).toMatchObject({ type: "host_stopping", reason: "update", target_build_id: "vera-next", requester });
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { createAckWaiters, startWorker, type WorkerHandle } from "../../src/host/worker/handle.ts";
import {
    removeSessionBlock,
    writeSessionBlock,
} from "../../src/host/session-block.ts";

/**
 * A cut stops the running turn and drops the queued prompts, then clears its
 * halt so the next prompt can start. The worker is real; the model is scripted.
 */

const ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url),
);

const directories: string[] = [];
const handles: WorkerHandle[] = [];
const liveHome = mkdtempSync(join(tmpdir(), "vera-worker-block-home-"));
const previousVeraHome = process.env.VERA_HOME;
process.env.VERA_HOME = join(liveHome, ".vera");

afterAll(() => {
    for (const handle of handles) {
        handle.kill();
    }
    if (previousVeraHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousVeraHome;
    rmSync(liveHome, { recursive: true, force: true });
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
}

function toolCall(id: string, command: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "bash", input: { command } }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function text(body: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: body }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 20_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("Timed out waiting for the worker");
        }
        await Bun.sleep(25);
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function requestCount(logPath: string): number {
    if (!existsSync(logPath)) return 0;
    return readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;
}

test(
    "a cut stops a stepping session, drops its queued prompt, and leaves the next prompt free to start",
    async () => {
        const directory = workspace("vera-worker-cut-");
        const blockedDirectory = join(directory, "blocked");
        const requestLogPath = join(directory, "requests.log");
        const toolPidPath = join(directory, "tool.pid");
        const path = join(directory, "session.jsonl");
        const store = await SessionStore.create(path, {
            sessionId: "cutter",
            cwd: directory,
        });
        const updates: AgentUpdate[] = [];
        const handle = await startWorker({
            store,
            session: {
                path,
                header: JSON.parse(
                    readFileSync(path, "utf8").split("\n")[0] as string,
                ) as Record<string, unknown>,
                records: [],
            },
            model: "test",
            adapter: {
                module: ADAPTER,
                options: {
                    script: [
                        toolCall("call-hold", `echo $$ > '${toolPidPath}'; exec sleep 60`),
                        text("the queued prompt must not run"),
                        text("the prompt after the cut runs"),
                    ],
                    requestLogPath,
                },
            },
            data: { approvalMode: "full_access" },
            blockedDirectory,
            onUpdate: (update) => void updates.push(update),
        });
        handles.push(handle);

        handle.send({ type: "prompt", content: "hold a step open" });
        await waitFor(() => existsSync(toolPidPath));
        handle.send({ type: "prompt", content: "queued behind the first" });
        const toolPid = Number(readFileSync(toolPidPath, "utf8").trim());
        expect(alive(toolPid)).toBe(true);
        expect(requestCount(requestLogPath)).toBe(1);

        expect(await handle.cutWait("Vera is stopping", 5_000)).toBe(true);
        await waitFor(() =>
            updates.some((update) => update.type === "turn_finished")
        );
        await waitFor(() => !alive(toolPid));
        await Bun.sleep(300);
        expect(requestCount(requestLogPath)).toBe(1);

        handle.send({ type: "prompt", content: "after the cut" });
        await waitFor(() => requestCount(requestLogPath) === 2);
    },
    30_000,
);

test("a session.released answer does not settle a pending cut, and the cutAck does", async () => {
    const waiters = createAckWaiters();
    let requestId = "";
    const cut = waiters.ask("session.cutAck", 5_000, (id) => {
        requestId = id;
    });
    waiters.settle({ method: "session.released", requestId });
    const early = await Promise.race([
        cut.then((ok) => `settled ${ok}`),
        Bun.sleep(50).then(() => "pending"),
    ]);
    expect(early).toBe("pending");

    waiters.settle({ method: "session.cutAck", requestId, ok: true });
    expect(await cut).toBe(true);
});

test("a session.latched answer does not settle a pending release", async () => {
    const waiters = createAckWaiters();
    let requestId = "";
    const release = waiters.ask("session.released", 5_000, (id) => {
        requestId = id;
    });
    waiters.settle({ method: "session.latched", requestId, latched: true });
    const early = await Promise.race([
        release.then((ok) => `settled ${ok}`),
        Bun.sleep(50).then(() => "pending"),
    ]);
    expect(early).toBe("pending");

    waiters.settle({ method: "session.released", requestId });
    expect(await release).toBe(true);
});

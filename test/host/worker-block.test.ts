import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { startWorker, type WorkerHandle } from "../../src/host/worker/handle.ts";
import {
    removeSessionBlock,
    writeSessionBlock,
} from "../../src/host/session-block.ts";

/**
 * A block written while a session is mid-turn stops that turn and keeps its
 * queued prompts from starting. The worker is real; the model is scripted and
 * counts its requests, so "the next prompt never started" is observable.
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
    "a block stops a stepping session and its queued prompt never starts",
    async () => {
        const directory = workspace("vera-worker-block-");
        const blockedDirectory = join(directory, "blocked");
        const requestLogPath = join(directory, "requests.log");
        const toolPidPath = join(directory, "tool.pid");
        const path = join(directory, "session.jsonl");
        const store = await SessionStore.create(path, {
            sessionId: "stepper",
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
                        text("the second step must not run"),
                        text("the queued prompt must not run"),
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

        await writeSessionBlock(blockedDirectory, {
            version: 1,
            session_id: "stepper",
            root_session_id: "stepper",
            blocked_at: new Date().toISOString(),
            reason: "test",
        });

        await waitFor(() =>
            updates.some((update) => update.type === "turn_finished")
        );
        await waitFor(() => !alive(toolPid));
        await Bun.sleep(300);
        expect(requestCount(requestLogPath)).toBe(1);

        // Unblocking is acknowledged only after the worker releases its latch.
        await removeSessionBlock(blockedDirectory, "stepper");
        expect(await handle.releaseBlock(5_000)).toBe(true);
    },
    30_000,
);

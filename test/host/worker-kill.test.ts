import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { startWorker, type WorkerHandle } from "../../src/host/worker/handle.ts";
import type { RunHeadlessLoopServices } from "../../src/engine/loop-services.ts";
import { superviseWorker } from "../../src/host/worker-supervisor-handle.ts";

/**
 * The claim the process split exists to make true: a worker can be killed at
 * any instant and the host, its siblings, and the session file are unharmed.
 *
 * Everything but the model is real. Real processes, real signals, real session
 * files on disk, the real turn loop, and a real `bash` tool running a real
 * `sleep` when the kill lands. The model is scripted, so what is proven is the
 * loop and the process boundary, not what a model would have said.
 */

const ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url),
);
const WEDGED = fileURLToPath(
    new URL("./fixtures/wedged-worker.ts", import.meta.url),
);

const directories: string[] = [];
const liveHome = mkdtempSync(join(tmpdir(), "vera-worker-live-"));
const previousVeraHome = process.env.VERA_HOME;

beforeAll(() => {
    process.env.VERA_HOME = join(liveHome, ".vera");
});

afterAll(() => {
    if (previousVeraHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousVeraHome;
    rmSync(liveHome, { recursive: true, force: true });
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-worker-kill-"));
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

interface StartedWorker {
    readonly handle: WorkerHandle;
    readonly store: SessionStore;
    readonly path: string;
    readonly updates: AgentUpdate[];
}

async function startAgent(
    id: string,
    script: readonly AssistantMessage[],
    options: {
        readonly deadlineMs?: number;
        readonly data?: Record<string, unknown>;
        readonly services?: RunHeadlessLoopServices;
    } = {},
): Promise<StartedWorker> {
    const directory = workspace();
    const path = join(directory, "session.jsonl");
    let push: ((line: number, record: Record<string, unknown>) => void)
        | undefined;
    const store = await SessionStore.create(path, {
        sessionId: id,
        cwd: directory,
        onRecordAppended: (line, record) => push?.(line, record),
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
        adapter: { module: ADAPTER, options: { script } },
        data: { approvalMode: "full_access", ...options.data },
        ...(options.services === undefined
            ? {}
            : { services: options.services }),
        onUpdate: (update) => void updates.push(update),
        ...(options.deadlineMs === undefined
            ? {}
            : { deadlineMs: options.deadlineMs }),
    });
    push = handle.server.pushRecord;
    return { handle, store, path, updates };
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

test(
    "a worker killed mid-tool dies alone and leaves a resumable session",
    async () => {
        const toolPidPath = join(workspace(), "tool.pid");
        // The victim blocks in a real `sleep`, so the kill lands with a tool in
        // flight rather than between turns.
        const victim = await startAgent("victim", [
            toolCall(
                "call-sleep",
                `echo $$ > '${toolPidPath}'; exec sleep 60`,
            ),
            text("never reached"),
        ]);
        const sibling = await startAgent("sibling", [
            toolCall("call-echo", "echo alive"),
            text("sibling finished"),
        ]);

        victim.handle.send({ type: "prompt", content: "hold a tool open" });
        sibling.handle.send({ type: "prompt", content: "say something" });

        // The tool call reaching the client is the loop actually running in the
        // worker: the prompt crossed in, the model answered, and `bash` started.
        await waitFor(() =>
            victim.updates.some((update) => update.type === "tool_started")
        );
        await waitFor(() => existsSync(toolPidPath));
        const toolPid = Number(readFileSync(toolPidPath, "utf8").trim());
        expect(alive(victim.handle.pid)).toBe(true);
        expect(alive(toolPid)).toBe(true);

        process.kill(victim.handle.pid, "SIGKILL");

        const outcome = await victim.handle.outcome;
        expect(outcome).toEqual({ kind: "killed", signal: "SIGKILL" });
        await waitFor(() => !alive(victim.handle.pid));
        await waitFor(() => !alive(toolPid));

        // The host is this process, and it is still answering.
        expect(await Bun.file(victim.path).exists()).toBe(true);

        // The sibling under the same host was untouched.
        await waitFor(() =>
            sibling.updates.some((update) => update.type === "turn_finished")
        );
        expect(alive(sibling.handle.pid)).toBe(true);

        // The file parses and resumes: the user's prompt survived the kill,
        // which is the whole point of the host owning the write.
        const resumed = await SessionStore.open(victim.path);
        expect(resumed.header.id).toBe("victim");
        const roles = resumed.messages().map((message) => message.role);
        expect(roles).toContain("user");

        sibling.handle.kill();
        await sibling.handle.outcome;
    },
    60_000,
);

test("a wedged worker still dies at its deadline", async () => {
    const child = spawn("bun", [WEDGED], { stdio: ["ignore", "pipe", "ignore"] });
    const pid = await new Promise<number>((resolve) => {
        child.stdout.setEncoding("utf8");
        child.stdout.once("data", (chunk: string) => {
            resolve(Number(chunk.split(" ")[0]));
        });
    });

    const supervisor = superviseWorker({ pid, deadlineMs: Date.now() + 1_000 });
    // It ignores every catchable signal, so this must not end it.
    process.kill(pid, "SIGTERM");
    await Bun.sleep(200);
    expect(alive(pid)).toBe(true);

    const signal = await new Promise<string | null>((resolve) => {
        child.once("exit", (_code, exitSignal) => resolve(exitSignal));
    });
    expect(signal).toBe("SIGKILL");
    supervisor.detach();
}, 30_000);

test("a worker does not outlive the host that spawned it", async () => {
    const directory = workspace();
    const runner = join(directory, "host.ts");
    await Bun.write(
        runner,
        `import { spawn } from "node:child_process";\n`
            + `const child = spawn("bun", [${JSON.stringify(WEDGED)}], {\n`
            + `    stdio: ["ignore", "pipe", "ignore"],\n`
            + `});\n`
            + `const { superviseWorker } = await import(${
                JSON.stringify(
                    fileURLToPath(
                        new URL(
                            "../../src/host/worker-supervisor-handle.ts",
                            import.meta.url,
                        ),
                    ),
                )
            });\n`
            + `child.stdout.setEncoding("utf8");\n`
            + `child.stdout.once("data", (chunk) => {\n`
            + `    const pid = Number(String(chunk).split(" ")[0]);\n`
            + `    superviseWorker({ pid, deadlineMs: Date.now() + 600000 });\n`
            // The watch line has to reach the supervisor before this host can
            // be killed, or there is nothing holding the worker's pid.
            + `    setTimeout(() => process.stdout.write(pid + "\\n"), 500);\n`
            + `});\n`
            + `setInterval(() => {}, 1000);\n`,
    );
    const host = spawn("bun", [runner], {
        stdio: ["ignore", "pipe", "ignore"],
    });
    const workerPid = await new Promise<number>((resolve) => {
        host.stdout.setEncoding("utf8");
        host.stdout.once("data", (chunk: string) => resolve(Number(chunk)));
    });
    expect(alive(workerPid)).toBe(true);

    // A real kill of a real host, not a pipe closed from inside the test.
    process.kill(host.pid as number, "SIGKILL");
    await waitFor(() => !alive(workerPid), 15_000);
    expect(alive(workerPid)).toBe(false);
}, 30_000);

test("a host-owned tool effect is applied by the host", async () => {
    const applied: string[] = [];
    const agent = await startAgent(
        "effects",
        [
            {
                role: "assistant",
                content: [{
                    type: "tool_call",
                    id: "call-roster",
                    name: "agent_roster",
                    input: {},
                }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "tool_use",
            },
            text("read the roster"),
        ],
        {
            data: { enabledToolEffects: ["agent_roster"] },
            services: {
                applyToolEffect: async (effect: { readonly type: string }) => {
                    applied.push(effect.type);
                    return {
                        kind: "output",
                        output: "one participant",
                        isError: false,
                    };
                },
            } as unknown as RunHeadlessLoopServices,
        },
    );
    agent.handle.send({ type: "prompt", content: "who else is here" });
    await waitFor(() =>
        agent.updates.some((update) => update.type === "turn_finished")
    );
    // The effect crossed to this process and back: the worker never held the
    // roster, and the loop still saw a tool result.
    expect(applied).toEqual(["agent_roster"]);
    const store = await SessionStore.open(agent.path);
    expect(JSON.stringify(store.messages())).toContain("one participant");
    agent.handle.kill();
    await agent.handle.outcome;
}, 60_000);

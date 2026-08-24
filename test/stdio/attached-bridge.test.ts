import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AttachedAgentClient } from "../../src/host/attached-client.ts";
import type { BackgroundAgentsSnapshot } from "../../src/host/background-agents.ts";
import type { WorkIndexSnapshot } from "../../src/host/work-index.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import type {
    ExtensionCommandDescriptor,
    ExtensionCommandResult,
} from "../../src/extensions/commands.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import {
    createNdjsonEngineEndpoint,
    NdjsonInputEndedError,
    runAttachedStdioBridge,
} from "../../clients/stdio/ndjson-bridge.ts";

test("stdio forwards commands and rejects bad input without closing", async () => {
    const client = new FakeAttachedAgentClient();
    let output = "";
    await runAttachedStdioBridge(
        Readable.from([
            "not json\n",
            '{"type":"unknown"}\n',
            '{"type":"release_attachment","policy":"stop_if_last"}\n',
            '{"type":"prompt","content":"hello"}\n',
            '{"type":"abort"}\n',
            '{"type":"detach"}\n',
        ]),
        { write: (text) => output += text },
        client,
    );

    expect(client.sent).toEqual([
        { type: "prompt", content: "hello" },
        { type: "abort" },
    ]);
    expect(client.detached).toBe(true);
    expect(JSON.parse(output.split("\n")[2]!)).toEqual({
        type: "stdio_rejected",
        line: 1,
        reason: "invalid JSON",
    });
    expect(JSON.parse(output.split("\n")[3]!)).toEqual({
        type: "stdio_rejected",
        line: 2,
        reason: "unknown or invalid attached-client command",
    });
    expect(JSON.parse(output.split("\n")[4]!)).toEqual({
        type: "stdio_rejected",
        line: 3,
        reason: "attachment release is unavailable over stdio",
    });
});

test("the reusable NDJSON endpoint frames engine messages and EOF", async () => {
    let output = "";
    const endpoint = createNdjsonEngineEndpoint(
        Readable.from(['{"type":"prompt","content":"hello"}\n']),
        { write: (text) => output += text },
    );

    await expect(endpoint.receive()).resolves.toEqual({
        type: "prompt",
        content: "hello",
    });
    await expect(endpoint.receive()).rejects.toBeInstanceOf(NdjsonInputEndedError);
    endpoint.send({ type: "history", entries: [], seq: 0 });
    expect(JSON.parse(output)).toEqual({
        type: "history",
        entries: [],
        seq: 0,
    });
});

test("stdio frames updates after its attached marker", async () => {
    const client = new FakeAttachedAgentClient();
    const input = new Readable({ read() {} });
    let output = "";
    let sawHistory!: () => void;
    const historyWritten = new Promise<void>((resolve) => sawHistory = resolve);
    const run = runAttachedStdioBridge(
        input,
        {
            write: (text) => {
                output += text;
                if (text.includes('"type":"history"')) sawHistory();
            },
        },
        client,
    );
    client.updates.push({ type: "history", entries: [], seq: 0 });

    await historyWritten;
    input.push(null);
    await run;

    expect(output.split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual([
        {
            type: "stdio_attached",
            agent_id: "agent-1",
            workspace: "/workspace",
            protocol_version: 32,
        },
        {
            type: "background_agents",
            running: 0,
            children: [],
            has_parent: false,
        },
        { type: "history", entries: [], seq: 0 },
    ]);
});

test("stdio forwards current background agents and later pushes", async () => {
    const client = new FakeAttachedAgentClient({
        running: 1,
        children: ["child-1"],
        has_parent: true,
    });
    const input = new Readable({ read() {} });
    let output = "";
    let run!: Promise<void>;
    const backgroundWritten = new Promise<void>((resolve) => {
        run = runAttachedStdioBridge(
            input,
            {
                write: (text) => {
                    output += text;
                    if (text.includes('"running":2')) resolve();
                },
            },
            client,
        );
    });

    client.emitBackgroundAgents({
        running: 2,
        children: ["child-1", "child-2"],
        has_parent: true,
    });
    await backgroundWritten;
    input.push('{"type":"detach"}\n');
    await run;
    expect(output.split("\n").filter(Boolean).map((line) => JSON.parse(line)))
        .toContainEqual({
            type: "background_agents",
            running: 2,
            children: ["child-1", "child-2"],
            has_parent: true,
        });
});

test("stdio forwards the current work index and later pushes", async () => {
    const client = new FakeAttachedAgentClient();
    const initial: WorkIndexSnapshot = {
        rows: [],
        needs_you: 0,
        working: 0,
    };
    const changed: WorkIndexSnapshot = {
        rows: [{
            id: "approval:agent-2",
            session_id: "agent-2",
            session_path: "/sessions/agent-2.jsonl",
            title: "Review changes",
            section: "needs_you",
            reason: "approval",
            summary: "Approve bash",
            workspace: "/workspace",
            updated_at: "2026-08-22T12:00:00.000Z",
        }],
        needs_you: 1,
        working: 0,
    };
    client.setWorkIndex(initial);
    const input = new Readable({ read() {} });
    let output = "";
    let sawChanged!: () => void;
    const changedWritten = new Promise<void>((resolve) => sawChanged = resolve);
    const run = runAttachedStdioBridge(
        input,
        {
            write: (text) => {
                output += text;
                if (text.includes('"needs_you":1')) sawChanged();
            },
        },
        client,
    );

    client.emitWorkIndex(changed);
    await changedWritten;
    input.push('{"type":"detach"}\n');
    await run;

    const frames = output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(frames[0]).toMatchObject({ type: "stdio_attached" });
    expect(frames.slice(2)).toEqual([
        { type: "work_index", index: initial },
        { type: "work_index", index: changed },
    ]);
});

test("stdio forwards UI requests and responses unchanged", async () => {
    const client = new FakeAttachedAgentClient();
    const input = new Readable({ read() {} });
    const request: AgentUpdate = {
        type: "ui_request",
        requestId: "question-1",
        request: {
            type: "user_question",
            question: "Continue?",
            choices: [{ id: "yes", label: "Yes" }],
        },
        seq: 1,
    };
    const response: ClientCommand = {
        type: "ui_response",
        requestId: "question-1",
        response: { type: "user_question", outcome: "selected", choiceId: "yes" },
    };
    let output = "";
    let sawRequest!: () => void;
    let sawResponse!: () => void;
    const requestWritten = new Promise<void>((resolve) => sawRequest = resolve);
    const responseForwarded = new Promise<void>((resolve) => sawResponse = resolve);
    const stopWatching = client.onCommand((command) => {
        if (command.type === "ui_response") sawResponse();
    });
    const run = runAttachedStdioBridge(
        input,
        {
            write: (text) => {
                output += text;
                if (text.includes('"type":"ui_request"')) sawRequest();
            },
        },
        client,
    );

    client.updates.push(request);
    await requestWritten;
    input.push(`${JSON.stringify(response)}\n`);
    await responseForwarded;
    input.push('{"type":"detach"}\n');
    await run;
    stopWatching();

    expect(output.split("\n").filter(Boolean).map((line) => JSON.parse(line))[2])
        .toEqual(request);
    expect(client.sent).toContainEqual(response);
});

test("stdio forwards extension command responses", async () => {
    const client = new FakeAttachedAgentClient();
    let output = "";
    await runAttachedStdioBridge(
        Readable.from([
            '{"type":"list_extension_commands","request_id":"list-1"}\n',
            '{"type":"run_extension_command","request_id":"run-1","command":"hello","arguments_text":"world"}\n',
            '{"type":"detach"}\n',
        ]),
        { write: (text) => output += text },
        client,
    );

    expect(output.split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual([
        {
            type: "stdio_attached",
            agent_id: "agent-1",
            workspace: "/workspace",
            protocol_version: 32,
        },
        {
            type: "background_agents",
            running: 0,
            children: [],
            has_parent: false,
        },
        {
            type: "extension_command_list",
            request_id: "list-1",
            commands: [{
                name: "hello",
                description: "Say hello",
                usage: "/hello",
                source: "test",
            }],
        },
        {
            type: "extension_command_result",
            request_id: "run-1",
            result: {
                version: 1,
                source: "test/hello",
                body: { kind: "text", text: "world" },
            },
        },
    ]);
});

test("stdio does not swallow an attached-host failure", async () => {
    const client = new FakeAttachedAgentClient();
    const run = runAttachedStdioBridge(
        new Readable({ read() {} }),
        { write: () => {} },
        client,
    );
    client.updates.fail(new Error("host connection lost"));

    await expect(run).rejects.toThrow("host connection lost");
});

test("stdio treats an already-aborted signal like a clean detach", async () => {
    const client = new FakeAttachedAgentClient();
    const stopping = new AbortController();
    stopping.abort();

    await runAttachedStdioBridge(
        new Readable({ read() {} }),
        { write: () => {} },
        client,
        { signal: stopping.signal },
    );

    expect(client.detached).toBe(true);
});

test("stdio drives a real resident host turn and leaves the agent running", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-stdio-host-"));
    const workspace = await realpath(root);
    const socketPath = join(root, "host.sock");
    const host = await startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
            approval_mode: "auto",
        },
        createAdapter: () => new FauxAdapter([textResponse("hello")]),
        socketPath,
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
    });

    try {
        const created = await createAgentThroughHost(socketPath, workspace);
        const client = await attachReconnectingAgent({
            socketPath: () => socketPath,
            agentId: created.id,
        });
        try {
            const input = new Readable({ read() {} });
            const frames: Record<string, unknown>[] = [];
            let resolveTurn: (() => void) | undefined;
            const turnFinished = new Promise<void>((resolve) => {
                resolveTurn = resolve;
            });
            const run = runAttachedStdioBridge(
                input,
                {
                    write: (text) => {
                        for (const line of text.split("\n")) {
                            if (line.trim().length === 0) continue;
                            const frame = JSON.parse(line) as Record<string, unknown>;
                            frames.push(frame);
                            if (frame.type === "turn_finished") resolveTurn?.();
                        }
                    },
                },
                client,
            );

            input.push('{"type":"prompt","content":"say hi"}\n');
            await turnFinished;
            input.push(null);
            await run;

            expect(frames[0]).toEqual({
                type: "stdio_attached",
                agent_id: created.id,
                workspace,
                protocol_version: 32,
            });
            expect(frames.some((frame) => frame.type === "context"
                && typeof (frame.measurement as { capacity?: unknown })?.capacity === "number"))
                .toBe(true);
            expect(frames.some((frame) => frame.type === "turn_finished")).toBe(true);
        } finally {
            if (!client.closed) client.close();
        }

        expect(await listAgentsThroughHost(socketPath)).toContainEqual(
            expect.objectContaining({ id: created.id }),
        );
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("stdio carries a breaker trip out of a real resident host turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-stdio-breaker-"));
    const workspace = await realpath(root);
    const socketPath = join(root, "host.sock");
    const host = await startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
            approval_mode: "readonly",
        },
        createAdapter: () =>
            new FauxAdapter([
                toolCallResponse("b1", "bash", { command: "echo one" }),
                toolCallResponse("b2", "bash", { command: "echo two" }),
                toolCallResponse("b3", "bash", { command: "echo three" }),
                textResponse("stopped"),
            ]),
        socketPath,
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
    });

    try {
        const created = await createAgentThroughHost(socketPath, workspace);
        const client = await attachReconnectingAgent({
            socketPath: () => socketPath,
            agentId: created.id,
        });
        try {
            const input = new Readable({ read() {} });
            const frames: Record<string, unknown>[] = [];
            let resolveTurn: (() => void) | undefined;
            const turnFinished = new Promise<void>((resolve) => {
                resolveTurn = resolve;
            });
            const run = runAttachedStdioBridge(
                input,
                {
                    write: (text) => {
                        for (const line of text.split("\n")) {
                            if (line.trim().length === 0) continue;
                            const frame = JSON.parse(line) as Record<string, unknown>;
                            frames.push(frame);
                            if (frame.type === "turn_finished") resolveTurn?.();
                        }
                    },
                },
                client,
            );

            input.push('{"type":"prompt","content":"run the script"}\n');
            await turnFinished;
            input.push(null);
            await run;

            const trips = frames.filter(
                (frame) => frame.type === "tool_breaker_tripped",
            );
            expect(trips).toHaveLength(1);
            expect(trips[0]).toMatchObject({
                type: "tool_breaker_tripped",
                tool: "bash",
                denials: 3,
                action: "withheld",
            });
            expect(typeof trips[0]!.seq).toBe("number");
        } finally {
            if (!client.closed) client.close();
        }
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("vera stdio creates, attaches, and resumes through a temporary host", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-stdio-cli-"));
    const runtime = join(root, "runtime");
    await mkdir(runtime, { recursive: true });
    const startHost = (
        responses: AssistantMessage[],
    ): ReturnType<typeof startResidentHost> => startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
            approval_mode: "auto",
        },
        createAdapter: () => new FauxAdapter(responses),
        socketPath: join(runtime, "host.sock"),
        lockPath: join(runtime, "host.json"),
        sessionDirectory: join(runtime, "sessions"),
        eventLogDirectory: join(runtime, "logs"),
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined =
        await startHost([textResponse("created"), textResponse("attached")]);

    try {
        const createdFrames = await driveStdio([], "create a session", true);
        expect(createdFrames[0]).toMatchObject({
            type: "stdio_attached",
            workspace: process.cwd(),
            protocol_version: 32,
        });
        expect(createdFrames).toContainEqual(expect.objectContaining({
            type: "stdio_rejected",
            line: 1,
            reason: "invalid JSON",
        }));
        expect(createdFrames.some((frame) => frame.type === "context"
            && typeof (frame.measurement as { capacity?: unknown })?.capacity
                === "number")).toBe(true);

        const agentId = createdFrames[0]?.agent_id;
        if (typeof agentId !== "string") {
            throw new Error("stdio did not report its created agent id");
        }
        const attachedFrames = await driveStdio(
            ["--attach", agentId],
            "attach to the session",
        );
        expect(attachedFrames[0]).toMatchObject({
            type: "stdio_attached",
            agent_id: agentId,
        });

        const registered = (await listAgentsThroughHost(join(runtime, "host.sock")))
            .find((agent) => agent.id === agentId);
        if (registered === undefined) {
            throw new Error("created stdio agent was not registered");
        }
        await host.close();
        host = undefined;
        host = await startHost([textResponse("resumed")]);

        const resumedFrames = await driveStdio(
            ["--resume", registered.session_path],
            "resume the session",
        );
        expect(resumedFrames[0]).toMatchObject({
            type: "stdio_attached",
            workspace: process.cwd(),
        });
        expect(resumedFrames.some((frame) => frame.type === "turn_finished"))
            .toBe(true);
    } finally {
        await host?.close();
        await rm(root, { recursive: true, force: true });
    }

    async function driveStdio(
        args: readonly string[],
        prompt: string,
        rejectFirst = false,
    ): Promise<readonly Record<string, unknown>[]> {
        const child = Bun.spawn([
            process.execPath,
            "clients/cli/main.ts",
            "--profile",
            "uat",
            "stdio",
            ...args,
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                VERA_RUNTIME_DIR: runtime,
            },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        try {
            const input = child.stdin as {
                write(value: string): unknown;
                end(): unknown;
            };
            const output = collectProcessFrames(
                child.stdout as ReadableStream<Uint8Array>,
            );
            const errorOutput = new Response(
                child.stderr as ReadableStream<Uint8Array>,
            ).text();
            if (rejectFirst) input.write("not json\n");
            input.write(`${JSON.stringify({ type: "prompt", content: prompt })}\n`);
            await output.turnFinished;
            input.end();

            const [frames, exitCode, errors] = await Promise.all([
                output.done,
                child.exited,
                errorOutput,
            ]);
            expect(exitCode).toBe(0);
            expect(errors).toBe("");
            expect(frames.some((frame) => frame.type === "turn_finished"))
                .toBe(true);
            return frames;
        } finally {
            if (!child.killed) {
                child.kill("SIGKILL");
                await child.exited;
            }
        }
    }
});

class FakeAttachedAgentClient implements AttachedAgentClient {
    readonly agentId = "agent-1";
    readonly workspace = "/workspace";
    readonly lastSequence = undefined;
    readonly capabilities: readonly string[] = [];
    private currentBackgroundAgents: BackgroundAgentsSnapshot = {
        running: 0,
        children: [],
        has_parent: false,
    };
    readonly updates = new AsyncQueue<AgentUpdate>();
    readonly sent: ClientCommand[] = [];
    detached = false;
    private currentWorkIndex: WorkIndexSnapshot | undefined;
    private readonly backgroundListeners = new Set<
        (agents: BackgroundAgentsSnapshot) => void
    >();
    private readonly workIndexListeners = new Set<
        (index: WorkIndexSnapshot) => void
    >();
    private readonly commandListeners = new Set<
        (command: ClientCommand) => void
    >();

    constructor(backgroundAgents?: BackgroundAgentsSnapshot) {
        if (backgroundAgents !== undefined) {
            this.currentBackgroundAgents = backgroundAgents;
        }
    }

    supportsHostCapability(): boolean {
        return false;
    }

    get backgroundAgents(): BackgroundAgentsSnapshot {
        return this.currentBackgroundAgents;
    }

    onBackgroundAgents(
        listener: (agents: BackgroundAgentsSnapshot) => void,
    ): () => void {
        this.backgroundListeners.add(listener);
        return () => this.backgroundListeners.delete(listener);
    }

    emitBackgroundAgents(agents: BackgroundAgentsSnapshot): void {
        this.currentBackgroundAgents = agents;
        for (const listener of this.backgroundListeners) listener(agents);
    }

    get workIndex(): WorkIndexSnapshot | undefined {
        return this.currentWorkIndex;
    }

    onWorkIndex(listener: (index: WorkIndexSnapshot) => void): () => void {
        this.workIndexListeners.add(listener);
        return () => this.workIndexListeners.delete(listener);
    }

    setWorkIndex(index: WorkIndexSnapshot): void {
        this.currentWorkIndex = index;
    }

    emitWorkIndex(index: WorkIndexSnapshot): void {
        this.setWorkIndex(index);
        for (const listener of this.workIndexListeners) listener(index);
    }

    onCommand(listener: (command: ClientCommand) => void): () => void {
        this.commandListeners.add(listener);
        return () => this.commandListeners.delete(listener);
    }

    send(command: ClientCommand): Promise<void> {
        this.sent.push(command);
        for (const listener of this.commandListeners) listener(command);
        return Promise.resolve();
    }

    receive(signal?: AbortSignal): Promise<AgentUpdate> {
        return this.updates.receive(signal);
    }

    listExtensionCommands(): Promise<readonly ExtensionCommandDescriptor[]> {
        return Promise.resolve([{
            name: "hello",
            description: "Say hello",
            usage: "/hello",
            source: "test",
        }]);
    }

    runExtensionCommand(
        _command: string,
        argumentsText: string,
    ): Promise<ExtensionCommandResult> {
        return Promise.resolve({
            version: 1,
            source: "test/hello",
            body: { kind: "text", text: argumentsText },
        });
    }

    async detach(): Promise<void> {
        this.detached = true;
        this.updates.fail(new Error("detached"));
    }

    close(): void {
        this.updates.fail(new Error("closed"));
    }

    get closed(): boolean {
        return this.detached;
    }
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function toolCallResponse(
    id: string,
    name: string,
    input: Record<string, unknown>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name, input }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function collectProcessFrames(
    stream: ReadableStream<Uint8Array>,
): {
    readonly turnFinished: Promise<void>;
    readonly done: Promise<readonly Record<string, unknown>[]>;
} {
    const frames: Record<string, unknown>[] = [];
    let resolveTurn: (() => void) | undefined;
    let rejectTurn: ((error: Error) => void) | undefined;
    const turnFinished = new Promise<void>((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
    });
    const done = (async (): Promise<readonly Record<string, unknown>[]> => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        try {
            while (true) {
                const { done: ended, value } = await reader.read();
                buffered += decoder.decode(value, { stream: !ended });
                let newline = buffered.indexOf("\n");
                while (newline !== -1) {
                    const line = buffered.slice(0, newline);
                    buffered = buffered.slice(newline + 1);
                    if (line.trim().length > 0) {
                        const frame = JSON.parse(line) as Record<string, unknown>;
                        frames.push(frame);
                        if (frame.type === "turn_finished") resolveTurn?.();
                    }
                    newline = buffered.indexOf("\n");
                }
                if (ended) break;
            }
            if (!frames.some((frame) => frame.type === "turn_finished")) {
                rejectTurn?.(new Error("vera stdio exited before turn_finished"));
            }
            return frames;
        } catch (error) {
            rejectTurn?.(error instanceof Error ? error : new Error(String(error)));
            throw error;
        } finally {
            reader.releaseLock();
        }
    })();
    return { turnFinished, done };
}

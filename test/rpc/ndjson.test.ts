import { expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { AgentUpdate, ClientCommand } from "../../src/engine/protocol.ts";
import { createNdjsonEngineEndpoint } from "../../clients/stdio/ndjson-bridge.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const projectRoot = process.cwd();

test("NDJSON parses a typed UI response", async () => {
    const frame: ClientCommand = {
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow" },
    };
    const input = Readable.from([`${JSON.stringify(frame)}\n`]);
    const endpoint = createNdjsonEngineEndpoint(input, { write() {} });

    expect(await endpoint.receive()).toEqual(frame);
});

test("NDJSON writes task notifications as ordinary agent updates", () => {
    let output = "";
    const endpoint = createNdjsonEngineEndpoint(
        Readable.from([]),
        { write: (text) => output += text },
    );
    endpoint.send({
        type: "task_notification",
        deliveryId: "completion:child-1",
        sourceAgentId: "child-1",
        content: "The tests pass.",
        seq: 7,
    });

    expect(JSON.parse(output)).toEqual({
        type: "task_notification",
        deliveryId: "completion:child-1",
        sourceAgentId: "child-1",
        content: "The tests pass.",
        seq: 7,
    });
});

test("NDJSON frames stream and abort across a process boundary", async () => {
    const child = Bun.spawn(
        [process.execPath, "test/support/ndjson-child.ts"],
        {
            cwd: process.cwd(),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    const frames = readFrames(child.stdout);

    expect(await frames.next()).toEqual({
        type: "history",
        entries: [],
        seq: 0,
    });
    sendFrame(child.stdin, { type: "prompt", content: "say hello" });
    expect(await frames.next()).toEqual({
        type: "user_prompt",
        content: "say hello",
        seq: 1,
    });
    expect(await frames.next()).toEqual({
        type: "assistant_delta",
        text: "h",
        seq: 2,
    });

    const firstTurn: AgentUpdate[] = [];
    while (firstTurn.at(-1)?.type !== "turn_finished") {
        firstTurn.push(await frames.next());
    }
    expect(firstTurn.filter((frame) => frame.type === "assistant_delta"))
        .toHaveLength(4);

    sendFrame(child.stdin, { type: "prompt", content: "start slowly" });
    expect(await frames.next()).toMatchObject({
        type: "history",
        seq: 7,
    });
    expect(await frames.next()).toEqual({
        type: "user_prompt",
        content: "start slowly",
        seq: 8,
    });
    expect(await frames.next()).toEqual({
        type: "assistant_delta",
        text: "a",
        seq: 9,
    });
    sendFrame(child.stdin, { type: "prompt", content: "keep this prompt" });
    sendFrame(child.stdin, { type: "abort" });

    const abortedTurn: AgentUpdate[] = [];
    while (abortedTurn.at(-1)?.type !== "turn_finished") {
        abortedTurn.push(await frames.next());
    }
    const abortedText = abortedTurn
        .filter((frame) => frame.type === "assistant_delta")
        .map((frame) => frame.text)
        .join("");
    expect(abortedText).not.toBe("bcdefgh");

    const queuedTurn: AgentUpdate[] = [];
    while (queuedTurn.at(-1)?.type !== "turn_finished") {
        queuedTurn.push(await frames.next());
    }
    const queuedText = queuedTurn
        .filter((frame) => frame.type === "assistant_delta")
        .map((frame) => frame.text)
        .join("");
    expect(queuedText).toBe("queued");

    child.stdin.end();
    expect(await child.exited).toBe(0);
}, 5_000);

test("stdin EOF waits for the active turn to finish", async () => {
    const child = Bun.spawn(
        [process.execPath, "test/support/ndjson-child.ts"],
        {
            cwd: process.cwd(),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    const frames = readFrames(child.stdout);

    sendFrame(child.stdin, { type: "prompt", content: "one piped prompt" });
    child.stdin.end();

    const turn: AgentUpdate[] = [];
    while (turn.at(-1)?.type !== "turn_finished") {
        turn.push(await frames.next());
    }
    const text = turn
        .filter((frame) => frame.type === "assistant_delta")
        .map((frame) => frame.text)
        .join("");
    expect(text).toBe("hello");
    expect(await child.exited).toBe(0);
}, 5_000);

test("a killed process resumes with its full durable context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-resume-"));
    const sessionPath = join(directory, "session.jsonl");
    const eventLogPath = join(directory, "events.jsonl");
    const originalWorkspace = join(directory, "original-workspace");
    const restartWorkspace = join(directory, "restart-workspace");
    let first: ReturnType<typeof spawnSessionChild> | undefined;
    let resumed: ReturnType<typeof spawnSessionChild> | undefined;

    try {
        await mkdir(originalWorkspace);
        await mkdir(restartWorkspace);
        const storedWorkspace = await realpath(originalWorkspace);
        await writeFile(eventLogPath, "this is not an event log\n");
        first = spawnSessionChild(
            "new",
            sessionPath,
            eventLogPath,
            originalWorkspace,
        );
        const firstFrames = readFrames(first.stdout);

        sendFrame(first.stdin, { type: "prompt", content: "remember alpha" });
        expect(await readTurnText(firstFrames)).toBe("stored alpha");

        sendFrame(first.stdin, { type: "prompt", content: "hang now" });
        expect(await firstFrames.next()).toMatchObject({
            type: "history",
            seq: 14,
        });
        expect(await firstFrames.next()).toEqual({
            type: "user_prompt",
            content: "hang now",
            seq: 15,
        });
        expect(await firstFrames.next()).toEqual({
            type: "assistant_delta",
            text: "a",
            seq: 16,
        });
        first.kill();
        await first.exited;

        resumed = spawnSessionChild(
            "resume",
            sessionPath,
            eventLogPath,
            restartWorkspace,
        );
        const resumedFrames = readFrames(resumed.stdout);
        sendFrame(resumed.stdin, { type: "prompt", content: "after restart" });

        expect(await readTurnText(resumedFrames)).toBe(
            "context=user:remember alpha|assistant:stored alpha|user:hang now"
            + "|user:after restart;safe_roles=user,assistant,user,user"
            + `;workspace=${storedWorkspace}`,
        );
        resumed.stdin.end();
        expect(await resumed.exited).toBe(0);

        const reopened = await SessionStore.open(sessionPath);
        const messages = reopened.messages();
        expect(messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user",
            "user",
            "assistant",
        ]);
        const loggedSessionIds = (await readFile(eventLogPath, "utf8"))
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .map((line) => JSON.parse(line) as { readonly sessionId: string })
            .map((line) => line.sessionId);
        expect([...new Set(loggedSessionIds)]).toEqual([reopened.header.id]);
    } finally {
        first?.kill();
        resumed?.kill();
        await rm(directory, { recursive: true, force: true });
    }
}, 10_000);

test("resuming an unpaired tool call produces provider-safe history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-dangling-tool-"));
    const sessionPath = join(directory, "session.jsonl");
    let child: ReturnType<typeof spawnSessionChild> | undefined;

    try {
        const store = await SessionStore.create(sessionPath, {
            sessionId: "dangling-tool",
            cwd: process.cwd(),
        });
        await store.appendMessage({
            role: "user",
            content: [{ type: "text", text: "use a tool" }],
        });
        await store.appendMessage({
            role: "assistant",
            content: [
                {
                    type: "tool_call",
                    id: "call_read",
                    name: "read",
                    input: { path: "package.json" },
                },
            ],
            source: { provider: "faux", api: "strict-replay", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        });

        child = spawnSessionChild("resume", sessionPath);
        const frames = readFrames(child.stdout);
        sendFrame(child.stdin, { type: "prompt", content: "continue" });

        expect(await readTurnText(frames)).toBe(
            "context=user:use a tool|assistant_tools:read|user:continue;"
            + "safe_roles=user,assistant,tool_result,user"
            + `;workspace=${process.cwd()}`,
        );
        child.stdin.end();
        expect(await child.exited).toBe(0);
    } finally {
        child?.kill();
        await rm(directory, { recursive: true, force: true });
    }
}, 5_000);

test("NDJSON resume restores durable permissions over current defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-permissions-resume-"));
    const sessionPath = join(directory, "session.jsonl");
    let child: ReturnType<typeof spawnSessionChild> | undefined;

    try {
        const store = await SessionStore.create(sessionPath, {
            sessionId: "permissions-resume",
            cwd: process.cwd(),
        });
        await store.appendApprovalMode("full_access");

        child = spawnSessionChild(
            "resume",
            sessionPath,
            undefined,
            process.cwd(),
            "ask",
        );
        const frames = readFrames(child.stdout);
        expect(await frames.next()).toMatchObject({ type: "history" });
        sendFrame(child.stdin, {
            type: "get_permissions",
            requestId: "read-restored-permissions",
        });
        expect(await frames.next()).toMatchObject({
            type: "permissions",
            requestId: "read-restored-permissions",
            mode: "full_access",
            pending: false,
        });

        child.stdin.end();
        expect(await child.exited).toBe(0);
    } finally {
        child?.kill();
        await rm(directory, { recursive: true, force: true });
    }
}, 5_000);

function sendFrame(
    input: Bun.FileSink,
    frame: ClientCommand,
): void {
    input.write(`${JSON.stringify(frame)}\n`);
    input.flush();
}

function spawnSessionChild(
    mode: "new" | "resume",
    sessionPath: string,
    eventLogPath?: string,
    cwd = process.cwd(),
    approvalMode?: "ask" | "approve_for_me" | "full_access",
) {
    return Bun.spawn(
        [
            process.execPath,
            join(projectRoot, "test/support/session-resume-child.ts"),
            mode,
            sessionPath,
            ...(eventLogPath === undefined ? [] : [eventLogPath]),
        ],
        {
            cwd,
            env: {
                ...process.env,
                ...(approvalMode === undefined
                    ? {}
                    : { VERA_TEST_APPROVAL_MODE: approvalMode }),
            },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
}

async function readTurnText(
    frames: ReturnType<typeof readFrames>,
): Promise<string> {
    let text = "";
    while (true) {
        const frame = await frames.next();
        if (frame.type === "assistant_delta") {
            text += frame.text;
        }
        if (frame.type === "turn_finished") {
            return text;
        }
    }
}

function readFrames(stream: ReadableStream<Uint8Array>): {
    next(): Promise<AgentUpdate>;
} {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const lines: string[] = [];
    const waiters: Array<(frame: AgentUpdate) => void> = [];
    let pending = "";

    void (async () => {
        while (true) {
            const result = await reader.read();
            if (result.done) {
                return;
            }
            pending += decoder.decode(result.value, { stream: true });
            const parts = pending.split("\n");
            pending = parts.pop() ?? "";
            for (const line of parts) {
                const waiter = waiters.shift();
                if (waiter === undefined) {
                    lines.push(line);
                } else {
                    waiter(JSON.parse(line) as AgentUpdate);
                }
            }
        }
    })();

    return {
        next(): Promise<AgentUpdate> {
            const line = lines.shift();
            if (line !== undefined) {
                return Promise.resolve(JSON.parse(line) as AgentUpdate);
            }
            return new Promise((resolve) => waiters.push(resolve));
        },
    };
}

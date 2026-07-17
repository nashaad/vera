import { expect, test } from "bun:test";
import { Readable } from "node:stream";

import type { AgentFrame, ClientFrame } from "../../src/engine/frames.ts";
import { createNdjsonEngineEndpoint } from "../../clients/stdio/ndjson-bridge.ts";

test("NDJSON parses a typed UI response", async () => {
    const frame: ClientFrame = {
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow" },
    };
    const input = Readable.from([`${JSON.stringify(frame)}\n`]);
    const endpoint = createNdjsonEngineEndpoint(input, { write() {} });

    expect(await endpoint.receive()).toEqual(frame);
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

    sendFrame(child.stdin, { type: "prompt", content: "say hello" });
    expect(await frames.next()).toEqual({
        type: "assistant_delta",
        text: "h",
        seq: 1,
    });

    const firstTurn: AgentFrame[] = [];
    while (firstTurn.at(-1)?.type !== "turn_finished") {
        firstTurn.push(await frames.next());
    }
    expect(firstTurn.filter((frame) => frame.type === "assistant_delta"))
        .toHaveLength(4);

    sendFrame(child.stdin, { type: "prompt", content: "start slowly" });
    expect(await frames.next()).toEqual({
        type: "assistant_delta",
        text: "a",
        seq: 7,
    });
    sendFrame(child.stdin, { type: "prompt", content: "keep this prompt" });
    sendFrame(child.stdin, { type: "abort" });

    const abortedTurn: AgentFrame[] = [];
    while (abortedTurn.at(-1)?.type !== "turn_finished") {
        abortedTurn.push(await frames.next());
    }
    const abortedText = abortedTurn
        .filter((frame) => frame.type === "assistant_delta")
        .map((frame) => frame.text)
        .join("");
    expect(abortedText).not.toBe("bcdefgh");

    const queuedTurn: AgentFrame[] = [];
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

    const turn: AgentFrame[] = [];
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

function sendFrame(
    input: Bun.FileSink,
    frame: ClientFrame,
): void {
    input.write(`${JSON.stringify(frame)}\n`);
    input.flush();
}

function readFrames(stream: ReadableStream<Uint8Array>): {
    next(): Promise<AgentFrame>;
} {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const lines: string[] = [];
    const waiters: Array<(frame: AgentFrame) => void> = [];
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
                    waiter(JSON.parse(line) as AgentFrame);
                }
            }
        }
    })();

    return {
        next(): Promise<AgentFrame> {
            const line = lines.shift();
            if (line !== undefined) {
                return Promise.resolve(JSON.parse(line) as AgentFrame);
            }
            return new Promise((resolve) => waiters.push(resolve));
        },
    };
}

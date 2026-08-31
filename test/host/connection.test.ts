import { expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
    connectHost,
    isExpectedHostClose,
    type HostConnection,
} from "../../src/host/connection.ts";

const skipIfNoNetwork = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

async function withServer(
    onSocket: (socket: Socket) => void,
    run: (socketPath: string) => Promise<void>,
): Promise<void> {
    const directory = mkdtempSync(join("/private/tmp", "vera-connection-"));
    const socketPath = join(directory, "host.sock");
    const server: Server = createServer(onSocket);
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        await run(socketPath);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined
                ? resolve()
                : reject(error));
        });
        rmSync(directory, { recursive: true, force: true });
    }
}

skipIfNoNetwork(
    "sends and receives newline-delimited JSON frames in order",
    async () => {
        await withServer(
            (socket) => {
                socket.setEncoding("utf8");
                let buffered = "";
                socket.on("data", (chunk: string) => {
                    buffered += chunk;
                    let newline = buffered.indexOf("\n");
                    while (newline !== -1) {
                        const request = JSON.parse(buffered.slice(0, newline));
                        buffered = buffered.slice(newline + 1);
                        socket.write(`${JSON.stringify({ echo: request })}\n`);
                        newline = buffered.indexOf("\n");
                    }
                });
            },
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                try {
                    await connection.send({ n: 1 });
                    await connection.send({ n: 2 });
                    expect(await connection.receive()).toEqual({
                        echo: { n: 1 },
                    });
                    expect(await connection.receive()).toEqual({
                        echo: { n: 2 },
                    });
                } finally {
                    connection.close();
                }
            },
        );
    },
);

skipIfNoNetwork(
    "propagates malformed JSON lines to pending receivers",
    async () => {
        await withServer(
            (socket) => socket.write("not json\n"),
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                await expect(connection.receive()).rejects.toThrow(
                    /malformed/,
                );
                expect(connection.closed).toBe(true);
            },
        );
    },
);

skipIfNoNetwork(
    "propagates oversized lines to pending receivers",
    async () => {
        await withServer(
            (socket) => socket.write(`${"a".repeat(64)}\n`),
            async (socketPath) => {
                const connection = await connectHost({
                    socketPath,
                    maxLineBytes: 16,
                });
                try {
                    await expect(connection.receive()).rejects.toThrow(
                        /maximum size/,
                    );
                    expect(connection.closed).toBe(false);
                } finally {
                    connection.close();
                }
            },
        );
    },
);

skipIfNoNetwork(
    "keeps the frames after an oversized one readable",
    async () => {
        await withServer(
            (socket) =>
                socket.write(`{"n":1}\n${"a".repeat(64)}\n{"n":2}\n`),
            async (socketPath) => {
                const connection = await connectHost({
                    socketPath,
                    maxLineBytes: 16,
                });
                try {
                    expect(await connection.receive()).toEqual({ n: 1 });
                    await expect(connection.receive()).rejects.toThrow(
                        /maximum size/,
                    );
                    expect(await connection.receive()).toEqual({ n: 2 });
                } finally {
                    connection.close();
                }
            },
        );
    },
);

skipIfNoNetwork(
    "discards an oversized frame arriving across several chunks",
    async () => {
        await withServer(
            (socket) => {
                socket.write("a".repeat(64));
                socket.write("a".repeat(64));
                socket.write(`\n{"n":7}\n`);
            },
            async (socketPath) => {
                const connection = await connectHost({
                    socketPath,
                    maxLineBytes: 16,
                });
                try {
                    await expect(connection.receive()).rejects.toThrow(
                        /maximum size/,
                    );
                    expect(await connection.receive()).toEqual({ n: 7 });
                } finally {
                    connection.close();
                }
            },
        );
    },
);

skipIfNoNetwork(
    "refuses to send a frame over the limit without closing",
    async () => {
        await withServer(
            (socket) => socket.write(`{"n":1}\n`),
            async (socketPath) => {
                const connection = await connectHost({
                    socketPath,
                    maxLineBytes: 16,
                });
                try {
                    await expect(connection.send({ big: "a".repeat(64) }))
                        .rejects.toThrow(/maximum size/);
                    expect(connection.closed).toBe(false);
                    expect(await connection.receive()).toEqual({ n: 1 });
                } finally {
                    connection.close();
                }
            },
        );
    },
);

skipIfNoNetwork(
    "checks each frame's own size instead of the whole received chunk",
    async () => {
        await withServer(
            (socket) => socket.write('{"n":1}\n{"n":2}\n'),
            async (socketPath) => {
                const connection = await connectHost({
                    socketPath,
                    maxLineBytes: 10,
                });
                try {
                    expect(await connection.receive()).toEqual({ n: 1 });
                    expect(await connection.receive()).toEqual({ n: 2 });
                } finally {
                    connection.close();
                }
            },
        );
    },
);

skipIfNoNetwork(
    "accepts a line whose content is exactly at the byte limit",
    async () => {
        const value = { s: "a".repeat(10) };
        const line = JSON.stringify(value);
        const maxLineBytes = Buffer.byteLength(line);
        await withServer(
            (socket) => socket.write(`${line}\n`),
            async (socketPath) => {
                const connection = await connectHost({
                    socketPath,
                    maxLineBytes,
                });
                try {
                    expect(await connection.receive()).toEqual(value);
                } finally {
                    connection.close();
                }
            },
        );
    },
);

skipIfNoNetwork(
    "propagates invalid UTF-8 bytes as malformed",
    async () => {
        await withServer(
            (socket) => socket.write(Buffer.from([0xff, 0xfe, 0x0a])),
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                await expect(connection.receive()).rejects.toThrow(
                    /malformed/,
                );
                expect(connection.closed).toBe(true);
            },
        );
    },
);

skipIfNoNetwork(
    "pauses and resumes so values queued past the limit are not lost",
    async () => {
        const total = 50;
        await withServer(
            (socket) => {
                const lines = Array.from(
                    { length: total },
                    (_unused, index) => JSON.stringify({ n: index }),
                ).join("\n") + "\n";
                socket.write(lines);
            },
            async (socketPath) => {
                const connection = await connectHost({
                    socketPath,
                    maxPendingValues: 4,
                });
                try {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    for (let n = 0; n < total; n += 1) {
                        expect(await connection.receive()).toEqual({ n });
                    }
                } finally {
                    connection.close();
                }
            },
        );
    },
);

skipIfNoNetwork(
    "stops parsing the current chunk when the pending-value limit is full",
    async () => {
        await withServer(
            (socket) => socket.write('{"n":1}\n{"n":2}\nnot json\n'),
            async (socketPath) => {
                const connection = await connectHost({
                    socketPath,
                    maxPendingValues: 2,
                });
                await new Promise((resolve) => setTimeout(resolve, 50));
                expect(connection.closed).toBe(false);

                expect(await connection.receive()).toEqual({ n: 1 });
                expect(connection.closed).toBe(true);
                await expect(connection.receive()).rejects.toThrow(
                    /malformed/,
                );
            },
        );
    },
);

skipIfNoNetwork(
    "serializes concurrent sends in call order",
    async () => {
        const received: number[] = [];
        let resolveReceived!: () => void;
        const allReceived = new Promise<void>((resolve) => {
            resolveReceived = resolve;
        });
        await withServer(
            (socket) => {
                socket.setEncoding("utf8");
                let buffered = "";
                socket.on("data", (chunk: string) => {
                    buffered += chunk;
                    let newline = buffered.indexOf("\n");
                    while (newline !== -1) {
                        const value = JSON.parse(
                            buffered.slice(0, newline),
                        ) as { n: number };
                        received.push(value.n);
                        buffered = buffered.slice(newline + 1);
                        newline = buffered.indexOf("\n");
                    }
                    if (received.length === 50) {
                        resolveReceived();
                    }
                });
            },
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                try {
                    const sends = Array.from(
                        { length: 50 },
                        (_unused, n) => connection.send({ n }),
                    );
                    await Promise.all(sends);
                    await allReceived;
                    expect(received).toEqual(Array.from(
                        { length: 50 },
                        (_unused, n) => n,
                    ));
                } finally {
                    connection.close();
                }
            },
        );
    },
);

skipIfNoNetwork(
    "send rejects a pending write when the connection closes",
    async () => {
        await withServer(
            (socket) => socket.pause(),
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                const payload = { s: "a".repeat(64 * 1_024) };
                const sends = Array.from(
                    { length: 200 },
                    () => connection.send(payload),
                );
                connection.close();
                const settled = await Promise.allSettled(sends);
                expect(settled.some((result) => result.status === "rejected"))
                    .toBe(true);
            },
        );
    },
);

skipIfNoNetwork(
    "propagates connection close to pending receivers",
    async () => {
        await withServer(
            (socket) => socket.end(),
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                await expect(connection.receive()).rejects.toThrow(
                    "host connection closed",
                );
                expect(connection.closed).toBe(true);
                expect(isExpectedHostClose(await connection.closedReason()))
                    .toBe(false);
            },
        );
    },
);

skipIfNoNetwork(
    "an expected peer close after a completed exchange is not a loss",
    async () => {
        await withServer(
            (socket) => {
                socket.setEncoding("utf8");
                socket.on("data", () => {
                    socket.end(`${JSON.stringify({ type: "done" })}\n`);
                });
            },
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                connection.expectPeerClose();
                await connection.send({ type: "ask" });
                expect(await connection.receive()).toEqual({ type: "done" });
                expect(isExpectedHostClose(await connection.closedReason()))
                    .toBe(true);
            },
        );
    },
);

skipIfNoNetwork(
    "an expected peer destroy after a completed exchange is not a loss",
    async () => {
        await withServer(
            (socket) => {
                socket.setEncoding("utf8");
                socket.on("data", () => {
                    socket.write(`${JSON.stringify({ type: "done" })}\n`);
                    socket.destroy();
                });
            },
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                connection.expectPeerClose();
                await connection.send({ type: "ask" });
                expect(await connection.receive()).toEqual({ type: "done" });
                expect(isExpectedHostClose(await connection.closedReason()))
                    .toBe(true);
            },
        );
    },
);

skipIfNoNetwork(
    "expectPeerClose does not hide a close before the reply arrives",
    async () => {
        await withServer(
            (socket) => socket.end(),
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                connection.expectPeerClose();
                await expect(connection.receive()).rejects.toThrow(
                    "host connection closed",
                );
                expect(isExpectedHostClose(await connection.closedReason()))
                    .toBe(false);
            },
        );
    },
);

skipIfNoNetwork(
    "a graceful peer close leaves its final value readable",
    async () => {
        await withServer(
            (socket) => socket.end('{"type":"done"}\n'),
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                await new Promise((resolve) => setTimeout(resolve, 50));
                expect(await connection.receive()).toEqual({ type: "done" });
                await expect(connection.receive()).rejects.toThrow(
                    "host connection closed",
                );
                expect(isExpectedHostClose(await connection.closedReason()))
                    .toBe(false);
            },
        );
    },
);

skipIfNoNetwork(
    "an established connection outlives its connection deadline",
    async () => {
        await withServer(
            () => {},
            async (socketPath) => {
                const connection = await connectHost({
                    socketPath,
                    connectionTimeoutMs: 25,
                });
                await new Promise((resolve) => setTimeout(resolve, 75));
                expect(connection.closed).toBe(false);
                connection.close();
            },
        );
    },
);

skipIfNoNetwork("close is idempotent and rejects late receives", async () => {
    await withServer(
        () => {},
        async (socketPath) => {
            const connection: HostConnection = await connectHost({
                socketPath,
            });
            connection.close();
            connection.close();
            expect(connection.closed).toBe(true);
            await expect(connection.send({ n: 1 })).rejects.toThrow();
            await expect(connection.receive()).rejects.toThrow();
        },
    );
});

skipIfNoNetwork(
    "close rejects a receive() that was already pending",
    async () => {
        await withServer(
            () => {},
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                const pending = connection.receive();
                connection.close();
                await expect(pending).rejects.toThrow();
            },
        );
    },
);

skipIfNoNetwork(
    "close discards values queued but not yet read",
    async () => {
        await withServer(
            (socket) => socket.write('{"n":1}\n'),
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                await new Promise((resolve) => setTimeout(resolve, 50));
                connection.close();
                await expect(connection.receive()).rejects.toThrow();
            },
        );
    },
);

skipIfNoNetwork(
    "send rejects values that JSON.stringify cannot encode",
    async () => {
        await withServer(
            () => {},
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                try {
                    await expect(connection.send(undefined)).rejects.toThrow();
                    await expect(connection.send(1n)).rejects.toThrow();
                } finally {
                    connection.close();
                }
            },
        );
    },
);

test("connection limits must be positive integers", () => {
    expect(() => connectHost({
        socketPath: "/unused",
        maxLineBytes: 0,
    })).toThrow(/maximum line bytes/);
    expect(() => connectHost({
        socketPath: "/unused",
        maxPendingValues: 1.5,
    })).toThrow(/maximum pending values/);
});

test("an already-cancelled host connection does not start", () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    expect(() => connectHost({
        socketPath: "/unused",
        signal: controller.signal,
    })).toThrow("cancelled");
});

skipIfNoNetwork(
    "queues values received before receive() is called",
    async () => {
        await withServer(
            (socket) => socket.write('{"n":1}\n{"n":2}\n'),
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                try {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    expect(await connection.receive()).toEqual({ n: 1 });
                    expect(await connection.receive()).toEqual({ n: 2 });
                } finally {
                    connection.close();
                }
            },
        );
    },
);

skipIfNoNetwork(
    "round-trips a frame the size of a full 1M-token transcript",
    async () => {
        const transcript = "x".repeat(12 * 1_024 * 1_024);
        await withServer(
            (socket) => {
                let received = "";
                socket.on("data", (chunk: Buffer) => {
                    received += chunk.toString("utf8");
                    if (received.endsWith("\n")) socket.write(received);
                });
            },
            async (socketPath) => {
                const connection = await connectHost({ socketPath });
                try {
                    await connection.send({ transcript });
                    expect(await connection.receive()).toEqual({ transcript });
                } finally {
                    connection.close();
                }
            },
        );
    },
);

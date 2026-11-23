import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { PassThrough, Readable } from "node:stream";

import { createJsonPipe } from "../../src/host/worker/pipe.ts";

function firstResponse(output: PassThrough): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        let buffered = "";
        output.setEncoding("utf8");
        output.on("data", (chunk: string) => {
            buffered += chunk;
            const newline = buffered.indexOf("\n");
            if (newline !== -1) {
                resolve(
                    JSON.parse(buffered.slice(0, newline)) as Record<
                        string,
                        unknown
                    >,
                );
            }
        });
    });
}

test("decodes a request split across chunks, including a split character", async () => {
    const frame = Buffer.from(
        `${JSON.stringify({ id: 1, body: { text: "héllo wörld" } })}\n`,
    );
    const splitAt = frame.indexOf(Buffer.from("é"));
    const input = Readable.from([
        frame.subarray(0, splitAt + 1),
        frame.subarray(splitAt + 1),
    ]);
    const output = new PassThrough();
    createJsonPipe(
        { input, output },
        { onRequest: async (body) => body },
    );
    expect(await firstResponse(output)).toEqual({
        id: 1,
        ok: { text: "héllo wörld" },
    });
});

test("delivers several notification frames from one chunk", async () => {
    const received: unknown[] = [];
    const frames = Buffer.from(
        [
            JSON.stringify({ body: { n: 1 } }),
            JSON.stringify({ body: { n: 2 } }),
            "",
        ].join("\n"),
    );
    const input = Readable.from([frames]);
    const output = new PassThrough();
    createJsonPipe(
        { input, output },
        { onNotification: (body) => received.push(body) },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
});

test("@core a cancelled worker request releases its listener and ignores a late response", async () => {
    const leftInput = new PassThrough();
    const rightInput = new PassThrough();
    let release!: () => void;
    let started!: () => void;
    const delay = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const left = createJsonPipe({ input: leftInput, output: rightInput });
    const right = createJsonPipe({ input: rightInput, output: leftInput }, {
        onRequest: async (body) => {
            if (body === "slow") {
                started();
                await delay;
            }
            return body;
        },
    });
    try {
        const controller = new AbortController();
        const request = left.request("slow", controller.signal);
        await entered;
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
        controller.abort(new Error("deadline exceeded"));
        await expect(request).rejects.toThrow("deadline exceeded");
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        release();
        await expect(left.request("next", AbortSignal.timeout(1_000))).resolves.toBe("next");
    } finally {
        release();
        left.close();
        right.close();
    }
});

test("@core worker requests reject when output fails", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pipe = createJsonPipe({ input, output });
    const pending = pipe.request("pending");
    output.destroy(new Error("Output lost"));
    await expect(pending).rejects.toThrow("Output lost");
    await pipe.closed;
    expect(() => pipe.notify("late")).not.toThrow();
    input.destroy();
});

test("worker requests reject on close and do not accept new work", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pipe = createJsonPipe({ input, output });
    const controller = new AbortController();
    const pending = pipe.request("pending", controller.signal);
    pipe.close();
    await expect(pending).rejects.toThrow("The worker pipe closed");
    await pipe.closed;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await expect(pipe.request("after close")).rejects.toThrow("The worker pipe closed");
    input.destroy();
    output.destroy();
});

test("worker requests reject an already aborted signal and release failed writes", async () => {
    const leftInput = new PassThrough();
    const rightInput = new PassThrough();
    const calls: unknown[] = [];
    const left = createJsonPipe({ input: leftInput, output: rightInput });
    const right = createJsonPipe({ input: rightInput, output: leftInput }, {
        onRequest: async (body) => {
            calls.push(body);
            return body;
        },
    });
    try {
        const aborted = AbortSignal.abort(new Error("already stopped"));
        await expect(left.request("not sent", aborted)).rejects.toThrow("already stopped");
        const controller = new AbortController();
        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        await expect(left.request(cyclic, controller.signal)).rejects.toThrow();
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        await expect(left.request("sent", controller.signal)).resolves.toBe("sent");
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        expect(calls).toEqual(["sent"]);
    } finally {
        left.close();
        right.close();
    }
});

import { expect, test } from "bun:test";
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

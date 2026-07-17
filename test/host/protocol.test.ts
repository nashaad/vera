import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
    encodeHostResponse,
    parseHostRequest,
    requestHostIdentity,
} from "../../src/host/protocol.ts";

test("host protocol parses identity requests and encodes responses", () => {
    expect(parseHostRequest('{"type":"host_identity"}')).toEqual({
        type: "host_identity",
    });
    expect(parseHostRequest('{"type":"unknown"}')).toBeUndefined();
    expect(parseHostRequest("not json")).toBeUndefined();
    expect(encodeHostResponse({
        type: "host_identity",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
    })).toBe(
        '{"type":"host_identity","pid":101,'
        + '"started_at":"2026-07-17T12:00:00.000Z"}\n',
    );
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "identity request finishes when a peer closes without a response",
    async () => {
        const directory = mkdtempSync(join("/private/tmp", "vera-protocol-"));
        const socketPath = join(directory, "host.sock");
        const server = createServer((socket) => socket.end());
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(socketPath, resolve);
            });
            expect(await requestHostIdentity(socketPath)).toBeUndefined();
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined
                    ? resolve()
                    : reject(error));
            });
            rmSync(directory, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "identity request has a fixed deadline while a peer drips bytes",
    async () => {
        const directory = mkdtempSync(join("/private/tmp", "vera-protocol-"));
        const socketPath = join(directory, "host.sock");
        const server = createServer((socket) => {
            const drip = setInterval(() => socket.write(" "), 50);
            socket.once("close", () => clearInterval(drip));
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(socketPath, resolve);
            });
            const startedAt = Date.now();
            expect(await requestHostIdentity(socketPath)).toBeUndefined();
            expect(Date.now() - startedAt).toBeLessThan(750);
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined
                    ? resolve()
                    : reject(error));
            });
            rmSync(directory, { recursive: true, force: true });
        }
    },
);

import { expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readUsageWebUrlThroughHost } from "../../src/host/usage-web-client.ts";

const skipIfNoNetwork = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

async function withServer(
    onSocket: (socket: Socket) => void,
    run: (socketPath: string) => Promise<void>,
): Promise<void> {
    const directory = mkdtempSync(join("/private/tmp", "vera-usage-web-"));
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
    "a completed usage reply close is not an unhandled rejection",
    async () => {
        const rejections: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            rejections.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            await withServer(
                (socket) => {
                    socket.setEncoding("utf8");
                    socket.on("data", () => {
                        socket.end(`${JSON.stringify({
                            type: "usage_web",
                            url: "http://127.0.0.1:9/",
                        })}\n`);
                    });
                },
                async (socketPath) => {
                    const url = await readUsageWebUrlThroughHost(socketPath);
                    expect(url).toBe("http://127.0.0.1:9/");
                    await new Promise((resolve) => setTimeout(resolve, 50));
                },
            );
            expect(rejections).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    },
);

skipIfNoNetwork(
    "a usage helper still fails when the host drops before the reply",
    async () => {
        await withServer(
            (socket) => socket.end(),
            async (socketPath) => {
                await expect(readUsageWebUrlThroughHost(socketPath))
                    .rejects.toThrow("host connection closed");
            },
        );
    },
);

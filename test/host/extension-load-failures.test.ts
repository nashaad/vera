import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readExtensionLoadFailuresThroughHost } from "../../src/host/extension-load-failures-client.ts";
import { parseHostRequest } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const networkTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

test("extension_load_failures parses as a host request", () => {
    expect(parseHostRequest('{"type":"extension_load_failures"}')).toEqual({
        type: "extension_load_failures",
    });
});

networkTest("a real host reports the extensions it could not load", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-extension-load-failures-"));
    const extension = join(root, "crow-fetch");
    await mkdir(extension);
    await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
        id: "crow.fetch",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: ["tools.register"],
    }));
    await writeFile(join(extension, "extension.ts"), `
        export function activate(vera) {
            vera.tools.register({
                name: "shanty_fetch",
                description: "Fetch a shanty",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                permissionOperation: "web.fetch",
                run() { return { output: "yo ho" }; },
            });
        }
    `);
    const host = await startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
            extensions: [{ path: extension, enabled: true, config: null }],
        },
        createAdapter: () => new FauxAdapter([]),
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
    });
    try {
        expect(await readExtensionLoadFailuresThroughHost(host.server.socketPath)).toEqual([{
            extensionId: "crow.fetch",
            message: "Extension crow.fetch failed to load: Extension tool shanty_fetch declares reserved operation web.fetch",
        }]);
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

networkTest("a host without the request reports no failures", async () => {
    const root = await mkdtemp(join("/private/tmp", "vera-old-host-"));
    const socketPath = join(root, "host.sock");
    const server: Server = createServer((socket) => {
        socket.on("data", () => {
            socket.end(`${JSON.stringify({
                type: "protocol_error",
                reason: "unsupported_or_invalid_command",
            })}\n`);
        });
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        expect(await readExtensionLoadFailuresThroughHost(socketPath)).toEqual([]);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
});

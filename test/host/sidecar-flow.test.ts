import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FauxAdapter } from "../support/faux-adapter.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

const canBind = process.env.CODEX_SANDBOX_NETWORK_DISABLED !== "1";
const hostTest = canBind ? test : test.skip;

async function writeSidecarExtension(root: string): Promise<string> {
    const directory = join(root, "extensions", "acme.echo");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "extension.ts"), "export function activate() {}\n");
    await writeFile(join(directory, "worker.sh"), "#!/bin/sh\necho \"$VERA_SOCKET\" > \"$OUT_FILE\"\nsleep 60\n");
    await writeFile(
        join(directory, "vera.extension.json"),
        JSON.stringify({
            id: "acme.echo",
            version: "1.0.0",
            sdk: "1",
            entrypoint: "./extension.ts",
            capabilities: [],
            contributes: {
                sidecars: [
                    {
                        id: "echo",
                        command: ["sh", "worker.sh"],
                        env: { OUT_FILE: join(root, "sidecar-out") },
                    },
                ],
            },
        }),
    );
    return directory;
}

hostTest("a contributed sidecar lives and dies with the resident host", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vera-sidecar-host-")));
    try {
        const extensionDirectory = await writeSidecarExtension(root);
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
                extensions: [{ path: extensionDirectory, enabled: true, config: {} }],
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
            sidecarLogDirectory: join(root, "sidecar-logs"),
        });
        try {
            const outFile = join(root, "sidecar-out");
            const deadline = Date.now() + 5_000;
            let socketSeen = "";
            while (socketSeen === "") {
                if (Date.now() > deadline) {
                    throw new Error("sidecar never reported its socket");
                }
                socketSeen = await readFile(outFile, "utf8").then(
                    (text) => text.trim(),
                    () => "",
                );
                await Bun.sleep(20);
            }
            expect(socketSeen).toBe(join(root, "host.sock"));
        } finally {
            await host.close();
        }
        // The child was killed by the close, so a fresh marker never appears.
        await rm(join(root, "sidecar-out"), { force: true });
        await Bun.sleep(200);
        const after = await readFile(join(root, "sidecar-out"), "utf8")
            .catch(() => null);
        expect(after).toBeNull();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}, 15_000);

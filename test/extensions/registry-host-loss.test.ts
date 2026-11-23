import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startExtensionRegistry } from "../../src/extensions/registry.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for extension state");
        await Bun.sleep(10);
    }
}

test("@core host loss defers a timed-out MCP disposer until activation settles", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-extension-host-loss-"));
    const started = join(home, "started");
    const release = join(home, "release");
    const disposed = join(home, "disposed");
    writeFileSync(join(home, "vera.extension.json"), JSON.stringify({
        id: "vera.mcp", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
        capabilities: ["commands.register"], contributes: {},
    }));
    writeFileSync(join(home, "extension.ts"), `
        import { existsSync, writeFileSync } from "node:fs";
        export async function activate(api) {
            api.onDispose(() => writeFileSync(${JSON.stringify(disposed)}, "disposed"));
            writeFileSync(${JSON.stringify(started)}, "started");
            while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
        }
    `);
    let closeOnHostLoss = async (): Promise<void> => { throw new Error("Close not ready"); };
    let hasPendingActivation = (): boolean => false;
    const failures: string[] = [];
    const starting = startExtensionRegistry({
        extensions: [{ path: home, enabled: true, config: {} }],
        activationTimeoutMs: 1_000,
        storageRoots: { profile: home, machine: join(home, "machine") },
        onFailure(failure) { failures.push(failure.message); },
        onHostLossCloseReady(close, pending) {
            closeOnHostLoss = close;
            hasPendingActivation = pending;
        },
    });
    try {
        await waitFor(() => existsSync(started) || failures.length > 0);
        expect(failures).toEqual([]);
        expect(hasPendingActivation()).toBe(true);
        await closeOnHostLoss();
        const registry = await starting;
        expect(existsSync(disposed)).toBe(false);
        expect(hasPendingActivation()).toBe(true);
        writeFileSync(release, "release");
        await waitFor(() => existsSync(disposed));
        expect(hasPendingActivation()).toBe(false);
        await registry.close();
    } finally {
        writeFileSync(release, "release");
        const registry = await starting.catch(() => undefined);
        await registry?.close().catch(() => undefined);
        if (existsSync(started)) await waitFor(() => existsSync(disposed)).catch(() => undefined);
        rmSync(home, { recursive: true, force: true });
    }
}, 5_000);

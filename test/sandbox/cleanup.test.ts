import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxConfig } from "../../src/config/sandbox.ts";
import { SandboxManager } from "../../src/sandbox/manager.ts";

const mac = process.platform === "darwin";
const enabled: SandboxConfig = {
    enabled: true,
    network: "open",
    allowed_domains: [],
};
const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-sandbox-cleanup-"));
    directories.push(directory);
    return directory;
}

test("@core srt's per-command cleanup runs once for each wrap", async () => {
    if (!mac) return;
    const root = workspace();
    let cleanups = 0;
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: () => {},
        monitorTimeoutMs: 100,
        cleanupAfterCommand: () => {
            cleanups += 1;
        },
    });
    try {
        const first = (await sandbox.prepare({
            command: "echo one",
            cwd: root,
            env: {},
            workspace: root,
            sessionId: "session-cleanup",
            toolCallId: "call-one",
        })).prepared!;
        const second = (await sandbox.prepare({
            command: "echo two",
            cwd: root,
            env: {},
            workspace: root,
            sessionId: "session-cleanup",
            toolCallId: "call-two",
        })).prepared!;
        expect(cleanups).toBe(0);

        sandbox.commandEnded(first);
        expect(cleanups).toBe(1);
        // The same wrap is not released twice, and a live wrap is untouched.
        sandbox.commandEnded(first);
        expect(cleanups).toBe(1);

        sandbox.commandEnded(second);
        expect(cleanups).toBe(2);
    } finally {
        await sandbox.dispose();
    }
});

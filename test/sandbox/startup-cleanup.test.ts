import { expect, spyOn, test } from "bun:test";
import { SandboxManager as Srt } from "@anthropic-ai/sandbox-runtime";

import { SandboxManager } from "../../src/sandbox/manager.ts";

for (const phase of ["initializing", "handshake"] as const) {
    test(`@core sandbox disposal cancels the ${phase} phase`, async () => {
        let enter = (): void => {};
        let resume = (): void => {};
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const gate = new Promise<void>((resolve) => { resume = resolve; });
        const supported = spyOn(Srt, "isSupportedPlatform").mockReturnValue(true);
        const initialize = spyOn(Srt, "initialize").mockImplementation(async () => {
            if (phase !== "initializing") return;
            enter();
            await gate;
            throw new Error("initialization cancelled");
        });
        const wrap = spyOn(Srt, "wrapWithSandboxArgv").mockImplementation(async () => {
            enter();
            await gate;
            throw new Error("handshake cancelled");
        });
        const reset = spyOn(Srt, "reset").mockImplementation(async () => {});
        const sandbox = new SandboxManager({
            config: () => ({ enabled: true, network: "open", allowed_domains: [] }),
            permissionRules: () => [],
            log: () => {},
            platform: "darwin",
            readDependencies: () => ({ ok: true, errors: [], warnings: [] }),
        });
        const preparing = sandbox.prepare({
            command: "printf done",
            cwd: process.cwd(),
            env: {},
            workspace: process.cwd(),
            sessionId: "startup",
            toolCallId: "startup",
        });
        try {
            await entered;
            await sandbox.dispose();
            expect(reset).toHaveBeenCalledTimes(1);
            resume();
            await preparing;
            expect(wrap).toHaveBeenCalledTimes(phase === "handshake" ? 1 : 0);
        } finally {
            resume();
            await preparing;
            reset.mockRestore();
            wrap.mockRestore();
            initialize.mockRestore();
            supported.mockRestore();
        }
    });
}

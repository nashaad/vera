import { expect, test } from "bun:test";

import { processTool } from "../../src/tools/process.ts";
import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

test("an old process id reports unknown instead of pretending it survived", async () => {
    const runtime = new ToolRuntime(process.cwd());
    try {
        const result = await processTool.execute({
            action: "read",
            process_id: "p-from-old-host",
        }, runtime, new AbortController().signal);
        expect(result).toEqual({
            kind: "output",
            output:
                "Process p-from-old-host is unknown. It may already have been read, "
                + "or the host may have restarted.",
            isError: true,
        });
    } finally {
        await runtime.close();
    }
});

test("kill reports an unconfirmed termination as an error", async () => {
    const registry = new ManagedProcessRegistry({
        stopWaitMs: 30,
        signalProcessTree: () => "simulated signal failure",
    });
    const scope = registry.scope("session-a");
    const runtime = new ToolRuntime(
        process.cwd(),
        undefined,
        undefined,
        undefined,
        undefined,
        scope,
    );
    let pid: number | undefined;
    try {
        const started = await scope.run({
            command: "sleep 60",
            cwd: process.cwd(),
            env: process.env,
            yieldAfterMs: 0,
            interactive: false,
        });
        expect(started.kind).toBe("running");
        if (started.kind !== "running") throw new Error("expected process id");
        pid = started.snapshot.pid;

        const result = await processTool.execute({
            action: "kill",
            process_id: started.snapshot.processId,
        }, runtime, new AbortController().signal);
        expect(result).toMatchObject({
            kind: "output",
            isError: true,
            processId: started.snapshot.processId,
        });
        if (result.kind !== "output") throw new Error("expected tool output");
        expect(result.output).toContain("could not be confirmed terminated");
        expect(result.output).toContain("simulated signal failure");
    } finally {
        if (pid !== undefined) {
            try {
                process.kill(-pid, "SIGKILL");
            } catch {
                // It may already be gone.
            }
        }
        await runtime.close();
        await registry.close();
    }
});

import { expect, test } from "bun:test";

import { signalVerifiedProcess, signalVerifiedProcessGroup } from "../../src/process-group.ts";
import { processTool } from "../../src/tools/process.ts";
import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

test("an unavailable process id is reported without a guessed cause", async () => {
    const runtime = new ToolRuntime(process.cwd());
    try {
        for (const action of ["read", "kill"]) {
            const result = await processTool.execute({
                action,
                process_id: "p-unavailable",
            }, runtime, new AbortController().signal);
            expect(result).toEqual({
                kind: "output",
                output: "Process p-unavailable is not available in this conversation.",
                isError: true,
            });
        }
    } finally {
        await runtime.close();
    }
});

test("@core a repeated process read returns the same failed command result", async () => {
    const runtime = new ToolRuntime(process.cwd());
    const signal = new AbortController().signal;
    try {
        const started = await runtime.processes.run({
            command: "printf crow; exit 7",
            cwd: process.cwd(),
            env: process.env,
            yieldAfterMs: 0,
            interactive: false,
        });
        expect(started.kind).toBe("running");
        if (started.kind !== "running") throw new Error("expected process id");
        const input = { action: "read", process_id: started.snapshot.processId };
        const deadline = Date.now() + 2_000;
        let first = await processTool.execute(input, runtime, signal);
        while (first.kind === "output" && first.output.includes("is still running")) {
            if (Date.now() > deadline) throw new Error("process did not exit in time");
            await Bun.sleep(10);
            first = await processTool.execute(input, runtime, signal);
        }
        expect(first).toMatchObject({
            kind: "output",
            isError: true,
            processId: started.snapshot.processId,
        });
        if (first.kind !== "output") throw new Error("expected process output");
        expect(first.output).toContain("exited with code 7");
        expect(first.output).toContain("crow");
        expect(await processTool.execute(input, runtime, signal)).toEqual(first);
    } finally {
        await runtime.close();
    }
});

test("@core an expired process result reports unavailable through the tool", async () => {
    let now = 1_000;
    const registry = new ManagedProcessRegistry({
        id: () => "p-expired",
        now: () => now,
        exitRetentionMs: 1_000,
    });
    const scope = registry.scope("session");
    const runtime = new ToolRuntime(process.cwd(), undefined, undefined, undefined, undefined, scope);
    const signal = new AbortController().signal;
    try {
        const started = await scope.run({
            command: "printf crow",
            cwd: process.cwd(),
            env: process.env,
            yieldAfterMs: 0,
            interactive: false,
        });
        expect(started.kind).toBe("running");
        if (started.kind !== "running") throw new Error("expected process id");
        const input = { action: "read", process_id: started.snapshot.processId };
        const deadline = Date.now() + 2_000;
        let first = await processTool.execute(input, runtime, signal);
        while (first.kind === "output" && first.output.includes("is still running")) {
            if (Date.now() > deadline) throw new Error("process did not exit in time");
            await Bun.sleep(10);
            first = await processTool.execute(input, runtime, signal);
        }
        expect(first.kind).toBe("output");
        if (first.kind !== "output") throw new Error("expected process output");
        expect(first.output).toContain("exited with code 0");
        now = 2_000;
        expect(await processTool.execute(input, runtime, signal)).toEqual({
            kind: "output",
            output: "Process p-expired is not available in this conversation.",
            isError: true,
        });
    } finally {
        await runtime.close();
        await registry.close();
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
    const startedAt = new Date().toISOString();
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
            const record = { pid, started_at: startedAt };
            if (signalVerifiedProcessGroup(record, "SIGKILL") !== "sent") signalVerifiedProcess(record, "SIGKILL");
        }
        await runtime.close();
        await registry.close();
    }
});

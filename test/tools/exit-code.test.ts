import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeToolCall } from "../../src/tools/execute.ts";
import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

function call(name: string, input: Record<string, unknown>) {
    return { type: "tool_call" as const, id: "call-1", name, input };
}

test.each([0, 2])("@core bash records observed exit %i in the engine result", async (code) => {
    const runtime = new ToolRuntime(process.cwd());
    try {
        const result = await executeToolCall(call("bash", { command: `exit ${code}` }), runtime);
        expect(result).toMatchObject({
            role: "tool_result",
            isError: code !== 0,
            exitCode: code,
            content: [{ type: "text", text: "(no output)" }],
        });
    } finally {
        await runtime.close();
    }
});

test.each([0, 2])("@core process reads a background exit %i in the engine result", async (code) => {
    const runtime = new ToolRuntime(process.cwd());
    try {
        const started = await executeToolCall(call("bash", {
            command: `exit ${code}`,
            yield_after: 0,
        }), runtime);
        expect(started.processId).toBeString();
        expect(started).not.toHaveProperty("exitCode");
        const deadline = Date.now() + 3_000;
        let result = await executeToolCall(call("process", {
            action: "read",
            process_id: started.processId,
        }), runtime);
        while (result.exitCode === undefined && Date.now() < deadline) {
            await Bun.sleep(10);
            result = await executeToolCall(call("process", {
                action: "read",
                process_id: started.processId,
            }), runtime);
        }
        expect(result).toMatchObject({
            role: "tool_result",
            isError: code !== 0,
            exitCode: code,
            processId: started.processId,
        });
        expect(result.content[0]?.text).toContain(`exited with code ${code}`);
        expect(await executeToolCall(call("process", {
            action: "read",
            process_id: started.processId,
        }), runtime)).toEqual(result);
    } finally {
        await runtime.close();
    }
});

test("@core a bash execution timeout remains an error without an exit fact", async () => {
    const runtime = new ToolRuntime(process.cwd());
    try {
        const result = await executeToolCall(
            call("bash", { command: "sleep 5" }),
            runtime,
            AbortSignal.timeout(50),
        );
        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty("exitCode");
    } finally {
        await runtime.close();
    }
});

test("@core spawn failures and unknown processes have no exit fact", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-exit-test-"));
    const runtime = new ToolRuntime(join(root, "missing"));
    try {
        const failed = await executeToolCall(call("bash", { command: "exit 2" }), runtime);
        expect(failed.isError).toBe(true);
        expect(failed).not.toHaveProperty("exitCode");
        const unknown = await executeToolCall(call("process", {
            action: "read",
            process_id: "p-unknown",
        }), runtime);
        expect(unknown.isError).toBe(true);
        expect(unknown).not.toHaveProperty("exitCode");
        const timedOut = await executeToolCall(call("process", {
            action: "read",
            process_id: "p-unknown",
        }), runtime, AbortSignal.abort(new Error("timed out")));
        expect(timedOut.isError).toBe(true);
        expect(timedOut).not.toHaveProperty("exitCode");
    } finally {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core synthetic exit codes and unconfirmed termination remain errors", async () => {
    const registry = new ManagedProcessRegistry();
    const scope = registry.scope("exit-test");
    const snapshot = {
        processId: "p-synthetic",
        command: "example",
        pid: 123,
        status: "exited" as const,
        elapsedMs: 10,
        output: "could not observe shell exit",
        exitCode: 1,
        exitObservationFailed: true,
    };
    scope.run = async () => ({ kind: "exited", snapshot });
    scope.readSettled = async () => snapshot;
    scope.kill = async () => ({
        ...snapshot,
        status: "running" as const,
        terminationError: "termination not confirmed",
    });
    const runtime = new ToolRuntime(process.cwd(), undefined, undefined, undefined, undefined, scope);
    try {
        for (const input of [
            call("bash", { command: "example" }),
            call("process", { action: "read", process_id: "p-synthetic" }),
            call("process", { action: "kill", process_id: "p-synthetic" }),
        ]) {
            const result = await executeToolCall(input, runtime);
            expect(result.isError).toBe(true);
            expect(result).not.toHaveProperty("exitCode");
        }
    } finally {
        await runtime.close();
        await registry.close();
    }
});

test("a confirmed process kill records its observed exit", async () => {
    const registry = new ManagedProcessRegistry();
    const scope = registry.scope("exit-test");
    scope.kill = async () => ({
        processId: "p-killed",
        command: "example",
        pid: 123,
        status: "exited",
        elapsedMs: 10,
        output: "(no output)",
        exitCode: 137,
    });
    const runtime = new ToolRuntime(process.cwd(), undefined, undefined, undefined, undefined, scope);
    try {
        const result = await executeToolCall(call("process", {
            action: "kill",
            process_id: "p-killed",
        }), runtime);
        expect(result).toMatchObject({ isError: false, exitCode: 137 });
    } finally {
        await runtime.close();
        await registry.close();
    }
});

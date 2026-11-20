import { expect, spyOn, test } from "bun:test";

import { executeToolCall } from "../../src/tools/execute.ts";
import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

test("@core a rejected exit observation keeps the synthetic code out of the engine result", async () => {
    const stream = () => new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); },
    });
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
        pid: 123456789,
        stdout: stream(),
        stderr: stream(),
        exited: Promise.reject(new Error("observation unavailable")),
    } as never);
    const registry = new ManagedProcessRegistry({ processGroupAlive: () => false });
    const scope = registry.scope("observation-test");
    const runtime = new ToolRuntime(process.cwd(), undefined, undefined, undefined, undefined, scope);
    try {
        const result = await executeToolCall({
            type: "tool_call",
            id: "call-1",
            name: "bash",
            input: { command: "example" },
        }, runtime);
        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty("exitCode");
        expect(result.content[0]?.text).toContain("could not observe shell exit: observation unavailable");
    } finally {
        await runtime.close();
        await registry.close();
        spawn.mockRestore();
    }
});

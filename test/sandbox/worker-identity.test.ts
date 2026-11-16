import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { createWorkerBoundaryServer } from "../../src/host/worker/boundary-server.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { skillScriptTool } from "../../src/skills/script.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("@core a worker skill script keeps the call's sandbox identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-worker-sandbox-id-"));
    directories.push(directory);
    const store = await SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "worker-id",
        cwd: directory,
    });
    const toWorker = new PassThrough();
    const toHost = new PassThrough();
    const seen: ToolRuntime[] = [];
    const tool: RegisteredTool = {
        definition: { ...skillScriptTool.definition },
        execute(_input, context) {
            seen.push(context);
            return Promise.resolve({ kind: "output", output: "ok", isError: false });
        },
    };
    const runtime = new ToolRuntime(directory);
    runtime.sessionId = "worker-id";
    runtime.currentToolCallId = "call-42";
    runtime.readApprovalMode = () => "auto";
    const server = createWorkerBoundaryServer({
        pipe: createJsonPipe(
            { input: toHost, output: toWorker },
            {
                onRequest: (body) => server.handleRequest(body),
                onNotification: (body) => server.handleNotification(body),
            },
        ),
        store,
        services: {},
        extensionTools: [tool],
        toolRuntime: runtime,
    });

    await server.handleRequest({
        method: "tool.execute",
        callId: "call-42",
        name: skillScriptTool.definition.name,
        input: {},
    });

    expect(seen).toHaveLength(1);
    const context = seen[0] as ToolRuntime;
    expect(context).not.toBe(runtime);
    expect(context.sessionId).toBe("worker-id");
    expect(context.currentToolCallId).toBe("call-42");
    expect(context.readApprovalMode?.()).toBe("auto");
    expect(context.sandboxIdentity()).toMatchObject({
        sessionId: "worker-id",
        toolCallId: "call-42",
        approvalMode: "auto",
    });
});

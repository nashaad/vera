import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { createToolResultSpill } from "../../src/engine/tool-result-spill.ts";
import {
    limitToolResult,
    TOOL_RESULT_CEILING_BYTES,
} from "../../src/tools/tool-result-limit.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { boundToolResult } from "../../src/tools/execute.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

test("a result under the ceiling passes through untouched", async () => {
    const text = "a".repeat(TOOL_RESULT_CEILING_BYTES);
    const limited = await limitToolResult(text, { toolName: "bash" });

    expect(limited.text).toBe(text);
    expect(limited.truncation).toBeUndefined();
});

test("a configured ceiling replaces the shipped one", async () => {
    // The case a small window needs: 64 KB of grep output is the whole context
    // on a 32k model, so the ceiling has to come down with the window.
    const text = `${"head".repeat(64)}${"x".repeat(20_000)}${"tail".repeat(64)}`;
    const limited = await limitToolResult(text, {
        toolName: "bash",
        ceilingBytes: 2_048,
    });

    expect(limited.truncation).toBeDefined();
    expect(limited.truncation!.retainedBytes).toBeLessThanOrEqual(2_048);
    expect(limited.text.startsWith("head")).toBe(true);
    expect(limited.text.endsWith("tail")).toBe(true);
});

test("a bound result honours the ceiling it is handed", async () => {
    const text = "z".repeat(20_000);
    const bound = await boundToolResult(
        { type: "tool_call", id: "call-ceiling", name: "bash", input: {} },
        { kind: "output", output: text, isError: false },
        undefined,
        4_096,
    );

    expect(bound.truncation).toBeDefined();
    expect(bound.truncation!.retainedBytes).toBeLessThanOrEqual(4_096);
});

test("an oversized result keeps both ends and says what it dropped", async () => {
    const text = `${"head".repeat(64)}${"x".repeat(200_000)}${"tail".repeat(64)}`;
    const limited = await limitToolResult(text, { toolName: "bash" });

    expect(limited.truncation).toMatchObject({
        originalBytes: Buffer.byteLength(text, "utf8"),
    });
    expect(limited.truncation!.retainedBytes)
        .toBeLessThanOrEqual(TOOL_RESULT_CEILING_BYTES);
    expect(limited.text.startsWith("head")).toBe(true);
    expect(limited.text.endsWith("tail")).toBe(true);
    // The marker states both numbers, so the model can tell how much of the
    // output it is reasoning about.
    expect(limited.text).toContain(`of ${limited.truncation!.originalBytes} bytes`);
    expect(limited.text).toContain(`${limited.truncation!.retainedBytes} of`);
});

test("a spilled result names the file and how to read a range from it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vera-spill-"));
    try {
        const text = "y".repeat(200_000);
        const limited = await limitToolResult(text, {
            toolName: "bash",
            spill: createToolResultSpill(scratch),
        });
        const path = limited.truncation?.spillPath;

        expect(path).toBeString();
        expect(await readFile(path as string, "utf8")).toBe(text);
        expect(limited.text).toContain(path as string);
        expect(limited.text).toContain("tail -c +<offset>");
        // Owner-only: a tool result carries whatever the session touched.
        expect((await stat(path as string)).mode & 0o777).toBe(0o600);
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
});

test("the spill quota evicts the oldest artifact first", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vera-spill-quota-"));
    try {
        const spill = createToolResultSpill(scratch, { quotaBytes: 3_000 });
        const first = await spill.write("bash", "1".repeat(1_500));
        const second = await spill.write("bash", "2".repeat(1_500));
        // Room for this one exists only once something goes.
        const third = await spill.write("bash", "3".repeat(1_500));
        const directory = join(scratch, "tool-results");
        const remaining = await readdir(directory);

        expect(remaining.map((name) => join(directory, name)).sort())
            .toEqual([second as string, third as string].sort());
        expect(remaining).not.toContain((first as string).split("/").pop());
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
});

test("an output larger than the whole quota spills nowhere", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vera-spill-huge-"));
    try {
        const spill = createToolResultSpill(scratch, { quotaBytes: 1_000 });

        expect(await spill.write("bash", "z".repeat(2_000))).toBeUndefined();
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
});

test("a medium result gets a spill pointer even when the ceiling did not cut it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vera-spill-medium-"));
    try {
        const text = "m".repeat(3_000);
        const bound = await boundToolResult(
            { type: "tool_call", id: "call-1", name: "read", input: {} },
            { kind: "output", output: text, isError: false },
            createToolResultSpill(scratch),
        );

        expect(bound.result.toolResultSource).toMatchObject({
            originalBytes: text.length,
        });
        expect(await readFile(bound.result.toolResultSource!.spillPath!, "utf8"))
            .toBe(text);
        expect(bound.result.content[0]?.text).toBe(text);
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
});

test("an oversized result does not retry a failed ceiling spill", async () => {
    let writes = 0;
    const bound = await boundToolResult(
        { type: "tool_call", id: "call-1", name: "bash", input: {} },
        { kind: "output", output: "x".repeat(200_000), isError: false },
        {
            write: async () => {
                writes += 1;
                return undefined;
            },
        },
    );

    expect(writes).toBe(1);
    expect(bound.result.toolResultSource).toBeUndefined();
});

test("an extension tool passes under the same ceiling, and the numbers are reported", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-ceiling-turn-"));
    const scratch = await mkdtemp(join(tmpdir(), "vera-ceiling-scratch-"));
    const oversized = "e".repeat(200_000);
    const extensionTool: RegisteredTool = {
        definition: {
            name: "extension_dump",
            description: "Returns more than any ceiling allows.",
            inputSchema: { type: "object", properties: {} },
        },
        execute: async () => ({
            kind: "output",
            output: oversized,
            isError: false,
        }),
    };
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_extension",
            name: "extension_dump",
            input: {},
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];
    events.subscribe((event) => observed.push(event));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "full_access",
        extensionTools: [extensionTool],
        scratchDir: scratch,
        toolResultSpill: createToolResultSpill(scratch),
    };

    try {
        channel.client.send({ type: "prompt", content: "dump it" });
        await runTurn(new FauxAdapter([toolCallResponse, finalResponse]), "test", state);

        const finished = observed.find(
            (event) => event.type === "tool_execution_finished",
        );
        expect(finished).toBeDefined();
        const truncation = finished!.type === "tool_execution_finished"
            ? finished!.truncation
            : undefined;
        expect(truncation).toMatchObject({
            originalBytes: oversized.length,
        });
        expect(truncation!.retainedBytes)
            .toBeLessThanOrEqual(TOOL_RESULT_CEILING_BYTES);
        expect(truncation!.spillPath).toBeString();

        // The message the model carries is the truncated one, not the original.
        const result = state.messages.find(
            (message) => message.role === "tool_result",
        );
        expect(result).toBeDefined();
        const carried = result!.role === "tool_result"
            ? result!.content.map((block) => block.text).join("")
            : "";
        expect(Buffer.byteLength(carried, "utf8"))
            .toBeLessThan(oversized.length);
        expect(carried).toContain("bytes omitted from the middle");

        // The second request is the one that carries the tool result.
        const requests = observed.filter(
            (event) => event.type === "model_request",
        );
        expect(requests.length).toBe(2);
        const second = requests[1];
        expect(second!.type === "model_request" && second!.toolResultBytes)
            .toBe(Buffer.byteLength(carried, "utf8"));
    } finally {
        await rm(workspace, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
    }
});

test("a scratch file the model wrote is left alone by eviction", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vera-spill-scope-"));
    try {
        await writeFile(join(scratch, "todo.md"), "keep me");
        const spill = createToolResultSpill(scratch, { quotaBytes: 100 });
        await spill.write("bash", "q".repeat(90));
        await spill.write("bash", "q".repeat(90));

        // Spill files live in their own subdirectory, so the quota never
        // reaches what the model put in the scratch directory itself.
        expect(await readFile(join(scratch, "todo.md"), "utf8")).toBe("keep me");
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
});
